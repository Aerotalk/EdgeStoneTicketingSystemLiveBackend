'use strict';

const prisma = require('../../models/index');
const TicketModel = require('../../models/ticket');
const logger = require('../../utils/logger');
const SmartSorter = require('./smartTicketSorter');
const { stripHtml, normalizeCircuitId, extractMaintenanceMetadata, extractTokensFromCircuitId } = require('./ticketSanitizer');

/**
 * Top-level circuit compatibility check (P6 Circuit-First Veto Rule).
 * If an incoming email mentions a registered circuit that differs from the candidate ticket's circuit,
 * it strictly returns false to prevent cross-circuit thread hijacking.
 */
const checkCircuitCompatibility = (ticketCircuitId, detectedCircuit, ticketSubjectId = null) => {
    if (!detectedCircuit) return true; // No registered circuit found in text, cannot veto
    const cleanTgt = (ticketCircuitId || '').toUpperCase().trim();
    const normTgt = normalizeCircuitId(ticketCircuitId);
    const custCkt = (detectedCircuit.customerCircuitId || '').toUpperCase().trim();
    const suppCkt = (detectedCircuit.supplierCircuitId || '').toUpperCase().trim();
    const poCkt = (detectedCircuit.supplierPoNumber || '').toUpperCase().trim();
    const idCkt = (detectedCircuit.id || '').toUpperCase().trim();

    // Check if ticket circuit matches detected circuit directly
    if (cleanTgt && (cleanTgt === custCkt || cleanTgt === suppCkt || cleanTgt === poCkt || cleanTgt === idCkt)) {
        return true;
    }

    // Normalized circuit comparison (stripping temp / original / new prefixes and normalizing whitespace/hyphens)
    if (normTgt && (
        normTgt === normalizeCircuitId(custCkt) ||
        normTgt === normalizeCircuitId(suppCkt) ||
        normTgt === normalizeCircuitId(poCkt)
    )) {
        return true;
    }

    // Check against all extracted component tokens of customerCircuitId, supplierCircuitId, supplierPoNumber
    if (cleanTgt) {
        const allDetectedTokens = [
            ...extractTokensFromCircuitId(detectedCircuit.customerCircuitId),
            ...extractTokensFromCircuitId(detectedCircuit.supplierCircuitId),
            ...extractTokensFromCircuitId(detectedCircuit.supplierPoNumber)
        ].map(t => t.toUpperCase().trim());
        const allNormTokens = allDetectedTokens.map(t => normalizeCircuitId(t));
        if (allDetectedTokens.includes(cleanTgt) || (normTgt && allNormTokens.includes(normTgt))) {
            return true;
        }
    }

    // If circuit has vendor circuits, check if any supplier circuit matches
    if (detectedCircuit.isMultiVendor && Array.isArray(detectedCircuit.vendorCircuits)) {
        const hasMatch = detectedCircuit.vendorCircuits.some(vc => {
            const vcTokens = extractTokensFromCircuitId(vc.supplierCircuitId).map(t => t.toUpperCase().trim());
            const vcNormTokens = vcTokens.map(t => normalizeCircuitId(t));
            return (vc.supplierCircuitId || '').toUpperCase().trim() === cleanTgt ||
                (normTgt && normalizeCircuitId(vc.supplierCircuitId) === normTgt) ||
                vcTokens.includes(cleanTgt) ||
                (normTgt && vcNormTokens.includes(normTgt));
        });
        if (hasMatch) return true;
    }

    // If ticket has NO circuitId assigned, it CANNOT match an incoming email that explicitly mentions a specific circuit!
    if (!ticketCircuitId) {
        if (detectedCircuit) {
            logger.warn(`🚫 [P6 CIRCUIT VETO] Rejected ticket candidate ${ticketSubjectId || ''} (Ticket has no CircuitId) because incoming email explicitly mentions Circuit "${detectedCircuit.customerCircuitId || detectedCircuit.supplierCircuitId}".`);
            return false;
        }
        return true;
    }

    // P6 STRICT VETO: A different circuit ID mentioned in text VETOES merging into this ticket!
    // Even if subject has [#TicketId], user is reporting an issue on a different circuit.
    logger.warn(`🚫 [P6 CIRCUIT VETO] Rejected ticket candidate ${ticketSubjectId || ''} (Circuit "${ticketCircuitId}") because incoming email explicitly mentions a DIFFERENT Circuit "${detectedCircuit.customerCircuitId || detectedCircuit.supplierCircuitId}". A separate ticket will be created.`);
    return false;
};

