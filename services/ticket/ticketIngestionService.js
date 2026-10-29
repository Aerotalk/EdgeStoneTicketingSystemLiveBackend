'use strict';

const prisma = require('../../models/index');
const TicketModel = require('../../models/ticket');
const ClientModel = require('../../models/client');
const VendorModel = require('../../models/vendor');
const logger = require('../../utils/logger');
const {
    stripHtml,
    stripQuotedReply,
    GENERIC_PUBLIC_DOMAINS,
    isEmailMatchingClientDomain,
    extractMaintenanceMetadata,
    extractTokensFromCircuitId,
    isInternalAgentEmail
} = require('./ticketSanitizer');
const { findExistingTicketForReply } = require('./ticketThreadingService');
const { appendClientReplyToTicket, appendVendorReplyToTicket, appendAgentReplyFromOutlook } = require('./ticketReplyHandler');
const { generateTicketId } = require('./ticketManagementService');
const emailSender = require('../email/emailSender');
const { isAutoReplyEnabled } = require('../../utils/emailConfig');

// Root-email detection, cutoff, classification and reply barriers live in the Smart Ticket Sorter.
const SmartSorter = require('./smartTicketSorter');
const { isRootEmail } = SmartSorter;

// Async mutex queue to serialize concurrent email ingestion and prevent race conditions
let ingestionQueue = Promise.resolve();

const withIngestionLock = (fn) => {
    const next = ingestionQueue.then(fn, fn);
    ingestionQueue = next.catch(() => {});
    return next;
};

/**
 * Ingestion and classification pipeline for incoming emails.
 * Handles threading checks, sender identification, circuit discovery,
 * temporary vs original circuit prioritization, deduplication, and ticket creation.
 */
