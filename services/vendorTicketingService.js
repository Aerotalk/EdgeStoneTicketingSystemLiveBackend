const TicketModel = require('../models/ticket');
const logger = require('../utils/logger');
const prisma = require('../models/index');

// ─────────────────────────────────────────────────────────────────────────────
// getVendorEmailsForTicket
// ─────────────────────────────────────────────────────────────────────────────
const getVendorEmailsForTicket = async (ticketId, vendorId = null) => {
    let ticket;
    if (ticketId.startsWith('#')) {
        const tickets = await TicketModel.findAllTickets();
        ticket = tickets.find(t => t.ticketId === ticketId);
    } else {
        ticket = await TicketModel.findTicketById(ticketId);
    }
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

    const VendorModel = require('../models/vendor');

    if (vendorId) {
        const vendor = await VendorModel.findVendorById(vendorId);
        if (vendor && vendor.emails && vendor.emails.length > 0) return vendor.emails;
    }

    let emails = [];
    if (ticket.vendorId) {
        const vendor = await VendorModel.findVendorById(ticket.vendorId);
        if (vendor && vendor.emails) emails = vendor.emails;
    } else if (ticket.circuitId) {
        const circuit = await prisma.circuit.findFirst({
            where: {
                OR: [
                    { customerCircuitId: { equals: ticket.circuitId, mode: 'insensitive' } },
                    { supplierCircuitId: { equals: ticket.circuitId, mode: 'insensitive' } },
                    { id: ticket.circuitId },
                    { vendorCircuits: { some: { supplierCircuitId: { equals: ticket.circuitId, mode: 'insensitive' } } } }
                ]
            },
            include: { vendor: true, vendorCircuits: { include: { vendor: true } } }
        });
        if (circuit) {
            if (vendorId && circuit.vendorCircuits) {
                const vc = circuit.vendorCircuits.find(v => v.vendorId === vendorId);
                if (vc && vc.vendor && vc.vendor.emails) return vc.vendor.emails;
            }
            if (circuit.vendor && circuit.vendor.emails) {
                emails = circuit.vendor.emails;
            } else if (circuit.vendorCircuits && circuit.vendorCircuits.length > 0 && circuit.vendorCircuits[0].vendor?.emails) {
                emails = circuit.vendorCircuits[0].vendor.emails;
            }
        }
    }
    return emails;
};