/**
 * Finds an existing Ticket that this incoming email is replying to.
 * Uses a multi-stage reverse-matching engine with strict circuit isolation guards.
 *
 * CRITICAL RULE (P6 Fix):
 * If an incoming email explicitly mentions Circuit B, it will NEVER merge into
 * a ticket belonging to Circuit A — even if the customer clicked "Reply" on an email
 * containing [#TicketA] or has In-Reply-To headers pointing to Ticket A.
 */
const findExistingTicketForReply = async (inReplyTo, references, subject, body = '', from = null) => {
    // ── PRE-FLIGHT: EXTRACT MENTIONED CIRCUITS & ENFORCE CIRCUIT ISOLATION ──
    const allCircuits = await prisma.circuit.findMany({
        select: {
            id: true,
            customerCircuitId: true,
            supplierCircuitId: true,
            supplierPoNumber: true,
            clientId: true,
            vendorId: true,
            isMultiVendor: true,
            vendorCircuits: {
                select: {
                    id: true,
                    supplierCircuitId: true,
                    supplierPoNumber: true,
                    vendorId: true,
                    vendor: { select: { id: true, name: true, emails: true } }
                }
            }
        }
    });

    const cleanBody = stripHtml(body || '');
    const textToScan = `${subject || ''} \n ${cleanBody} \n ${body || ''}`;

    // Token boundary matcher to avoid partial substring collisions
    const matchesCircuitToken = (text, targetId) => {
        if (!text || !targetId) return false;
        const escaped = String(targetId).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?:$|[^a-zA-Z0-9_-])`, 'i');
        return regex.test(text);
    };

    let detectedCircuit = null;
    for (const c of allCircuits) {
        const checkId = (id) => {
            const tokens = extractTokensFromCircuitId(id);
            return tokens.some(tok => matchesCircuitToken(textToScan, tok));
        };

        if (c.customerCircuitId && checkId(c.customerCircuitId)) {
            detectedCircuit = c;
            break;
        }
        if (c.supplierCircuitId && checkId(c.supplierCircuitId)) {
            detectedCircuit = c;
            break;
        }
        if (c.supplierPoNumber && checkId(c.supplierPoNumber)) {
            detectedCircuit = c;
            break;
        }
        if (c.isMultiVendor && Array.isArray(c.vendorCircuits)) {
            const vcMatch = c.vendorCircuits.find(vc => vc.supplierCircuitId && checkId(vc.supplierCircuitId));
            if (vcMatch) {
                detectedCircuit = c;
                break;
            }
        }
    }

    // Circuit compatibility check: prevents cross-circuit hijacking between different circuits
    const isCircuitCompatible = (ticketCircuitId, ticketSubjectId = null) =>
        checkCircuitCompatibility(ticketCircuitId, detectedCircuit, ticketSubjectId);

    // All barrier rules (maintenance / client-support / recency / schedule isolation) live in the Smart Ticket Sorter.
    const MIN_OPERATIONAL_DATE = SmartSorter.MIN_OPERATIONAL_DATE;
    const sorterCtx = { subject, body, isCircuitCompatible };

    // Unified Double-Checking Validator: Ensures thread integrity and eliminates wrong routing of replies
    const isValidReplyCandidate = (candidateTicket, ticketSubjectId = null) =>
        SmartSorter.isValidReplyCandidate(candidateTicket, {
            ...sorterCtx,
            isCircuitCompatible: (circuitId, label) => isCircuitCompatible(circuitId, ticketSubjectId || label)
        });

    const candidateInclude = {
        client: true,
        vendor: true,
        replies: { select: { id: true, subject: true, text: true, to: true, cc: true, author: true, category: true, type: true } }
    };

    // 0. Strategy A: Subject regex extraction (Most Reliable)
    // Supports [#1234], [1234], [#V1234], [V1234], [#1234-V], [1234-V], [#TEST-MV-1234], and Chinese brackets 【#1234】
    if (subject) {
        const ticketIdMatch = subject.match(/(?:\[|【)#?([A-Za-z0-9_-]+?)(?:-V)?(?:\]|】)/i);
        if (ticketIdMatch && ticketIdMatch[1]) {
            const rawId = ticketIdMatch[1];
            const friendlyId = (rawId.startsWith('#') ? rawId : '#' + rawId).toUpperCase();
            const alternateId = friendlyId.startsWith('#V')
                ? '#' + friendlyId.substring(2)
                : (friendlyId.startsWith('#') ? '#V' + friendlyId.substring(1) : '#V' + friendlyId);

            const ticket = await prisma.ticket.findFirst({
                where: {
                    OR: [
                        { ticketId: { equals: friendlyId, mode: 'insensitive' } },
                        { ticketId: { equals: alternateId, mode: 'insensitive' } }
                    ]
                },
                include: candidateInclude
            });

            // Enforce circuit compatibility check on Strategy A (Fixes P6), Recency Window, Maintenance Barrier, and Client Support Barrier
            if (ticket && isValidReplyCandidate(ticket, ticket.ticketId)) {
                logger.info(`🎟️ [TICKET] 🧵 Reply matched via Subject ID: ${friendlyId} → Ticket ${ticket.ticketId}`);
                if (inReplyTo || references) {
                    try {
                        const refCandidates = [
                            inReplyTo ? inReplyTo.trim() : null,
                            ...(Array.isArray(references) ? references : (references ? references.split(/[\s,]+/) : []))
                        ].filter(Boolean);

                        for (const ref of refCandidates) {
                            const clean = ref.replace(/[<>]/g, '').trim();
                            const parentRep = await TicketModel.findReplyByMessageId(ref) ||
                                              await TicketModel.findReplyByMessageId(`<${clean}>`) ||
                                              await TicketModel.findReplyByMessageId(clean);
                            if (parentRep && parentRep.ticketId === ticket.id) {
                                ticket._matchedReply = parentRep;
                                logger.info(`🎟️ [TICKET] 🔗 Attached parent reply ${parentRep.id} (category: ${parentRep.category}, type: ${parentRep.type}) to ticket ${ticket.ticketId}`);
                                break;
                            }
                        }
                    } catch (refErr) {
                        logger.warn(`Failed to resolve parent reply on subject match: ${refErr.message}`);
                    }
                }
                return ticket;
            }
        }
    }

    // 0.5 Strategy A.2: Vendor Trouble Ticket / Docket Number match (e.g. EN_IM_03092026_170954, CU#2608150173, INC000011658869, TT#123456)
    // STRICT GUARD: Must require at least 4 digits! NEVER match English words like "TT for", "TT to", "TT is"!
    if (subject || body) {
        const docketMatch = textToScan.match(/\b(EN_IM_\d+_\d+|CU#\d{4,}|INC\d{5,}|(?:TT|Docket|Ticket|Case|SR)\s*#?[:\s-]*\d{4,}[A-Za-z0-9_-]*)\b/i);
        if (docketMatch && docketMatch[1]) {
            const rawDocket = docketMatch[1].trim();
            const hasDigits = /\d{4,}/.test(rawDocket);
            if (hasDigits) {
                const matchingDocketCandidates = await prisma.ticket.findMany({
                    where: {
                        status: { notIn: ['Spam'] },
                        createdAt: { gte: MIN_OPERATIONAL_DATE },
                        OR: [
                            { header: { contains: rawDocket, mode: 'insensitive' } },
                            { replies: { some: { OR: [
                                { subject: { contains: rawDocket, mode: 'insensitive' } },
                                { text: { contains: rawDocket, mode: 'insensitive' } }
                            ] } } }
                        ]
                    },
                    include: candidateInclude,
                    orderBy: { createdAt: 'asc' }
                });
                let matchingDocketTicket = matchingDocketCandidates.find(t => isValidReplyCandidate(t, t.ticketId));
                if (
                    matchingDocketTicket &&
                    matchingDocketTicket.ticketType === 'Vendor' &&
                    !SmartSorter.isFormalMaintenanceNotice(matchingDocketTicket.header || '', '') &&
                    detectedCircuit
                ) {
                    const rootClientCandidates = await prisma.ticket.findMany({
                        where: {
                            ticketType: 'Client',
                            status: { notIn: ['Spam', 'Closed', 'Resolved'] },
                            createdAt: { gte: MIN_OPERATIONAL_DATE, lte: matchingDocketTicket.createdAt }
                        },
                        include: candidateInclude,
                        orderBy: { createdAt: 'asc' }
                    });
                    const parentClientTicket = rootClientCandidates.find(t => isValidReplyCandidate(t, t.ticketId));
                    if (parentClientTicket) {
                        logger.info(`🎟️ [TICKET] 🔀 Promoted Vendor TT Docket match "${rawDocket}" from split Vendor Ticket ${matchingDocketTicket.ticketId} to root Client Incident Ticket ${parentClientTicket.ticketId}`);
                        matchingDocketTicket = parentClientTicket;
                    }
                }
                if (matchingDocketTicket) {
                    logger.info(`🎟️ [TICKET] 🧵 Reply matched via Vendor TT Docket: "${rawDocket}" → Ticket ${matchingDocketTicket.ticketId}`);
                    return matchingDocketTicket;
                }
            }
        }
    }

    // 0.6 Strategy A.3: Maintenance CRQ / UMW / RPO / Reference match (e.g. CRQ: 1100494638, U4584\26F, R7023\26E, INC000011680956)
    if (subject || body) {
        const meta = extractMaintenanceMetadata(subject, body);
        const crqMatch = textToScan.match(/\b(CRQ[:\s“"'-]*\d{6,}[A-Za-z0-9_-]*|(?:UMW|RPO)\s*Reference(?:\s*Number|\s*No)?[\s:"]*([A-Za-z0-9\\/_-]+)|INC\d{6,})\b/i);
        const searchRef = meta.crqId || (crqMatch && (crqMatch[2] || crqMatch[1]?.match(/\d{6,}/)?.[0] || crqMatch[1]?.trim()));
        if (searchRef && searchRef.length >= 4) {
            const maintCandidates = await prisma.ticket.findMany({
                where: {
                    status: { notIn: ['Spam', 'Closed', 'Resolved'] },
                    createdAt: { gte: MIN_OPERATIONAL_DATE },
                    OR: [
                        { header: { contains: searchRef, mode: 'insensitive' } },
                        { replies: { some: { OR: [
                            { subject: { contains: searchRef, mode: 'insensitive' } },
                            { text: { contains: searchRef, mode: 'insensitive' } }
                        ] } } }
                    ]
                },
                include: candidateInclude,
                orderBy: { createdAt: 'asc' } // Root ticket first!
            });
            const matchingMaintTicket = maintCandidates.find(t => isValidReplyCandidate(t, t.ticketId));
            if (matchingMaintTicket) {
                logger.info(`🎟️ [TICKET] 🧵 Reply matched via Maintenance CRQ/Ref: "${searchRef}" → Ticket ${matchingMaintTicket.ticketId}`);
                return matchingMaintTicket;
            }
        }
    }

    // 1. Strategy B.1: In-Reply-To matches the Original Ticket Message-ID (with circuit & schedule isolation guard)
    if (inReplyTo) {
        const cleanId = inReplyTo.trim();
        const ticket = await TicketModel.findTicketByMessageId(cleanId);
        if (ticket && isValidReplyCandidate(ticket, ticket.ticketId)) {
            logger.info(`🎟️ [TICKET] 🧵 Reply matched via In-Reply-To (Ticket): ${cleanId} → Ticket ${ticket.ticketId}`);
            return ticket;
        }

        // 1.5. Strategy B.2: In-Reply-To matches an Agent/Vendor/Client Reply Message-ID (with circuit & schedule isolation guard)
        const reply = await TicketModel.findReplyByMessageId(cleanId);
        if (reply && reply.ticket) {
            const fullTicket = await TicketModel.findTicketById(reply.ticket.id) || reply.ticket;
            if (isValidReplyCandidate(fullTicket, fullTicket.ticketId)) {
                logger.info(`🎟️ [TICKET] 🧵 Reply matched via In-Reply-To (Reply): ${cleanId} → Ticket ${fullTicket.ticketId}`);
                fullTicket._matchedReply = reply;
                return fullTicket;
            }
        }
    }

    // 2. References: space/comma-separated chain of parent Message-IDs (with circuit & schedule isolation guard)
    if (references) {
        const refIds = (Array.isArray(references) ? references : references.split(/[\s,]+/))
            .map(r => r.trim())
            .filter(Boolean);
        for (const refId of refIds) {
            const ticket = await TicketModel.findTicketByMessageId(refId);
            if (ticket && isValidReplyCandidate(ticket, ticket.ticketId)) {
                logger.info(`🎟️ [TICKET] 🧵 Reply matched via References (Ticket): ${refId} → Ticket ${ticket.ticketId}`);
                return ticket;
            }
            const reply = await TicketModel.findReplyByMessageId(refId);
            if (reply && reply.ticket) {
                const fullTicket = await TicketModel.findTicketById(reply.ticket.id) || reply.ticket;
                if (isValidReplyCandidate(fullTicket, fullTicket.ticketId)) {
                    logger.info(`🎟️ [TICKET] 🧵 Reply matched via References (Reply): ${refId} → Ticket ${fullTicket.ticketId}`);
                    fullTicket._matchedReply = reply;
                    return fullTicket;
                }
            }
        }
    }

    // 3. Subject & Circuit Continuation Fallback
    // STRICT ISOLATION: Must verify Circuit ID, Sender, Business Process, and Maintenance Date/CRQ compatibility!
    if (subject) {
        const isReplyPattern =
            /^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/i.test(subject) ||
            !SmartSorter.isRootEmail({ inReplyTo, references, subject, body });
        const stripped = subject.replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();

        if (stripped && (isReplyPattern || detectedCircuit)) {
            const normalizeSubject = (str) => {
                if (!str) return '';
                return str
                    .replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '')
                    .replace(/(?:\[|【)#?[A-Za-z0-9_-]+?(?:-V)?(?:\]|】)\s*/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();
            };

            const targetNormalized = normalizeSubject(stripped);
            const detectedCircuitId = detectedCircuit ? (detectedCircuit.customerCircuitId || detectedCircuit.id) : null;

            const allTickets = await prisma.ticket.findMany({
                where: {
                    status: { notIn: ['Spam', 'Closed', 'Resolved'] }
                },
                include: candidateInclude,
                orderBy: { createdAt: 'asc' } // Root ticket first!
            });

            // Helper to check if sender is authorized for this ticket
            const isAuthorizedSender = (t, sender) => {
                if (!sender) return true;
                const cleanSender = sender.toLowerCase().trim();
                if (cleanSender.includes('edgestone.in')) return true;
                if (t.email && t.email.toLowerCase() === cleanSender) return true;
                if (Array.isArray(t.cc) && t.cc.some(c => c.toLowerCase() === cleanSender)) return true;
                if (t.client && Array.isArray(t.client.emails) && t.client.emails.some(e => e.toLowerCase() === cleanSender)) return true;
                if (t.vendor && Array.isArray(t.vendor.emails) && t.vendor.emails.some(e => e.toLowerCase() === cleanSender)) return true;

                // Check multi-vendor circuit vendor contacts & corporate domains
                if (detectedCircuit && Array.isArray(detectedCircuit.vendorCircuits)) {
                    for (const vc of detectedCircuit.vendorCircuits) {
                        if (vc.vendor && Array.isArray(vc.vendor.emails)) {
                            if (vc.vendor.emails.some(e => e.toLowerCase() === cleanSender)) return true;
                        }
                    }
                }

                // Check if sender belongs to the detected circuit's client or vendor (even if ticket.vendorId wasn't populated yet)
                if (cleanSender.includes('@')) {
                    const senderDomain = cleanSender.split('@')[1];
                    const genericDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
                    if (!genericDomains.includes(senderDomain)) {
                        if (t.client && Array.isArray(t.client.emails) && t.client.emails.some(e => e.toLowerCase().endsWith('@' + senderDomain))) {
                            return true;
                        }
                        if (t.vendor && Array.isArray(t.vendor.emails) && t.vendor.emails.some(e => e.toLowerCase().endsWith('@' + senderDomain))) {
                            return true;
                        }
                        if (detectedCircuit && Array.isArray(detectedCircuit.vendorCircuits)) {
                            for (const vc of detectedCircuit.vendorCircuits) {
                                if (vc.vendor && Array.isArray(vc.vendor.emails) && vc.vendor.emails.some(e => e.toLowerCase().endsWith('@' + senderDomain))) {
                                    return true;
                                }
                            }
                        }
                    }
                }

                // Check if sender was added as a recipient or author in any prior replies on this ticket
                if (Array.isArray(t.replies)) {
                    const isParticipantInReplies = t.replies.some(r => {
                        if (r.author && r.author.toLowerCase().includes(cleanSender)) return true;
                        if (Array.isArray(r.to) && r.to.some(toEmail => toEmail.toLowerCase().trim() === cleanSender)) return true;
                        if (Array.isArray(r.cc) && r.cc.some(ccEmail => ccEmail.toLowerCase().trim() === cleanSender)) return true;
                        return false;
                    });
                    if (isParticipantInReplies) return true;
                }

                return false;
            };

            const isSubjectThreadMatch = (candNorm, incomingNorm) => {
                if (!candNorm || !incomingNorm) return false;
                if (candNorm === incomingNorm) return true;
                // Handle vendor ticketing systems that append their docket/reference to the end of our subject
                // (e.g. "... 29th Oct'2026 YJ2026102900253 2610290101111180" or "... | Neutrality.One #213877")
                const minLen = Math.min(candNorm.length, incomingNorm.length);
                if (minLen >= 18 && (incomingNorm.startsWith(candNorm) || candNorm.startsWith(incomingNorm))) {
                    return true;
                }
                return false;
            };

            const subjectMatchesTicketOrReply = (t) => {
                if (isSubjectThreadMatch(normalizeSubject(t.header), targetNormalized)) return true;
                if (Array.isArray(t.replies)) {
                    const matchedRep = t.replies.find(r => r.subject && isSubjectThreadMatch(normalizeSubject(r.subject), targetNormalized));
                    if (matchedRep) {
                        t._matchedReply = matchedRep;
                        return true;
                    }
                }
                return false;
            };

            const isEligibleActiveIncidentTicket = (t) => {
                if (!t.circuitId || !isValidReplyCandidate(t, t.ticketId)) return false;
                if (!t.isMaintenance && ['Open', 'In Progress'].includes(t.status)) return true;
                // Handle Client incident tickets that were historically mis-tagged with status='Maintenance'
                if (t.ticketType === 'Client' && t.isSlaActive && SmartSorter.hasStrictIncidentSignal(t.header || '', '') && !['Closed', 'Resolved', 'Spam'].includes(t.status)) {
                    return true;
                }
                return false;
            };

            let match = null;
            if (detectedCircuit) {
                // 3a. Subject match (exact or vendor-suffix prefix match) on ticket header or prior reply subject for this circuit
                match = allTickets.find(t =>
                    isValidReplyCandidate(t, t.ticketId) &&
                    subjectMatchesTicketOrReply(t) &&
                    isAuthorizedSender(t, from)
                );
                if (match) {
                    logger.info(`🎟️ [TICKET] 🧵 Reply matched via subject + Circuit ID "${detectedCircuitId}": "${stripped}" → Ticket ${match.ticketId}`);
                }
            } else if (from && isReplyPattern) {
                // 3b. No circuit in reply: match subject ONLY if sender is verified on this ticket
                match = allTickets.find(t =>
                    isValidReplyCandidate(t, t.ticketId) &&
                    subjectMatchesTicketOrReply(t) &&
                    isAuthorizedSender(t, from)
                );
                if (match) {
                    logger.info(`🎟️ [TICKET] 🧵 Reply matched via subject + verified sender (${from}): "${stripped}" → Ticket ${match.ticketId}`);
                }
            }

            // 3c. Strategy D: Circuit Continuation Match
            // If this is a continuation email on a detected circuit (or an EdgeStone agent incident/escalation email for that circuit)
            // and passes all schedule/CRQ/maintenance/client-support/business-process barriers, route to the matching active ticket on that circuit.
            if (!match && detectedCircuit && (isReplyPattern || (from && from.toLowerCase().includes('edgestone.in')))) {
                const incomingMeta = extractMaintenanceMetadata(subject, body);
                const isIncomingMaint = SmartSorter.isFormalMaintenanceNotice(subject, body) || SmartSorter.hasMaintenanceSignal(subject, body);
                const isIncomingRebate = SmartSorter.isSlaRebateOrCommercialEmail(subject, body);

                // First priority: match a ticket on this circuit with the exact same CRQ/UMW/RPO or scheduled maintenance date
                if (!isIncomingRebate && (incomingMeta.crqId || incomingMeta.maintDate)) {
                    match = allTickets.find(t => {
                        if (!t.circuitId || !isValidReplyCandidate(t, t.ticketId)) return false;
                        const candMeta = SmartSorter.extractCandidateMaintenanceMeta(t);
                        const sameCrq = incomingMeta.crqId && candMeta.crqId && incomingMeta.crqId.toUpperCase() === candMeta.crqId.toUpperCase();
                        const sameDate = incomingMeta.maintDate && candMeta.maintDate && incomingMeta.maintDate === candMeta.maintDate;
                        return sameCrq || sameDate;
                    });
                    if (match) {
                        logger.info(`🎟️ [TICKET] 🧵 Continuation matched via Circuit "${detectedCircuitId}" + Maintenance Schedule/Ref (${incomingMeta.crqId || incomingMeta.maintDate}) → Ticket ${match.ticketId}`);
                    }
                }

                // Second priority: non-root continuation on active circuit ticket (when not a conflicting maintenance notice or SLA rebate)
                if (!match && isReplyPattern && !SmartSorter.isFormalMaintenanceNotice(subject, body) && !isIncomingRebate) {
                    match = allTickets.find(t => isEligibleActiveIncidentTicket(t));
                    if (match) {
                        logger.info(`🎟️ [TICKET] 🧵 Continuation email from ${from} matched active ticket on Circuit "${detectedCircuitId}": "${stripped}" → Ticket ${match.ticketId}`);
                    }
                }

                // Third priority: internal agent email regarding active incident ticket
                // Must have incident context (e.g. escalating link flap/down to vendor) and NEVER match SLA rebate/commercial or maintenance notices!
                if (!match && from && from.toLowerCase().includes('edgestone.in') && !isIncomingMaint && !isIncomingRebate && SmartSorter.hasIncidentSignal(subject, body)) {
                    match = allTickets.find(t => isEligibleActiveIncidentTicket(t));
                    if (match) {
                        logger.info(`🎟️ [TICKET] 🧵 Agent email from ${from} matched active ticket on Circuit "${detectedCircuitId}": "${stripped}" → Ticket ${match.ticketId}`);
                    }
                }
            }

            if (match) {
                const fullTicket = await TicketModel.findTicketById(match.id);
                if (fullTicket && match._matchedReply) {
                    fullTicket._matchedReply = match._matchedReply;
                }
                return fullTicket;
            }
        }
    }

    return null;
};

module.exports = {
    findExistingTicketForReply,
    checkCircuitCompatibility
};