const createTicketFromEmail = (emailData) => withIngestionLock(async () => {
    const { from, fromName, subject, body, date, messageId, inReplyTo, references } = emailData;

    logger.debug(`📝 [TICKET] 📥 Processing incoming email from: ${from} | Subject: ${subject}`);

    try {
        // --- DUPLICATE PREVENTION (Idempotency by Message-ID) ---
        if (messageId) {
            const cleanMsgId = String(messageId).replace(/[<>]/g, '').trim();
            const msgIdVariants = Array.from(new Set([messageId, `<${cleanMsgId}>`, cleanMsgId].filter(Boolean)));

            // Check if a Ticket with this incoming messageId already exists
            const duplicateTicket = await prisma.ticket.findFirst({
                where: { messageId: { in: msgIdVariants } }
            });
            if (duplicateTicket) {
                logger.warn(`🚨 [TICKET] Duplicate email detected. Ticket already exists for messageId: ${messageId}. Skipping.`);
                return duplicateTicket;
            }

            // Check if a Reply with this incoming messageId already exists
            const duplicateReply = await prisma.reply.findFirst({
                where: { messageId: { in: msgIdVariants } }
            });
            if (duplicateReply) {
                logger.warn(`🚨 [TICKET] Duplicate email detected. Reply already exists for messageId: ${messageId}. Skipping.`);
                return duplicateReply;
            }
        }

        // Check if sender is an EdgeStone internal agent
        const isAgent = await isInternalAgentEmail(from);

        // Smart Ticket Sorter: First-Time Root Email vs Thread Reply Evaluation
        // A genuine root email regarding a circuit must be treated as a fresh ticket, NEVER routed to replies!
        // Exception: Vendor incident responses whose daemon omits In-Reply-To/Re: but matches an outbound vendor escalation subject.
        const isRoot = isRootEmail(emailData);
        let existingTicket = null;

        let isVendorIncidentReplyCandidate = false;
        if (isRoot && !isAgent && from && !SmartSorter.isFormalMaintenanceNotice(subject, body) && !SmartSorter.isSlaRebateOrCommercialEmail(subject, body)) {
            try {
                const cleanSender = from.trim().toLowerCase();
                const senderDomain = cleanSender.includes('@') ? cleanSender.split('@')[1] : '';
                const allVendors = await VendorModel.findAllVendors();
                const allClients = await ClientModel.findAllClients();
                const isClientMatch = allClients.some(c =>
                    (Array.isArray(c.emails) && c.emails.some(e => e.toLowerCase() === cleanSender)) ||
                    isEmailMatchingClientDomain(cleanSender, c)
                );
                const isVendorMatch = allVendors.some(v =>
                    Array.isArray(v.emails) && v.emails.some(e =>
                        e.toLowerCase() === cleanSender ||
                        (senderDomain && !GENERIC_PUBLIC_DOMAINS.has(senderDomain) && e.toLowerCase().endsWith('@' + senderDomain))
                    )
                );
                if (isVendorMatch && !isClientMatch) {
                    isVendorIncidentReplyCandidate = true;
                }
            } catch (_) {}
        }

        if (!isRoot || isAgent || isVendorIncidentReplyCandidate) {
            existingTicket = await findExistingTicketForReply(inReplyTo, references, subject, body, from);
        } else {
            logger.info(`🎟️ [SMART SORTER] 🌟 First-time root email detected: "${subject}" from ${from}. Bypassing reply threading to ensure new ticket creation.`);
        }

        if (existingTicket) {
            if (isAgent) {
                logger.info(`🎟️ [TICKET] 👤 Routing email from EdgeStone agent (${from}) as Agent Reply into Ticket ${existingTicket.ticketId}`);
                return await appendAgentReplyFromOutlook(existingTicket, emailData);
            }

            if (existingTicket.clientId && !existingTicket.client) {
                try {
                    existingTicket.client = await prisma.client.findUnique({ where: { id: existingTicket.clientId } });
                } catch (_) {}
            }

            const isVendorTicket = existingTicket.ticketType === 'Vendor' || (existingTicket.ticketId && existingTicket.ticketId.startsWith('#V')) || existingTicket.isMaintenance;

            // Determine if the sender is a known Vendor (case-insensitive)
            const vendors = await VendorModel.findAllVendors();
            let matchedVendors = vendors.filter(v => v.emails.some(e => e.toLowerCase() === from.toLowerCase()));
            let isVendor = matchedVendors.length > 0 || isVendorTicket;
            let finalVendorId = isVendorTicket ? (existingTicket.vendorId || (matchedVendors[0]?.id || null)) : null;

            if (isVendor) {
                // Determine the best vendor match if multiple vendors share the same email
                let circuitVendors = [];
                if (existingTicket.vendorId) {
                    circuitVendors.push(existingTicket.vendorId);
                }
                
                if (existingTicket.circuitId) {
                    try {
                        const circuit = await prisma.circuit.findFirst({
                            where: { OR: [ { customerCircuitId: existingTicket.circuitId }, { supplierCircuitId: existingTicket.circuitId }, { id: existingTicket.circuitId } ] },
                            include: { vendorCircuits: true }
                        });
                        if (circuit) {
                            if (circuit.vendorId) circuitVendors.push(circuit.vendorId);
                            if (circuit.vendorCircuits && circuit.vendorCircuits.length > 0) {
                                circuitVendors.push(...circuit.vendorCircuits.map(vc => vc.vendorId).filter(id => id));
                            }
                        }
                    } catch (err) {
                        logger.error(`Error finding circuit for vendor prioritization: ${err.message}`);
                    }
                }

                if (matchedVendors.length > 0) {
                    const prioritizedVendor = matchedVendors.find(v => circuitVendors.includes(v.id));
                    finalVendorId = prioritizedVendor ? prioritizedVendor.id : (matchedVendors[0]?.id || null);
                }

                // Thread Integrity: Reply stays with the strictly matched ticket. Explicit thread reverse-matching governs ticket destination.
            }

            // If the matched parent reply was in the vendor thread, force vendor routing
            if (existingTicket._matchedReply && (existingTicket._matchedReply.category === 'vendor' || existingTicket._matchedReply.category?.startsWith('vendor_') || existingTicket._matchedReply.type === 'vendor')) {
                logger.info(`🎟️ [TICKET] 🧵 Force-routing reply into Vendor thread due to parent reply in vendor thread`);
                isVendor = true;
                if (existingTicket._matchedReply.category?.startsWith('vendor_')) {
                    finalVendorId = existingTicket._matchedReply.category.replace('vendor_', '');
                }
            } else if (existingTicket._matchedReply && (existingTicket._matchedReply.type === 'client' || (existingTicket._matchedReply.type === 'agent' && (!existingTicket._matchedReply.category || existingTicket._matchedReply.category === 'client')))) {
                logger.info(`🎟️ [TICKET] 🧵 Force-routing reply into Client thread due to parent reply in client thread`);
                isVendor = false;
                finalVendorId = null;
            }

            // Check if sender was added as a participant in previous replies of this ticket
            let previousReplies = [];
            try {
                previousReplies = await prisma.reply.findMany({
                    where: { ticketId: existingTicket.id },
                    orderBy: { createdAt: 'desc' }
                });
            } catch (rErr) {
                logger.error(`Error loading previous replies for ticket ${existingTicket.ticketId}: ${rErr.message}`);
            }

            if (!isVendor) {
                const cleanFrom = from.trim().toLowerCase();
                try {
                    // 1. Was sender in TO or CC of any previous Vendor reply?
                    for (const r of previousReplies) {
                        const isVendorRep = r.category === 'vendor' || r.category?.startsWith('vendor_') || r.type === 'vendor';
                        if (isVendorRep) {
                            const participants = [
                                ...(Array.isArray(r.to) ? r.to : []),
                                ...(Array.isArray(r.cc) ? r.cc : [])
                            ].map(e => e.toLowerCase().trim());

                            if (participants.includes(cleanFrom)) {
                                isVendor = true;
                                if (r.category?.startsWith('vendor_')) {
                                    finalVendorId = r.category.replace('vendor_', '');
                                } else if (existingTicket.vendorId) {
                                    finalVendorId = existingTicket.vendorId;
                                }
                                logger.info(`🎟️ [TICKET] 🎯 Identified ${from} as VENDOR based on prior vendor reply participant in category ${r.category}`);
                                break;
                            }
                        }
                    }

                    // 2. Check if subject has vendor tag e.g. [#1024-V] or [1024-V]
                    if (!isVendor && subject && /\[#?V?\d+-V\]/i.test(subject)) {
                        isVendor = true;
                        logger.info(`🎟️ [TICKET] 🧵 Force-routing reply into Vendor thread due to -V tag in subject`);
                    }

                    // 3. Check if email mentions supplier circuit ID of any vendor on this circuit
                    if (!isVendor && existingTicket.circuitId) {
                        const circuit = await prisma.circuit.findFirst({
                            where: { OR: [ { customerCircuitId: existingTicket.circuitId }, { supplierCircuitId: existingTicket.circuitId }, { id: existingTicket.circuitId } ] },
                            include: { vendorCircuits: true }
                        });
                        if (circuit) {
                            const textScan = `${subject || ''} ${body || ''}`.toUpperCase();
                            if (circuit.isMultiVendor && circuit.vendorCircuits && circuit.vendorCircuits.length > 0) {
                                const matchedVc = circuit.vendorCircuits.find(vc => 
                                    vc.supplierCircuitId && textScan.includes(vc.supplierCircuitId.toUpperCase())
                                );
                                if (matchedVc) {
                                    isVendor = true;
                                    finalVendorId = matchedVc.vendorId;
                                    logger.info(`🎟️ [TICKET] 🎯 Identified ${from} as VENDOR for multi-vendor circuit based on Supplier Circuit ID ${matchedVc.supplierCircuitId}`);
                                }
                            } else if (circuit.supplierCircuitId && textScan.includes(circuit.supplierCircuitId.toUpperCase())) {
                                isVendor = true;
                                finalVendorId = circuit.vendorId;
                                logger.info(`🎟️ [TICKET] 🎯 Identified ${from} as VENDOR based on Supplier Circuit ID ${circuit.supplierCircuitId}`);
                            }
                        }
                    }

                    // 4. Corporate Domain match: If sender's domain matches any vendor associated with this circuit
                    if (!isVendor && cleanFrom.includes('@')) {
                        const fromDomain = cleanFrom.split('@')[1];
                        const genericDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
                        if (!genericDomains.includes(fromDomain)) {
                            for (const v of vendors) {
                                if (Array.isArray(v.emails) && v.emails.some(e => e.toLowerCase().endsWith('@' + fromDomain))) {
                                    isVendor = true;
                                    finalVendorId = v.id;
                                    logger.info(`🎟️ [TICKET] 🎯 Identified ${from} as VENDOR based on domain @${fromDomain} matching vendor ${v.name}`);
                                    break;
                                }
                            }
                        }
                    }
                } catch (pErr) {
                    logger.error(`Error in participant reply inspection: ${pErr.message}`);
                }
            }

            const isExplicitVendor = subject && /\[#?V?\d+-V\]/i.test(subject);

            const cleanSenderFrom = from ? from.trim().toLowerCase() : '';
            const incomingRecipients = [...(emailData.to || []), ...(emailData.cc || [])].map(e => e.toLowerCase().trim());
            const includesTicketOwner = existingTicket.email && incomingRecipients.includes(existingTicket.email.toLowerCase().trim());

            // Check if sender matches client of circuit
            let isCircuitClient = false;
            if (existingTicket.circuitId) {
                try {
                    const ckt = await prisma.circuit.findFirst({
                        where: { OR: [ { customerCircuitId: existingTicket.circuitId }, { supplierCircuitId: existingTicket.circuitId }, { id: existingTicket.circuitId } ] },
                        include: { client: true }
                    });
                    if (ckt && ckt.client && Array.isArray(ckt.client.emails)) {
                        isCircuitClient = ckt.client.emails.some(e => e.toLowerCase().trim() === cleanSenderFrom);
                        if (!isCircuitClient && cleanSenderFrom.includes('@')) {
                            const senderDomain = cleanSenderFrom.split('@')[1];
                            const genericDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
                            if (!genericDomains.includes(senderDomain)) {
                                isCircuitClient = ckt.client.emails.some(e => e.toLowerCase().endsWith('@' + senderDomain));
                            }
                        }
                    }
                } catch (_) {}
            }

            const isClientSender = (existingTicket.email && existingTicket.ticketType !== 'Vendor' && existingTicket.email.toLowerCase() === cleanSenderFrom) ||
                (Array.isArray(existingTicket.cc) && existingTicket.cc.some(c => c.toLowerCase() === cleanSenderFrom)) ||
                (existingTicket.client && Array.isArray(existingTicket.client.emails) && existingTicket.client.emails.some(e => e.toLowerCase() === cleanSenderFrom)) ||
                isCircuitClient ||
                (Array.isArray(previousReplies) && previousReplies.some(r => {
                    const isClientReply = r.category === 'client' || (!r.category && r.type !== 'vendor');
                    if (isClientReply) {
                        const recips = [...(r.to || []), ...(r.cc || [])].map(e => e.toLowerCase().trim());
                        return recips.includes(cleanSenderFrom);
                    }
                    return false;
                })) ||
                (includesTicketOwner && !isExplicitVendor && existingTicket.ticketType !== 'Vendor');

            if (!isExplicitVendor && isClientSender) {
                isVendor = false;
                finalVendorId = null;
                logger.info(`🎟️ [TICKET] 🎯 Sender ${from} is client/participant on Ticket ${existingTicket.ticketId} without vendor tag. Routing to Client thread.`);
            } else if (isVendorTicket) {
                isVendor = true;
                if (!finalVendorId) finalVendorId = existingTicket.vendorId;
            }

            if (isExplicitVendor) {
                isVendor = true;
                if (!finalVendorId) finalVendorId = existingTicket.vendorId;
            }

            let isCircuitMultiVendor = false;
            if (isVendor) {
                // Check if In-Reply-To or References matches an earlier vendor reply in this ticket
                if (!finalVendorId && (emailData.inReplyTo || emailData.references)) {
                    try {
                        const refMsgId = emailData.inReplyTo || (emailData.references ? emailData.references.split(/\s+/).pop() : null);
                        if (refMsgId) {
                            const cleanMsgId = refMsgId.replace(/[<>]/g, '').trim();
                            const parentRep = await prisma.reply.findFirst({
                                where: {
                                    ticketId: existingTicket.id,
                                    OR: [
                                        { messageId: refMsgId },
                                        { messageId: `<${cleanMsgId}>` },
                                        { messageId: cleanMsgId }
                                    ]
                                }
                            });
                            if (parentRep && parentRep.category?.startsWith('vendor_')) {
                                finalVendorId = parentRep.category.replace('vendor_', '');
                                isCircuitMultiVendor = true;
                            }
                        }
                    } catch (_) {}
                }

                if (existingTicket.circuitId) {
                    try {
                        const circuit = await prisma.circuit.findFirst({
                            where: {
                                OR: [
                                    { customerCircuitId: { equals: existingTicket.circuitId, mode: 'insensitive' } },
                                    { supplierCircuitId: { equals: existingTicket.circuitId, mode: 'insensitive' } },
                                    { id: existingTicket.circuitId },
                                    { vendorCircuits: { some: { supplierCircuitId: { equals: existingTicket.circuitId, mode: 'insensitive' } } } }
                                ]
                            },
                            include: { vendorCircuits: { include: { vendor: true } } }
                        });
                        if (circuit) {
                            isCircuitMultiVendor = !!circuit.isMultiVendor;
                            if (circuit.isMultiVendor && circuit.vendorCircuits && circuit.vendorCircuits.length > 0) {
                                const textScan = `${subject || ''} ${body || ''}`.toUpperCase();
                                const cleanSender = (from || '').trim().toLowerCase();
                                const senderDomain = cleanSender.includes('@') ? cleanSender.split('@')[1] : '';
                                const vcMatch = circuit.vendorCircuits.find(vc => {
                                    const exactEmailMatch = vc.vendor?.emails && vc.vendor.emails.some(e => e.toLowerCase() === cleanSender);
                                    const domainEmailMatch = senderDomain && !GENERIC_PUBLIC_DOMAINS.has(senderDomain) &&
                                        vc.vendor?.emails && vc.vendor.emails.some(e => e.toLowerCase().endsWith('@' + senderDomain));
                                    const cktTokenMatch = vc.supplierCircuitId &&
                                        extractTokensFromCircuitId(vc.supplierCircuitId).some(tok => textScan.includes(tok.toUpperCase()));
                                    return exactEmailMatch || domainEmailMatch || cktTokenMatch;
                                });
                                if (vcMatch && vcMatch.vendorId) {
                                    finalVendorId = vcMatch.vendorId;
                                } else if (!finalVendorId) {
                                    const lastVendorRep = await prisma.reply.findFirst({
                                        where: { ticketId: existingTicket.id, category: { startsWith: 'vendor_' } },
                                        orderBy: { createdAt: 'desc' }
                                    });
                                    if (lastVendorRep && lastVendorRep.category?.startsWith('vendor_')) {
                                        finalVendorId = lastVendorRep.category.replace('vendor_', '');
                                    } else {
                                        finalVendorId = circuit.vendorCircuits[0].vendorId;
                                    }
                                }
                            }
                            if (!finalVendorId) finalVendorId = circuit.vendorId;
                        }
                    } catch (vErr) {
                        logger.error(`Error finding circuit vendorId: ${vErr.message}`);
                    }
                }
                if (!finalVendorId) finalVendorId = existingTicket.vendorId;
            }

            if (isVendor) {
                // Ensure the parent ticket also records vendorId if it was previously null (only for single-vendor or Vendor-typed tickets)
                if (!existingTicket.vendorId && finalVendorId && (!isCircuitMultiVendor || existingTicket.ticketType === 'Vendor')) {
                    try {
                        await prisma.ticket.update({
                            where: { id: existingTicket.id },
                            data: { vendorId: finalVendorId }
                        });
                        existingTicket.vendorId = finalVendorId;
                    } catch (_) {}
                }
                return await appendVendorReplyToTicket(existingTicket, emailData, finalVendorId, isCircuitMultiVendor);
            } else {
                return await appendClientReplyToTicket(existingTicket, emailData);
            }
        }

        const isAgentMaintenanceNotice = isAgent && SmartSorter.isFormalMaintenanceNotice(subject, body);

        // --- STRICT AGENT GUARD: EdgeStone internal agents/staff (@edgestone.in) NEVER create new tickets,
        // EXCEPT when initiating a formal Maintenance Activity notification for a new scheduled date/circuit! ---
        if (isAgent && !isAgentMaintenanceNotice) {
            logger.warn(`🛑 [TICKET] Blocked ticket creation: Sender ${from} is an EdgeStone internal agent and email was not matched to an existing ticket. Agent emails cannot create tickets.`);
            return null;
        }

        // 1. Identify Potential Senders
        let potentialClientIds = [];
        let potentialVendorIds = [];
        let clientId = null;
        let vendorId = null;
        let ticketType = 'Client';

        const clients = await ClientModel.findAllClients();
        potentialClientIds = clients.filter(c => c.emails.some(e => e.toLowerCase() === from.toLowerCase())).map(c => c.id);

        const cleanFrom = from ? from.trim().toLowerCase() : '';
        const fromDomain = cleanFrom.includes('@') ? cleanFrom.split('@')[1] : '';

        // Domain matching for corporate client colleagues (e.g. alex@acmeretail.com)
        let domainMatchedClientIds = [];
        if (cleanFrom && fromDomain && !GENERIC_PUBLIC_DOMAINS.has(fromDomain)) {
            domainMatchedClientIds = clients.filter(c => isEmailMatchingClientDomain(cleanFrom, c) && !potentialClientIds.includes(c.id)).map(c => c.id);
            if (domainMatchedClientIds.length > 0) {
                logger.info(`🎟️ [TICKET] 🎯 Identified ${from} as potential CLIENT based on corporate domain @${fromDomain} matching client ID(s): ${domainMatchedClientIds.join(', ')}`);
            }
        }

        const vendors = await VendorModel.findAllVendors();
        potentialVendorIds = vendors.filter(v => v.emails.some(e => e.toLowerCase() === from.toLowerCase())).map(v => v.id);

        // Domain matching fallback for unregistered vendor team members (e.g. Soumyajit.dhar@cognizant.com)
        const genericDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'zoho.com', 'live.com', 'protonmail.com'];
        let domainMatchedVendorIds = [];
        if (cleanFrom && fromDomain && !genericDomains.includes(fromDomain)) {
            domainMatchedVendorIds = vendors.filter(v => Array.isArray(v.emails) && v.emails.some(e => e.toLowerCase().endsWith('@' + fromDomain))).map(v => v.id);
            if (domainMatchedVendorIds.length > 0) {
                logger.info(`🎟️ [TICKET] 🎯 Identified ${from} as potential VENDOR based on domain @${fromDomain} matching vendor ID(s): ${domainMatchedVendorIds.join(', ')}`);
            }
        }

        // Set initial defaults (first match wins, will be disambiguated by circuit later if needed)
        if (potentialClientIds.length > 0) {
            clientId = potentialClientIds[0];
            logger.debug(`🐞 🎟️ [TICKET] 👤 Initially identified sender as Client: ${clientId}`);
        } else if (domainMatchedClientIds.length > 0) {
            clientId = domainMatchedClientIds[0];
            ticketType = 'Client';
            logger.debug(`🐞 🎟️ [TICKET] 👤 Initially identified sender as Client via domain: ${clientId}`);
        } else if (potentialVendorIds.length > 0) {
            vendorId = potentialVendorIds[0];
            ticketType = 'Vendor';
            logger.debug(`🐞 🎟️ [TICKET] 🏢 Initially identified sender as Vendor: ${vendorId}`);
        } else if (domainMatchedVendorIds.length > 0) {
            vendorId = domainMatchedVendorIds[0];
            ticketType = 'Vendor';
            logger.debug(`🐞 🎟️ [TICKET] 🏢 Initially identified sender as Vendor via domain: ${vendorId}`);
        } else {
            logger.debug(`🐞 🎟️ [TICKET] ❓ Sender not identified as existing client or vendor.`);
        }

        // 2. Parse Subject and Body for Circuit ID from Database via AI + Regex Fallback
        let circuitId = null;
        let circuitUUID = null;
        let foundLocation = 'none';
        let containsVendorCircuitId = false;
        let detectedCircuitRecord = null;
        try {
            const allCircuits = await prisma.circuit.findMany({ 
                select: { id: true, customerCircuitId: true, supplierCircuitId: true, supplierPoNumber: true, clientId: true, vendorId: true, isMultiVendor: true, vendorCircuits: true } 
            });
            
            const isCircuitTemp = (circuit) => {
                if (!circuit) return false;
                const cust = (circuit.customerCircuitId || '').toLowerCase();
                const supp = (circuit.supplierCircuitId || '').toLowerCase();
                return /^(?:temp|temporary)[\s-_:]+/i.test(cust) || /^(?:temp|temporary)[\s-_:]+/i.test(supp);
            };

            const extractTokens = (id) => extractTokensFromCircuitId(id);

            const matchesCircuit = (text, targetId) => {
                if (!text || !targetId) return false;
                const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?:$|[^a-zA-Z0-9_-])`, 'i');
                return regex.test(text);
            };

            const mentionsTempBeforeToken = (text, targetId) => {
                if (!text || !targetId) return false;
                const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(?:^|[^a-zA-Z0-9])(?:temp|temporary)[\\s-_:]*${escaped}`, 'i');
                return regex.test(text);
            };

            const subjectText = subject || '';
            const bodyText = body || '';
            const strippedHtmlBody = stripHtml(bodyText) || bodyText;
            const cleanBodyText = stripQuotedReply(strippedHtmlBody) || strippedHtmlBody;
            const fullScanText = `${subjectText} \n ${strippedHtmlBody} \n ${bodyText}`;
            const subjectUpper = subjectText.toUpperCase();
            const bodyUpper = fullScanText.toUpperCase();

            let priorityCircuits = [];
            let secondaryCircuits = [];

            if (potentialClientIds.length > 0) {
                priorityCircuits = allCircuits.filter(c => c.clientId && potentialClientIds.includes(c.clientId));
                secondaryCircuits = []; // STRICT ISOLATION: Never match foreign client circuits!
            } else if (domainMatchedClientIds.length > 0) {
                priorityCircuits = allCircuits.filter(c => c.clientId && domainMatchedClientIds.includes(c.clientId));
                secondaryCircuits = []; // STRICT ISOLATION: Corporate colleague only matches their company's circuits!
            } else if (potentialVendorIds.length > 0) {
                priorityCircuits = allCircuits.filter(c => 
                    (c.vendorId && potentialVendorIds.includes(c.vendorId)) ||
                    (c.isMultiVendor && c.vendorCircuits && c.vendorCircuits.some(vc => potentialVendorIds.includes(vc.vendorId)))
                );
                secondaryCircuits = []; // STRICT ISOLATION: Never match foreign vendor circuits!
            } else if (domainMatchedVendorIds.length > 0) {
                priorityCircuits = allCircuits.filter(c => 
                    (c.vendorId && domainMatchedVendorIds.includes(c.vendorId)) ||
                    (c.isMultiVendor && c.vendorCircuits && c.vendorCircuits.some(vc => domainMatchedVendorIds.includes(vc.vendorId)))
                );
                secondaryCircuits = allCircuits;
            } else {
                priorityCircuits = allCircuits;
                secondaryCircuits = [];
            }

            const findMatchInPool = (circuitPool) => {
                const candidates = [];

                for (const c of circuitPool) {
                    const isTemp = isCircuitTemp(c);
                    const poolItems = [];

                    if (c.customerCircuitId) {
                        const tokens = extractTokens(c.customerCircuitId);
                        tokens.forEach(tok => poolItems.push({ token: tok, isSupplier: false, fullId: c.customerCircuitId }));
                    }
                    if (c.supplierCircuitId) {
                        const tokens = extractTokens(c.supplierCircuitId);
                        tokens.forEach(tok => poolItems.push({ token: tok, isSupplier: true, fullId: c.supplierCircuitId }));
                    }
                    if (c.supplierPoNumber) {
                        const tokens = extractTokens(c.supplierPoNumber);
                        tokens.forEach(tok => poolItems.push({ token: tok, isSupplier: true, fullId: c.supplierPoNumber }));
                    }
                    if (c.isMultiVendor && Array.isArray(c.vendorCircuits)) {
                        c.vendorCircuits.forEach(vc => {
                            if (vc.supplierCircuitId) {
                                const tokens = extractTokens(vc.supplierCircuitId);
                                tokens.forEach(tok => poolItems.push({ token: tok, isSupplier: true, fullId: vc.supplierCircuitId }));
                            }
                        });
                    }

                    for (const item of poolItems) {
                        let location = null;
                        if (matchesCircuit(subjectText, item.token)) {
                            location = 'subject';
                        } else if (matchesCircuit(cleanBodyText, item.token)) {
                            location = 'body';
                        } else if (cleanBodyText !== strippedHtmlBody && matchesCircuit(strippedHtmlBody, item.token)) {
                            location = 'body_quoted';
                        } else if (matchesCircuit(bodyText, item.token)) {
                            location = 'body_quoted';
                        }

                        if (location) {
                            const hasTempInText = mentionsTempBeforeToken(fullScanText, item.token) ||
                                /^(?:temp|temporary)[\s-_:]+/i.test(item.fullId && matchesCircuit(fullScanText, item.fullId) ? item.fullId : '');
                            candidates.push({
                                circuit: c,
                                isSupplier: item.isSupplier,
                                location,
                                matchedId: item.token,
                                isTemp,
                                hasTempInText,
                                tokenLength: item.token.length
                            });
                        }
                    }
                }

                if (candidates.length === 0) return null;

                // CRITICAL USER RULE FOR TEMPORARY CIRCUITS:
                // 1. If "temp" is explicitly mentioned before the circuit ID in text, match temporary circuit!
                const explicitTempMatches = candidates.filter(cand => cand.hasTempInText && cand.isTemp);
                if (explicitTempMatches.length > 0) {
                    explicitTempMatches.sort((a, b) => b.tokenLength - a.tokenLength);
                    return explicitTempMatches[0];
                }

                // 2. If "temp" is NOT mentioned before the circuit ID in text, STRICTLY MATCH ORIGINAL CIRCUIT!
                const originalMatches = candidates.filter(cand => !cand.isTemp);
                if (originalMatches.length > 0) {
                    originalMatches.sort((a, b) => b.tokenLength - a.tokenLength);
                    return originalMatches[0];
                }

                // 3. Fallback: if only a temp circuit exists in DB for this identifier
                candidates.sort((a, b) => b.tokenLength - a.tokenLength);
                return candidates[0];
            };

            let matchResult = findMatchInPool(priorityCircuits);

            if (!matchResult && secondaryCircuits.length > 0) {
                matchResult = findMatchInPool(secondaryCircuits);
            }

            if (matchResult) {
                detectedCircuitRecord = matchResult.circuit;
                circuitId = matchResult.circuit.customerCircuitId || matchResult.circuit.supplierCircuitId || matchResult.matchedId;
                circuitUUID = matchResult.circuit.id;
                foundLocation = matchResult.location;
                if (matchResult.isSupplier) {
                    containsVendorCircuitId = true;
                }
                logger.info(`🎟️ [TICKET] 🔍 Circuit Match: Detected Circuit "${circuitId}" (matched token "${matchResult.matchedId}") in ${matchResult.location.toUpperCase()} for Client ${matchResult.circuit.clientId || 'Unknown'}`);
            } else {
                logger.info(`🎟️ [TICKET] Circuit scan found no recognized Circuit ID in subject or body.`);
            }

            // --- Disambiguate Sender based on detected circuit ---
            if (circuitId) {
                if (!detectedCircuitRecord) {
                    detectedCircuitRecord = allCircuits.find(c =>
                        c.customerCircuitId === circuitId ||
                        c.supplierCircuitId === circuitId ||
                        (c.isMultiVendor && Array.isArray(c.vendorCircuits) && c.vendorCircuits.some(vc => vc.supplierCircuitId === circuitId))
                    );
                }
                if (detectedCircuitRecord) {
                    if (detectedCircuitRecord.supplierCircuitId) {
                        const suppTokens = extractTokens(detectedCircuitRecord.supplierCircuitId);
                        if (suppTokens.some(tok => matchesCircuit(fullScanText, tok))) {
                            containsVendorCircuitId = true;
                            logger.info(`🎟️ [TICKET] Vendor circuit ID detected during disambiguation phase.`);
                        }
                    }

                    let circuitVendorId = null;
                    if (detectedCircuitRecord.isMultiVendor && detectedCircuitRecord.vendorCircuits && detectedCircuitRecord.vendorCircuits.length > 0) {
                        if (matchResult && matchResult.matchedId) {
                            const matchedVc = detectedCircuitRecord.vendorCircuits.find(vc => 
                                vc.supplierCircuitId && extractTokens(vc.supplierCircuitId).some(t => t.toUpperCase() === matchResult.matchedId.toUpperCase())
                            );
                            if (matchedVc && matchedVc.vendorId) {
                                circuitVendorId = matchedVc.vendorId;
                            }
                        }
                        if (!circuitVendorId && domainMatchedVendorIds.length > 0) {
                            const domainVc = detectedCircuitRecord.vendorCircuits.find(vc => domainMatchedVendorIds.includes(vc.vendorId));
                            if (domainVc && domainVc.vendorId) {
                                circuitVendorId = domainVc.vendorId;
                            }
                        }
                        if (!circuitVendorId) {
                            const matchingVc = detectedCircuitRecord.vendorCircuits.find(vc => vc.vendorId && potentialVendorIds.includes(vc.vendorId));
                            circuitVendorId = matchingVc ? matchingVc.vendorId : detectedCircuitRecord.vendorCircuits[0].vendorId;
                        }
                    } else {
                        circuitVendorId = detectedCircuitRecord.vendorId;
                    }

                    let matchedCircuitVendorId = null;
                    if (circuitVendorId && (potentialVendorIds.includes(circuitVendorId) || domainMatchedVendorIds.includes(circuitVendorId))) {
                        matchedCircuitVendorId = circuitVendorId;
                    }

                    const isVendorCircuitMatched = (matchResult && matchResult.isSupplier) || containsVendorCircuitId;
                    const isExplicitVendor = isVendorCircuitMatched || (subject && /\[#?V?\d+-V\]/i.test(subject));
                    const isMaintenanceEmail = SmartSorter.isFormalMaintenanceNotice(subjectText, bodyText) || SmartSorter.hasMaintenanceSignal(subjectText, bodyText);

                    // 0. If this is an EdgeStone Agent Maintenance Activity advisory for a specific circuit & date:
                    if (isAgentMaintenanceNotice) {
                        vendorId = circuitVendorId || null;
                        clientId = detectedCircuitRecord.clientId || null;
                        ticketType = 'Vendor';
                        logger.info(`🎟️ [TICKET] 🎯 Disambiguated Sender: Identified as AGENT-INITIATED MAINTENANCE for Circuit ${circuitId} (Client: ${clientId}, Vendor: ${vendorId})`);
                    }
                    // 1. If sender is recognized as the client for this circuit (or matching domain) AND email did NOT contain vendor circuit ID / tag or formal maintenance notice:
                    else if (!isExplicitVendor && !SmartSorter.isFormalMaintenanceNotice(subjectText, bodyText) && detectedCircuitRecord.clientId && (potentialClientIds.includes(detectedCircuitRecord.clientId) || domainMatchedClientIds.includes(detectedCircuitRecord.clientId))) {
                        clientId = detectedCircuitRecord.clientId;
                        ticketType = 'Client';
                        vendorId = circuitVendorId || null;
                        logger.info(`🎟️ [TICKET] 🎯 Disambiguated Sender: Assigned to Client ${clientId} (Vendor: ${vendorId}) based on Circuit ${circuitId}`);
                    }
                    // 2. If it is a Maintenance email AND (contains Vendor Circuit ID OR sender is not client OR matches vendor domain):
                    else if (isMaintenanceEmail && circuitVendorId && (isVendorCircuitMatched || (potentialClientIds.length === 0 && domainMatchedClientIds.length === 0) || domainMatchedVendorIds.includes(circuitVendorId))) {
                        vendorId = circuitVendorId;
                        ticketType = 'Vendor';
                        clientId = detectedCircuitRecord.clientId || null;
                        logger.info(`🎟️ [TICKET] 🎯 Disambiguated Sender: Identified as VENDOR MAINTENANCE for Vendor ${vendorId} on Circuit ${circuitId} (Linked Client: ${clientId})`);
                    }
                    // 3. If explicitly vendor (contains Vendor Circuit ID or [#...-V]) AND sender is not a recognized client:
                    else if (isExplicitVendor && circuitVendorId && (!detectedCircuitRecord.clientId || (!potentialClientIds.includes(detectedCircuitRecord.clientId) && !domainMatchedClientIds.includes(detectedCircuitRecord.clientId)))) {
                        vendorId = circuitVendorId;
                        ticketType = 'Vendor';
                        clientId = detectedCircuitRecord.clientId || null;
                        logger.info(`🎟️ [TICKET] 🎯 Disambiguated Sender: Assigned to Vendor ${vendorId} based on Circuit ${circuitId} (Vendor Circuit ID / Explicit Vendor)`);
                    }
                    // 4. If sender matched a vendor (directly or via domain) and sender is not a client:
                    else if (matchedCircuitVendorId && (isExplicitVendor || (potentialClientIds.length === 0 && domainMatchedClientIds.length === 0))) {
                        vendorId = matchedCircuitVendorId;
                        ticketType = 'Vendor';
                        clientId = detectedCircuitRecord.clientId || null;
                        logger.info(`🎟️ [TICKET] 🎯 Disambiguated Sender: Assigned to Vendor ${vendorId} based on Circuit ${circuitId} (Sender matched vendor)`);
                    }
                    // 5. If matchedCircuitVendorId exists and sender is not recognized as client for this circuit:
                    else if (matchedCircuitVendorId && (!detectedCircuitRecord.clientId || (!potentialClientIds.includes(detectedCircuitRecord.clientId) && !domainMatchedClientIds.includes(detectedCircuitRecord.clientId)))) {
                        vendorId = matchedCircuitVendorId;
                        ticketType = 'Vendor';
                        clientId = detectedCircuitRecord.clientId || null;
                        logger.info(`🎟️ [TICKET] 🎯 Disambiguated Sender: Assigned to Vendor ${vendorId} based on Circuit ${circuitId} (Vendor matched)`);
                    }
                    // 6. Check if sender belongs to Client owning circuit (or is authorized internal forwarder):
                    else if (detectedCircuitRecord.clientId) {
                        const isInternalForwarder = cleanFrom.includes('edgestone.in');
                        const isSenderRecognizedClient = potentialClientIds.includes(detectedCircuitRecord.clientId);
                        const isSenderDomainMatch = domainMatchedClientIds.includes(detectedCircuitRecord.clientId);

                        if (isSenderRecognizedClient || isSenderDomainMatch || isInternalForwarder) {
                            clientId = detectedCircuitRecord.clientId;
                            ticketType = 'Client';
                            vendorId = circuitVendorId || null;
                            logger.info(`🎟️ [TICKET] 🎯 Disambiguated Sender: Assigned to Client ${clientId} (Vendor: ${vendorId}) based on Circuit ${circuitId}`);
                        } else {
                            const targetClient = clients.find(c => c.id === detectedCircuitRecord.clientId);
                            logger.warn(`⚠️ 🎟️ [TICKET] 🛑 BLOCKED CLIENT ASSIGNMENT: Sender ${from} quoted Circuit ${circuitId} belonging to Client "${targetClient ? targetClient.name : 'Unknown'}", but sender is neither a registered contact nor from a matching corporate domain.`);
                            clientId = null;
                            ticketType = 'Unverified';
                            vendorId = null;
                        }
                    }
                }
            }

        } catch (dbErr) {
            logger.error(`🚨 🎟️ [TICKET] ❌ Failed to process AI Circuit identification: ${dbErr.message}`);
        }

        // CRITICAL GATE: If no circuit matches DB, drop email unless maintenance/CRQ notice
        if (!circuitId) {
            const isVendorSender = potentialVendorIds.length > 0 || domainMatchedVendorIds.length > 0;
            const isClientSender = potentialClientIds.length > 0 || domainMatchedClientIds.length > 0;
            const isMaintenanceContext = SmartSorter.isFormalMaintenanceNotice(subject, body) || SmartSorter.hasMaintenanceSignal(subject, body);

            if (isMaintenanceContext) {
                logger.warn(`⚠️ 🎟️ [TICKET] Circuit not matched in DB, but maintenance/CRQ context detected in "${subject}" from ${from}. Creating Maintenance Ticket for NOC review instead of dropping.`);
                if (isClientSender && !isVendorSender && !isAgentMaintenanceNotice) {
                    ticketType = 'Client';
                    clientId = potentialClientIds[0] || domainMatchedClientIds[0] || null;
                    vendorId = null;
                } else {
                    ticketType = 'Vendor';
                    vendorId = potentialVendorIds[0] || domainMatchedVendorIds[0] || null;
                    clientId = null;
                }
                circuitId = null;
            } else {
                logger.warn(`⚠️ 🎟️ [TICKET] 🚫 DROPPED EMAIL: Subject "${subject}" from ${from} does not contain any recognized Circuit ID. Ticket will NOT be created.`);
                return null;
            }
        }

        // --- NON-ROOT EMAIL GUARD: Only block non-root emails if they do NOT have a valid Circuit ID and are NOT a Maintenance/CRQ notice ---
        if (!isRoot && !circuitId && !SmartSorter.isFormalMaintenanceNotice(subject, body) && !SmartSorter.hasMaintenanceSignal(subject, body)) {
            logger.warn(`🛑 [SMART SORTER] Blocked ticket creation: Email "${subject}" from ${from} is an unmatched reply without a Circuit ID or Maintenance context.`);
            return null;
        }

        // ── CLIENT EMAILS STRICTLY ISOLATED FROM MAINTENANCE TICKETS ──
        // Maintenance tickets are vendor notifications where client sections are empty.
        // Client emails must NEVER merge into Maintenance tickets. They always create dedicated incident tickets.

        // ── SMART VENDOR ACTIVE TICKET DEDUPLICATION & THREADING INTERCEPTOR ──
        // Correlates vendor replies and automated vendor incident updates into an active ticket on the same circuit
        // while preserving first-time root Maintenance notices and isolating SLA Rebate / Commercial emails.
        const isIncomingMaintEmail = SmartSorter.isFormalMaintenanceNotice(subject, body) || SmartSorter.hasMaintenanceSignal(subject, body);
        const isIncomingRebateEmail = SmartSorter.isSlaRebateOrCommercialEmail(subject, body);
        if (
            ticketType === 'Vendor' &&
            circuitId &&
            !isIncomingRebateEmail &&
            (!isRoot || (!isIncomingMaintEmail && SmartSorter.hasIncidentSignal(subject, body)))
        ) {
            try {
                const circuitKeys = [circuitId];
                if (detectedCircuitRecord) {
                    if (detectedCircuitRecord.customerCircuitId) {
                        circuitKeys.push(detectedCircuitRecord.customerCircuitId);
                        circuitKeys.push(...extractTokensFromCircuitId(detectedCircuitRecord.customerCircuitId));
                    }
                    if (detectedCircuitRecord.supplierCircuitId) {
                        circuitKeys.push(detectedCircuitRecord.supplierCircuitId);
                        circuitKeys.push(...extractTokensFromCircuitId(detectedCircuitRecord.supplierCircuitId));
                    }
                    if (detectedCircuitRecord.id) circuitKeys.push(detectedCircuitRecord.id);
                    if (detectedCircuitRecord.isMultiVendor && Array.isArray(detectedCircuitRecord.vendorCircuits)) {
                        for (const vc of detectedCircuitRecord.vendorCircuits) {
                            if (vc.supplierCircuitId) {
                                circuitKeys.push(vc.supplierCircuitId);
                                circuitKeys.push(...extractTokensFromCircuitId(vc.supplierCircuitId));
                            }
                        }
                    }
                }

                // Operational Recency Cutoff: Strictly consider tickets from 26th October onwards (discard past tickets)
                const MIN_OPERATIONAL_DATE = SmartSorter.MIN_OPERATIONAL_DATE;

                const candidateTickets = await prisma.ticket.findMany({
                    where: {
                        circuitId: { in: Array.from(new Set(circuitKeys.filter(Boolean))) },
                        status: { notIn: ['Closed', 'Resolved', 'Spam'] },
                        createdAt: { gte: MIN_OPERATIONAL_DATE }
                    },
                    include: { replies: { select: { text: true, subject: true } } },
                    orderBy: { createdAt: 'asc' } // Prefer root Client incident ticket first
                });

                const activeVendorTicket = candidateTickets.find(t => {
                    if (SmartSorter.isBusinessProcessBarrierVeto(t, { subject, body })) return false;
                    if (!isIncomingMaintEmail) {
                        // Vendor incident email: match active incident ticket (including Client tickets with active SLA even if legacy status was Maintenance)
                        if (!t.isMaintenance && ['Open', 'In Progress'].includes(t.status)) return true;
                        if (t.ticketType === 'Client' && t.isSlaActive && SmartSorter.hasStrictIncidentSignal(t.header || '', '')) return true;
                        return false;
                    }
                    // Vendor maintenance update: match active maintenance ticket
                    return t.isMaintenance || t.status === 'Maintenance';
                });

                if (activeVendorTicket) {
                    let shouldIntercept = true;

                    if (SmartSorter.hasMaintenanceScheduleConflict(activeVendorTicket, { subject, body })) {
                        shouldIntercept = false;
                    } else if (isIncomingMaintEmail) {
                        const incomingMeta = extractMaintenanceMetadata(subject, body);
                        const existingMeta = SmartSorter.extractCandidateMaintenanceMeta(activeVendorTicket);
                        const hasCompletion = (activeVendorTicket.replies || []).some(r => /(?:successfully\s*completed|activity\s*completed|maintenance\s*completed)/i.test(r.text || ''));

                        if (
                            hasCompletion ||
                            (incomingMeta.crqId && (!existingMeta.crqId || incomingMeta.crqId.toUpperCase() !== existingMeta.crqId.toUpperCase())) ||
                            (incomingMeta.maintDate && (!existingMeta.maintDate || incomingMeta.maintDate !== existingMeta.maintDate))
                        ) {
                            logger.info(`🎟️ [TICKET] Vendor maintenance email has different CRQ (${incomingMeta.crqId} vs ${existingMeta.crqId}) or different date (${incomingMeta.maintDate} vs ${existingMeta.maintDate}). Creating NEW ticket instead of merging into Ticket ${activeVendorTicket.ticketId}`);
                            shouldIntercept = false;
                        }
                    }

                    if (shouldIntercept) {
                        logger.info(`🎟️ [TICKET] 🔀 Smart Vendor Active Ticket Interceptor: Redirecting automated/subsequent vendor email from ${from} into active Ticket ${activeVendorTicket.ticketId} on circuit ${circuitId} (Prevented duplicate ticket creation).`);

                        const effectiveVendorId = vendorId || activeVendorTicket.vendorId;
                        const isMultiVendorCkt = !!detectedCircuitRecord?.isMultiVendor;
                        if (!activeVendorTicket.vendorId && effectiveVendorId && (!isMultiVendorCkt || activeVendorTicket.ticketType === 'Vendor')) {
                            try {
                                await prisma.ticket.update({ where: { id: activeVendorTicket.id }, data: { vendorId: effectiveVendorId } });
                                activeVendorTicket.vendorId = effectiveVendorId;
                            } catch (_) {}
                        }
                        const replyResult = await appendVendorReplyToTicket(activeVendorTicket, emailData, effectiveVendorId, isMultiVendorCkt);

                        try {
                            const notificationService = require('../notificationService');
                            await notificationService.sendNotification({
                                type: 'vendor_reply',
                                title: `Vendor Update (${activeVendorTicket.ticketId})`,
                                message: `${fromName || from} sent an update for Ticket ${activeVendorTicket.ticketId}`,
                                ticketId: activeVendorTicket.ticketId,
                                sender: 'vendor'
                            });
                        } catch (_) {}

                        return replyResult;
                    }
                }
            } catch (vInterceptErr) {
                logger.error(`Error in Smart Vendor Active Ticket Interceptor: ${vInterceptErr.message}`);
            }
        }

        let ticketId;
        let ticket;
        let retries = 0;
        const maxRetries = 3;
        const isUnverifiedSender = ticketType === 'Unverified';

        while (retries < maxRetries) {
            ticketId = await generateTicketId(ticketType);
            logger.debug(`🐞 🎟️ [TICKET] 🆔 Generated ${ticketType} Ticket ID: ${ticketId}`);

            const emailReceivedDate = date ? new Date(date) : new Date();

            // Smart Ticket Sorter: strict 28th Oct 2026 cutoff for NEW tickets
            if (SmartSorter.isBeforeCutoff(emailReceivedDate)) {
                logger.info(`🚫 [SORTER:28-OCT CUTOFF] Discarding fresh ticket for email before ${SmartSorter.FRESH_TICKET_MIN_DATE.toISOString()}: "${subject}" (${emailReceivedDate.toISOString()}).`);
                return null;
            }

            const incomingTos = (Array.isArray(emailData.to) ? emailData.to : []).filter(e => {
                const clean = e && e.toLowerCase().trim();
                return clean && !clean.includes('edgestone.in') && clean !== from.toLowerCase();
            });
            let allVendorEmailsSet = new Set();
            try {
                const allVendorsList = await VendorModel.findAllVendors();
                allVendorEmailsSet = new Set(allVendorsList.flatMap(v => (v.emails || []).map(e => e.toLowerCase().trim())));
            } catch (_) {}

            const initialCcs = Array.from(new Set([
                ...(Array.isArray(emailData.cc) ? emailData.cc : []),
                ...incomingTos
            ].map(e => e.trim().toLowerCase()))).filter(e => {
                if (!e || e === from.toLowerCase()) return false;
                if (ticketType === 'Client' && allVendorEmailsSet.has(e)) return false;
                return true;
            });

            const initialToList = [from];
            if (Array.isArray(emailData.to)) {
                emailData.to.forEach(e => {
                    const clean = e && e.trim().toLowerCase();
                    if (clean && clean !== from.toLowerCase() && !initialToList.some(x => x.toLowerCase() === clean)) {
                        initialToList.push(e.trim());
                    }
                });
            }

            // Smart Ticket Sorter: classify by ticket ORIGIN (vendor-originated or agent-initiated maintenance notice)
            const origin = SmartSorter.classifyOrigin({
                ticketType,
                isVendorOrigin: potentialVendorIds && potentialVendorIds.length > 0,
                isAgentOrigin: isAgentMaintenanceNotice,
                subject,
                body
            });
            const initialStatus = origin.status;
            const initialIsMaintenance = origin.isMaintenance;
            const isVendorTicket = (ticketType === 'Vendor' || ticketId.startsWith('#V'));

            try {
                ticket = await TicketModel.createTicket({
                    ticketId,
                    header: isUnverifiedSender ? `[UNVERIFIED SENDER] ${subject || 'No Subject'}` : (subject || 'No Subject'),
                    email: (isAgentMaintenanceNotice && incomingTos.length > 0) ? incomingTos[0] : from,
                    status: initialStatus,
                    priority: isUnverifiedSender ? 'High' : 'Medium',
                    isMaintenance: initialIsMaintenance,
                    isSlaActive: !isVendorTicket,
                    circuitId: circuitId,
                    messageId: messageId,
                    receivedAt: emailReceivedDate,
                    receivedTime: emailReceivedDate.toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                    }),
                    date: emailReceivedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
                    clientId: clientId,
                    vendorId: vendorId,
                    ticketType: ticketType,
                    cc: initialCcs,
                    replies: {
                        create: {
                            text: stripQuotedReply(stripHtml(emailData.html || body)) || '(No Content)',
                            time: emailReceivedDate.toLocaleTimeString('en-US', {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false
                            }),
                            date: emailReceivedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
                            author: fromName || from,
                            type: isAgent ? 'agent' : (ticketType === 'Unverified' ? 'client' : ticketType.toLowerCase()),
                            category: isAgentMaintenanceNotice
                                ? 'client'
                                : ((ticketType === 'Vendor' && vendorId) ? `vendor_${vendorId}` : (ticketType === 'Unverified' ? 'client' : ticketType.toLowerCase())),
                            to: isAgentMaintenanceNotice ? (incomingTos.length > 0 ? incomingTos : initialToList) : initialToList,
                            cc: emailData.cc || [],
                            subject: subject || 'No Subject',
                            messageId: messageId || null,
                            attachments: emailData.attachments || []
                        }
                    },
                    activityLogs: {
                        create: {
                            action: 'created',
                            description: `Ticket created from email by ${fromName || from}`,
                            time: emailReceivedDate.toLocaleTimeString('en-US', {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false
                            }),
                            date: emailReceivedDate.toLocaleDateString('en-GB', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric'
                            }),
                            author: fromName || from
                        }
                    }
                });

                // Auto-register contacts into Client or Vendor model
                if (clientId) {
                    try {
                        const client = await prisma.client.findUnique({ where: { id: clientId } });
                        if (client) {
                            const currentEmails = Array.isArray(client.emails) ? client.emails : [];
                            const newEmails = [];
                            [from, ...initialCcs].forEach(em => {
                                const c = em && em.trim().toLowerCase();
                                if (c && !c.includes('edgestone.in') && isEmailMatchingClientDomain(c, client) && !currentEmails.some(x => x.toLowerCase() === c) && !newEmails.some(x => x.toLowerCase() === c)) {
                                    newEmails.push(em.trim());
                                } else if (c && !c.includes('edgestone.in') && !isEmailMatchingClientDomain(c, client)) {
                                    logger.warn(`🛑 [CLIENT] Refused to auto-register contact ${em} into ${client.name}: Domain does not match client's corporate domain.`);
                                }
                            });
                            if (newEmails.length > 0) {
                                await prisma.client.update({ where: { id: clientId }, data: { emails: [...currentEmails, ...newEmails] } });
                                logger.info(`👤 [CLIENT] ➕ Auto-registered contact emails for ${client.name}: ${newEmails.join(', ')}`);
                            }
                        }
                    } catch (cErr) {
                        logger.error(`Error auto-registering client emails: ${cErr.message}`);
                    }
                } else if (vendorId && from) {
                    try {
                        const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
                        if (vendor) {
                            const currentEmails = Array.isArray(vendor.emails) ? vendor.emails : [];
                            const c = from.trim().toLowerCase();
                            if (c && !c.includes('edgestone.in') && !currentEmails.some(x => x.toLowerCase() === c)) {
                                await prisma.vendor.update({ where: { id: vendorId }, data: { emails: [...currentEmails, from.trim()] } });
                                logger.info(`🏢 [VENDOR] ➕ Auto-registered sender email for ${vendor.name}: ${from.trim()}`);
                            }
                        }
                    } catch (vErr) {
                        logger.error(`Error auto-registering vendor emails: ${vErr.message}`);
                    }
                }

                break; // Success! Exit retry loop
            } catch (error) {
                if (error.code === 'P2002' && retries < maxRetries - 1) {
                    logger.warn(`⚠️ 🎟️ [TICKET] Unique constraint failed on ticketId ${ticketId}, retrying (${retries + 1}/${maxRetries})...`);
                    retries++;
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 200 + 100));
                } else {
                    throw error;
                }
            }
        }

        logger.info(`🎟️ [TICKET] ✅ ${ticketType} Ticket Created Successfully: ${ticket.ticketId} at ${ticket.receivedTime}`);
        try {
            const notificationService = require('../notificationService');
            const notifMsg = (!circuitId && initialIsMaintenance)
                ? `🚨 New Maintenance Notice (Needs Circuit): ${ticket.ticketId} - ${ticket.header}`
                : `New Ticket Raised: ${ticket.ticketId}`;
            notificationService.sendNotification({ type: 'new_ticket', message: notifMsg, ticketId: ticket.ticketId });
        } catch(err) { logger.error(`Notification Error: ${err.message}`) }

        // Auto-reply logic
        // Skip auto-reply if disabled via env (AUTOREPLY=false), or for vendor-raised tickets / unverified senders
        if (!isAutoReplyEnabled()) {
            logger.info(`🎟️ [TICKET] 🛑 Skipped Auto-Reply for Ticket ${ticket.ticketId} (Disabled via AUTOREPLY env)`);
        } else if (ticketType === 'Unverified' || !clientId) {
            logger.info(`🎟️ [TICKET] 🛑 Skipped Auto-Reply for Ticket ${ticket.ticketId} (Unverified sender)`);
        } else if (ticketType !== 'Vendor') {
            try {
                const autoReplySubject = `Ticket Received: [${ticket.ticketId}] ${ticket.header}`;
                const autoReplyText = `Dear Customer,\n\nYour ticket has been received and created. Ticket ID: ${ticket.ticketId}\n\nOur team will review your request and get back to you shortly.\n\nThank you,\nSupport Team`;
                const autoReplyHtml = `
                    <div style="font-family: Arial, sans-serif;">
                        <p>Dear Customer,</p>
                        <p>Your ticket has been received and created.</p>
                        <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
                        <p>Our team will review your request and get back to you shortly.</p>
                        <br/>
                        <p>Thank you,<br/>Support Team</p>
                    </div>
                `;

                logger.info(`🎟️ [TICKET] 🤖 Sending Auto-Reply to ${from} for Ticket ${ticket.ticketId}`);
                const sendFn = emailSender.sendAutoReplyEmail || emailSender.sendEmail;
                await sendFn({
                    to: [from],
                    subject: autoReplySubject,
                    text: autoReplyText,
                    html: autoReplyHtml,
                    inReplyTo: ticket.messageId,
                    references: ticket.messageId
                });
            } catch(err) {
                logger.error(`🎟️ [TICKET] ❌ Auto-Reply Error: ${err.message}`);
            }
        } else {
            logger.info(`🎟️ [TICKET] 🛑 Skipped Auto-Reply for Ticket ${ticket.ticketId} (Vendor ticket)`);
        }

        return ticket;

    } catch (error) {
        logger.error(`🚨 🎟️ [TICKET] ❌ Error in createTicketFromEmail: ${error.message}`, { stack: error.stack });
        throw error;
    }
});

module.exports = {
    createTicketFromEmail,
    isAutoReplyEnabled
};