// ─────────────────────────────────────────────────────────────────────────────
// replyToVendor
// Separated out to isolate vendor routing logic from the primary client ticketing
// ─────────────────────────────────────────────────────────────────────────────
const replyToVendor = async (ticketId, emailData, agentEmail, agentName) => {
    logger.info(`🎟️ [TICKET] 🔄 replyToVendor: Ticket ${ticketId} | Agent: ${agentName}`);

    try {
        const { message, to, cc, bcc, subject, htmlContent, attachments } = emailData;
        logger.info(`🎟️ [TICKET] DEBUG emailData keys: ${Object.keys(emailData).join(', ')}`);
        logger.info(`🎟️ [TICKET] DEBUG htmlContent exists? ${!!htmlContent}`);

        // 1. Fetch the ticket
        let ticket;
        if (ticketId.startsWith('#')) {
            const tickets = await TicketModel.findAllTickets();
            ticket = tickets.find(t => t.ticketId === ticketId);
        } else {
            ticket = await TicketModel.findTicketById(ticketId);
        }
        if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

        let vendorContactEmails = [];
        
        if (to && Array.isArray(to) && to.length > 0) {
            vendorContactEmails = to; // Use frontend provided explicit targets
        } else {
            // Determine vendor email dynamically using getVendorEmailsForTicket (handles vendorId, circuitId, multi-vendor)
            try {
                const resolvedEmails = await getVendorEmailsForTicket(ticket.id, emailData.vendorId);
                if (resolvedEmails && resolvedEmails.length > 0) {
                    vendorContactEmails = resolvedEmails;
                }
            } catch (resolveErr) {
                logger.warn(`⚠️ [TICKET] getVendorEmailsForTicket resolution warning: ${resolveErr.message}`);
            }

            if (vendorContactEmails.length === 0 && process.env.DEFAULT_VENDOR_EMAIL) {
                vendorContactEmails = [process.env.DEFAULT_VENDOR_EMAIL];
            }

            if (vendorContactEmails.length === 0) {
                throw new Error(`No vendor email found for ticket ${ticket.ticketId}. Please make sure the assigned vendor has an email address, or set DEFAULT_VENDOR_EMAIL in .env.`);
            }
        }

        logger.info(`🎟️ [TICKET] 📧 replyToVendor: Sending email to vendor emails: ${vendorContactEmails.join(', ')}`);

        // RULE 1 (P1 CONFIDENTIALITY): Strictly block ANY client email from TO, CC, or BCC on vendor emails,
        // and block any client subject / client circuit ID / client name from ever being sent to a vendor.
        const clientEmails = new Set();
        let clientName = '';
        if (ticket.email && ticket.ticketType !== 'Vendor' && !ticket.isMaintenance) {
            clientEmails.add(ticket.email.toLowerCase().trim());
        }
        if (ticket.clientId) {
            try {
                const ClientModel = require('../models/client');
                const client = await ClientModel.findClientById(ticket.clientId);
                if (client) {
                    if (client.name) clientName = client.name.trim();
                    if (Array.isArray(client.emails)) {
                        client.emails.forEach(e => e && clientEmails.add(e.toLowerCase().trim()));
                    }
                }
            } catch (err) {
                logger.error(`Error loading client emails: ${err.message}`);
            }
        }
        const commonPublicDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'edgestone.in'];
        const clientDomains = Array.from(clientEmails)
            .map(e => e.split('@')[1])
            .filter(d => d && !commonPublicDomains.includes(d.toLowerCase()));

        const isClientPerson = (email) => {
            if (!email) return false;
            const clean = email.toLowerCase().trim();
            if (clientEmails.has(clean)) return true;
            const domain = clean.split('@')[1];
            if (domain && clientDomains.includes(domain)) return true;
            return false;
        };

        vendorContactEmails = Array.from(new Set(vendorContactEmails.map(e => e && e.trim()).filter(Boolean)))
            .filter(email => {
                if (isClientPerson(email)) {
                    logger.warn(`🛑 [RULE-1 VENDOR PRIVACY] Blocked client email "${email}" from vendor TO recipients on Ticket ${ticket.ticketId}`);
                    return false;
                }
                return true;
            });
        if (vendorContactEmails.length === 0) {
            throw new Error(`No valid vendor recipient specified for ticket ${ticket.ticketId}. Please add at least one vendor email address in the 'To' field.`);
        }
        const toLowerSet = new Set(vendorContactEmails.map(e => e.toLowerCase()));

        let visibleVendorCc = [];
        let hiddenVendorBcc = (Array.isArray(bcc) ? [...bcc] : []).filter(email => {
            if (isClientPerson(email)) {
                logger.warn(`🛑 [RULE-1 VENDOR PRIVACY] Stripped client email "${email}" from vendor BCC on Ticket ${ticket.ticketId}`);
                return false;
            }
            return true;
        });

        (cc || []).forEach(email => {
            if (!email) return;
            const clean = email.trim();
            if (isClientPerson(clean)) {
                logger.warn(`🛑 [RULE-1 VENDOR PRIVACY] Stripped client-side recipient "${clean}" from vendor CC on Ticket ${ticket.ticketId}`);
                return;
            }
            if (toLowerSet.has(clean.toLowerCase())) {
                return; // Skip if already present in TO
            }
            if (!visibleVendorCc.includes(clean)) {
                visibleVendorCc.push(clean);
            }
        });

        // Ensure hiddenVendorBcc does not duplicate emails in visible CC
        const ccLowerSet = new Set(visibleVendorCc.map(e => e.toLowerCase()));
        hiddenVendorBcc = Array.from(new Set(hiddenVendorBcc.map(e => e && e.trim()).filter(Boolean)))
            .filter(e => !ccLowerSet.has(e.toLowerCase()));

        const effectiveVendorId = emailData.vendorId || ticket.vendorId;

        // Helper to sanitize outbound vendor subjects:
        // 1. Removes accidental "|me reply|" artifacts
        // 2. Normalizes variant EdgeStone vendor tags like "[1160 V]" or "[#1160 V]" to "[#1160-V]"
        // 3. Collapses duplicate EdgeStone ticket tags (e.g. "[#1157-V] [#1157-V]" or "[#1160-V] [1160 V]" -> "[#1160-V]")
        // 4. Collapses stacked Re:/RE： prefixes around ticket tags (e.g. "RE：[#1082-V] RE：..." -> "Re: [#1082-V] ...")
        // 5. Preserves external vendor tags (e.g. "[M00000-1547]") so Outlook ConversationTopic never breaks!
        const rawTicketNum = String(ticket.ticketId || '').replace(/^#?V?/i, '').trim();
        const escapedNum = rawTicketNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const canonicalVendorTag = `[${ticket.ticketId}-V]`;

        const sanitizeVendorOutboundSubject = (rawSub) => {
            if (!rawSub) return '';
            let s = String(rawSub)
                .replace(/\|\s*me\s*reply\s*\|/gi, '||')
                .replace(/\s+/g, ' ')
                .trim();

            // Strip any leading Re:/RE： prefixes temporarily
            const hasRe = /^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/i.test(s);
            s = s.replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();

            if (escapedNum) {
                // Normalize any variant tag for this ticket (e.g. "[1160 V]", "[#1160 V]", "[1160-V]", "[#1160]") to canonical "[#1160-V]"
                const variantTagRegex = new RegExp(`\\[(?:#V?${escapedNum}(?:[-\\s]+V)?|V?${escapedNum}[-\\s]+V)\\]`, 'gi');
                s = s.replace(variantTagRegex, canonicalVendorTag);

                // Collapse duplicate EdgeStone ticket tags like "[#1157-V] [#1157-V]" or "[#1082-V] RE：[#1082-V]"
                const escapedCanonical = canonicalVendorTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const dupTagRegex = new RegExp(`(${escapedCanonical})(?:\\s*(?:(?:re|fwd|fw|回复|答复|转发)[：:\\s]+)*\\s*${escapedCanonical})+`, 'gi');
                s = s.replace(dupTagRegex, '$1');

                // Also strip any redundant "RE：" immediately following the EdgeStone ticket tag: "[#1082-V] RE：Link..." -> "[#1082-V] Link..."
                const tagFollowedByReRegex = new RegExp(`(${escapedCanonical}\\s*)(?:(?:re|fwd|fw|回复|答复|转发)[：:\\s]+)+`, 'gi');
                s = s.replace(tagFollowedByReRegex, '$1');
            }

            return hasRe ? `Re: ${s}` : s;
        };

        // Resolve circuit record to enforce strict client-circuit confidentiality on vendor emails
        let circuitRecord = null;
        let resolvedSupplierCircuitId = null;
        if (ticket.circuitId) {
            try {
                circuitRecord = await prisma.circuit.findFirst({
                    where: {
                        OR: [
                            { customerCircuitId: { equals: ticket.circuitId, mode: 'insensitive' } },
                            { supplierCircuitId: { equals: ticket.circuitId, mode: 'insensitive' } },
                            { id: ticket.circuitId },
                            { vendorCircuits: { some: { supplierCircuitId: { equals: ticket.circuitId, mode: 'insensitive' } } } }
                        ]
                    },
                    include: { vendorCircuits: true }
                });
                if (circuitRecord) {
                    if (effectiveVendorId && Array.isArray(circuitRecord.vendorCircuits)) {
                        const vc = circuitRecord.vendorCircuits.find(v => v.vendorId === effectiveVendorId);
                        if (vc && vc.supplierCircuitId) resolvedSupplierCircuitId = vc.supplierCircuitId;
                    }
                    if (!resolvedSupplierCircuitId) {
                        resolvedSupplierCircuitId = circuitRecord.supplierCircuitId || null;
                    }
                }
            } catch (_) {}
        }

        // 3.5 Find all message IDs strictly in THIS vendor's thread for RFC 5322 In-Reply-To and References chain
        // RULE 1 (P1): Strictly exclude any reply with type='client' or category='client', and on multi-vendor tickets isolate each vendor's category!
        const isVendorOrMaintTicket = Boolean(ticket.isMaintenance || ticket.ticketType === 'Vendor' || (ticket.ticketId && ticket.ticketId.startsWith('#V')));
        const isMultiVendorCircuit = Boolean(circuitRecord?.isMultiVendor && Array.isArray(circuitRecord?.vendorCircuits) && circuitRecord.vendorCircuits.length > 1);

        const whereClause = {
            ticketId: ticket.id,
            messageId: { not: null },
            type: { not: 'client' },
            OR: effectiveVendorId
                ? (isMultiVendorCircuit
                    ? [{ category: `vendor_${effectiveVendorId}` }]
                    : [
                        { category: { in: ['vendor', `vendor_${effectiveVendorId}`] } },
                        { type: 'vendor' }
                    ])
                : [
                    { category: 'vendor' },
                    { category: { startsWith: 'vendor_' } },
                    { type: 'vendor' }
                ]
        };

        const allVendorReplies = await prisma.reply.findMany({
            where: whereClause,
            orderBy: { createdAt: 'asc' }
        });

        // CRITICAL PRIVACY & THREAD ISOLATION FIX (RULE 1 P1):
        // On a Client ticket (!isVendorOrMaintTicket), ticket.messageId belongs to the CUSTOMER'S confidential root email!
        // Never use ticket.messageId as threadMessageId or in referencesList on a Client ticket, because:
        // 1) MS Graph createReply would reply directly to the customer's email thread / conversationId
        // 2) It would link the vendor email to the customer's email thread headers.
        const lastReply = allVendorReplies.length > 0 ? allVendorReplies[allVendorReplies.length - 1] : null;
        const threadMessageId = (lastReply && lastReply.messageId)
            ? lastReply.messageId.trim()
            : (isVendorOrMaintTicket && ticket.messageId ? ticket.messageId.trim() : null);

        // Helper to check if a candidate subject leaks the customer's confidential Circuit ID or Client Subject Header
        const leaksClientData = (candSub) => {
            if (!candSub || isVendorOrMaintTicket) return false;
            const lowerSub = candSub.toLowerCase();
            const suppId = (resolvedSupplierCircuitId || '').trim().toLowerCase();

            // 1. Check explicit customerCircuitId from Circuit table
            const custId = (circuitRecord?.customerCircuitId || '').trim();
            if (custId && custId.toLowerCase() !== suppId && lowerSub.includes(custId.toLowerCase())) {
                return true;
            }

            // 2. Check if subject contains the customer's root email header (when header doesn't contain supplierCircuitId)
            const cleanTicketHeader = (ticket.header || '').replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();
            if (cleanTicketHeader && cleanTicketHeader.length > 8 && (!suppId || !cleanTicketHeader.toLowerCase().includes(suppId))) {
                if (lowerSub.includes(cleanTicketHeader.toLowerCase())) {
                    return true;
                }
            }

            return false;
        };

        // Determine outbound subject:
        // Ignore any historical vendor reply subject that accidentally contained leaked client data
        const latestVendorReplyWithSub = [...allVendorReplies]
            .reverse()
            .find(r => r.subject && r.subject.trim() && r.subject !== 'null' && !leaksClientData(r.subject));

        let outboundSubject = '';
        if (subject && subject.trim() && !leaksClientData(subject)) {
            const cleanIncomingSub = sanitizeVendorOutboundSubject(subject);
            if (cleanIncomingSub.toLowerCase().includes(ticket.ticketId.toLowerCase())) {
                outboundSubject = cleanIncomingSub.startsWith('Re:') ? cleanIncomingSub : `Re: ${cleanIncomingSub}`;
            } else if (latestVendorReplyWithSub?.subject) {
                outboundSubject = sanitizeVendorOutboundSubject(`Re: ${latestVendorReplyWithSub.subject}`);
            } else {
                outboundSubject = sanitizeVendorOutboundSubject(`Re: [${ticket.ticketId}-V] ${cleanIncomingSub.replace(/^Re:\s*/i, '')}`);
            }
        } else if (latestVendorReplyWithSub?.subject) {
            outboundSubject = sanitizeVendorOutboundSubject(`Re: ${latestVendorReplyWithSub.subject}`);
        } else if (isVendorOrMaintTicket) {
            outboundSubject = sanitizeVendorOutboundSubject(`Re: [${ticket.ticketId}-V] ${(ticket.header || '').replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim()}`);
        } else {
            // Client-raised ticket fallback: NEVER use ticket.header (which contains confidential client subject/circuit ID)!
            const safeCircuitLabel = resolvedSupplierCircuitId || 'Vendor Link';
            outboundSubject = sanitizeVendorOutboundSubject(`Re: [${ticket.ticketId}-V] Issue regarding Circuit ${safeCircuitLabel}`);
        }

        // FINAL HARD GATE (RULE 1 P1): Guaranteed last-line verification that outboundSubject has zero client circuit/header/name
        if (leaksClientData(outboundSubject)) {
            const safeCircuitLabel = resolvedSupplierCircuitId || 'Vendor Link';
            logger.warn(`🛑 [RULE-1 VENDOR PRIVACY] Blocked client data in vendor subject "${outboundSubject}". Enforcing safe vendor subject.`);
            outboundSubject = sanitizeVendorOutboundSubject(`Re: [${ticket.ticketId}-V] Issue regarding Circuit ${safeCircuitLabel}`);
        }

        // 2. Create Reply Record natively mapped to the vendor category (including subject!)
        const reply = await TicketModel.addReply(ticket.id, {
            text: (message !== undefined && message !== null && message.trim() !== '') ? message : (htmlContent || ' '),
            time: new Date().toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }),
            date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
            author: agentName || 'Agent',
            type: 'agent',
            category: effectiveVendorId ? `vendor_${effectiveVendorId}` : 'vendor', // Explicitly marking this thread as vendor-side
            to: vendorContactEmails,
            cc: visibleVendorCc,
            bcc: hiddenVendorBcc,
            subject: outboundSubject,
            attachments: attachments || []
        });

        logger.info(`🎟️ [TICKET] ✅ Vendor Reply added to database for Ticket ${ticket.ticketId}`);

        const emailService = require('./emailService');

        // Build RFC 5322 References chain:
        // ONLY include ticket.messageId if the root ticket itself is a Vendor/Maintenance ticket!
        // Never include a Client ticket's root messageId in vendor References.
        const referencesList = [];
        if (isVendorOrMaintTicket && ticket.messageId && ticket.messageId.trim()) {
            referencesList.push(ticket.messageId.trim());
        }
        for (const rep of allVendorReplies) {
            if (rep.messageId && rep.messageId.trim()) {
                const trimmed = rep.messageId.trim();
                if (!referencesList.includes(trimmed)) {
                    referencesList.push(trimmed);
                }
            }
        }
        if (referencesList.length === 0 && threadMessageId) {
            referencesList.push(threadMessageId);
        }

        const referencesChain = referencesList.join(' ');

        const emailHtml = htmlContent
            ? `
                <div style="font-family: Arial, sans-serif; margin-bottom: 16px;">
                    <p> </p>
                </div>
                ${htmlContent}
              `
            : `
                <div style="font-family: Arial, sans-serif;">
                    <p> </p>
                    <p>${message.replace(/\n/g, '<br>')}</p>
                    <br/>
                    <hr/>
                    <p style="font-size: 12px; color: #666;">${agentName}<br/>EdgeStone NOC / Partner Support</p>
                </div>
            `;

        const sentResult = await emailService.sendAgentReplyEmail({
            to: vendorContactEmails,
            cc: visibleVendorCc,
            bcc: hiddenVendorBcc,
            subject: outboundSubject,
            html: emailHtml,
            text: message || '',
            inReplyTo: threadMessageId, 
            references: referencesChain || threadMessageId,
            attachments: attachments || []
        });

        logger.info(`🎟️ [TICKET] 📤 Vendor reply email successfully routed to ${vendorContactEmails.join(', ')}`);

        // 4. BULLETPROOF THREADING FIX: Save the outbound messageId!
        // When the vendor replies, their email client will include this exact ID in the 'In-Reply-To' header.
        // The backend `findExistingTicketForReply` will securely map it back using this ID, ignoring subject line completely.
        try {
            const outboundMessageId = sentResult?.messageId;
            if (outboundMessageId) {
                await TicketModel.updateReply(reply.id, { messageId: outboundMessageId });
                logger.info(`🎟️ [TICKET] 💾 Saved outbound messageId ${outboundMessageId} to Vendor Reply for structural threading.`);
            }
        } catch (captureErr) {
            logger.warn(`⚠️ 🎟️ [TICKET] ⚠️ Failed to capture vendor outbound messageId: ${captureErr.message}`);
        }

        // Log Activity
        await prisma.activityLog.create({
            data: {
                action: 'vendor_replied',
                description: `Agent ${agentName} replied in the vendor thread to ${vendorContactEmails.join(', ')}.`,
                time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
                author: agentName || 'System',
                ticketId: ticket.id
            }
        });


        return reply;
    } catch (error) {
        logger.error(`🚨 🎟️ [TICKET] ❌ replyToVendor Error: ${error.message}`);
        throw error;
    }
};

module.exports = {
    getVendorEmailsForTicket,
    replyToVendor
};
