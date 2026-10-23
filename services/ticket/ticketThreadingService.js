'use strict';

const prisma = require('../../models/index');
const TicketModel = require('../../models/ticket');
const logger = require('../../utils/logger');

/**
 * Top-level circuit compatibility check (P6 Circuit-First Veto Rule).
 * If an incoming email mentions a registered circuit that differs from the candidate ticket's circuit,
 * it strictly returns false to prevent cross-circuit thread hijacking.
 */
const checkCircuitCompatibility = (ticketCircuitId, detectedCircuit, ticketSubjectId = null) => {
    if (!detectedCircuit) return true; // No registered circuit found in text, cannot veto
    const cleanTgt = (ticketCircuitId || '').toUpperCase().trim();
    const custCkt = (detectedCircuit.customerCircuitId || '').toUpperCase().trim();
    const suppCkt = (detectedCircuit.supplierCircuitId || '').toUpperCase().trim();
    const idCkt = (detectedCircuit.id || '').toUpperCase().trim();

    // Check if ticket circuit matches detected circuit
    if (cleanTgt === custCkt || cleanTgt === suppCkt || cleanTgt === idCkt) {
        return true;
    }

    // If circuit has vendor circuits, check if any supplier circuit matches
    if (detectedCircuit.isMultiVendor && Array.isArray(detectedCircuit.vendorCircuits)) {
        const hasMatch = detectedCircuit.vendorCircuits.some(vc =>
            (vc.supplierCircuitId || '').toUpperCase().trim() === cleanTgt
        );
        if (hasMatch) return true;
    }

    // If ticket has NO circuitId assigned yet, don't veto
    if (!ticketCircuitId) return true;

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
            clientId: true,
            vendorId: true,
            isMultiVendor: true,
            vendorCircuits: { select: { supplierCircuitId: true, vendorId: true } }
        }
    });

    const textToScan = `${subject || ''} \n ${body || ''}`;

    // Token boundary matcher to avoid partial substring collisions
    const matchesCircuitToken = (text, targetId) => {
        if (!text || !targetId) return false;
        const escaped = String(targetId).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?:$|[^a-zA-Z0-9_-])`, 'i');
        return regex.test(text);
    };

    let detectedCircuit = null;
    for (const c of allCircuits) {
        if (c.customerCircuitId && matchesCircuitToken(textToScan, c.customerCircuitId)) {
            detectedCircuit = c;
            break;
        }
        if (c.supplierCircuitId && matchesCircuitToken(textToScan, c.supplierCircuitId)) {
            detectedCircuit = c;
            break;
        }
        if (c.isMultiVendor && Array.isArray(c.vendorCircuits)) {
            const vcMatch = c.vendorCircuits.find(vc => vc.supplierCircuitId && matchesCircuitToken(textToScan, vc.supplierCircuitId));
            if (vcMatch) {
                detectedCircuit = c;
                break;
            }
        }
    }

    // Circuit compatibility check: prevents cross-circuit hijacking between different circuits
    const isCircuitCompatible = (ticketCircuitId, ticketSubjectId = null) =>
        checkCircuitCompatibility(ticketCircuitId, detectedCircuit, ticketSubjectId);

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
                include: { client: true, vendor: true }
            });

            // Enforce circuit compatibility check on Strategy A (Fixes P6)
            if (ticket && isCircuitCompatible(ticket.circuitId, ticket.ticketId)) {
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
                const matchingDocketTicket = await prisma.ticket.findFirst({
                    where: {
                        status: { notIn: ['Spam'] },
                        OR: [
                            { header: { contains: rawDocket, mode: 'insensitive' } },
                            { replies: { some: { text: { contains: rawDocket, mode: 'insensitive' } } } }
                        ]
                    },
                    include: { client: true, vendor: true },
                    orderBy: { createdAt: 'desc' }
                });
                if (matchingDocketTicket && isCircuitCompatible(matchingDocketTicket.circuitId, matchingDocketTicket.ticketId)) {
                    logger.info(`🎟️ [TICKET] 🧵 Reply matched via Vendor TT Docket: "${rawDocket}" → Ticket ${matchingDocketTicket.ticketId}`);
                    return matchingDocketTicket;
                }
            }
        }
    }

    // 1. Strategy B.1: In-Reply-To matches the Original Ticket Message-ID (with circuit isolation guard)
    if (inReplyTo) {
        const cleanId = inReplyTo.trim();
        const ticket = await TicketModel.findTicketByMessageId(cleanId);
        if (ticket && isCircuitCompatible(ticket.circuitId, ticket.ticketId)) {
            logger.info(`🎟️ [TICKET] 🧵 Reply matched via In-Reply-To (Ticket): ${cleanId} → Ticket ${ticket.ticketId}`);
            return ticket;
        }

        // 1.5. Strategy B.2: In-Reply-To matches an Agent Reply Message-ID (with circuit isolation guard)
        const reply = await TicketModel.findReplyByMessageId(cleanId);
        if (reply && reply.ticket && isCircuitCompatible(reply.ticket.circuitId, reply.ticket.ticketId)) {
            logger.info(`🎟️ [TICKET] 🧵 Reply matched via In-Reply-To (Agent Reply): ${cleanId} → Ticket ${reply.ticket.ticketId}`);
            reply.ticket._matchedReply = reply;
            return reply.ticket;
        }
    }

    // 2. References: space/comma-separated chain of parent Message-IDs (with circuit isolation guard)
    if (references) {
        const refIds = (Array.isArray(references) ? references : references.split(/[\s,]+/))
            .map(r => r.trim())
            .filter(Boolean);
        for (const refId of refIds) {
            const ticket = await TicketModel.findTicketByMessageId(refId);
            if (ticket && isCircuitCompatible(ticket.circuitId, ticket.ticketId)) {
                logger.info(`🎟️ [TICKET] 🧵 Reply matched via References (Ticket): ${refId} → Ticket ${ticket.ticketId}`);
                return ticket;
            }
            const reply = await TicketModel.findReplyByMessageId(refId);
            if (reply && reply.ticket && isCircuitCompatible(reply.ticket.circuitId, reply.ticket.ticketId)) {
                logger.info(`🎟️ [TICKET] 🧵 Reply matched via References (Reply): ${refId} → Ticket ${reply.ticket.ticketId}`);
                reply.ticket._matchedReply = reply;
                return reply.ticket;
            }
        }
    }

    // 3. Subject fallback: "Re: <original subject>" or Chinese "RE：<original subject>"
    // STRICT ISOLATION: Must verify Circuit ID and Sender to prevent cross-client hijacking!
    if (subject) {
        const isReplyPattern = /^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/i.test(subject);
        const stripped = subject.replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();
        
        if (stripped && isReplyPattern) {
            const normalizeSubject = (str) => {
                if (!str) return '';
                return str
                    .replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '')
                    .replace(/(?:\[|【)#?[A-Za-z0-9_-]+?(?:-V)?(?:\]|】)\s*/gi, '')
                    .trim()
                    .toLowerCase();
            };

            const targetNormalized = normalizeSubject(stripped);
            const detectedCircuitId = detectedCircuit ? (detectedCircuit.customerCircuitId || detectedCircuit.id) : null;

            const allTickets = await prisma.ticket.findMany({ 
                where: {
                    status: { notIn: ['Spam'] }
                },
                include: { 
                    client: true, 
                    vendor: true,
                    replies: { select: { to: true, cc: true, author: true } }
                },
                orderBy: { createdAt: 'desc' }
            });

            // Helper to check if sender is authorized for this ticket
            const isAuthorizedSender = (t, sender) => {
                if (!sender) return true; // If no sender provided, fallback to circuit/subject matching
                const cleanSender = sender.toLowerCase().trim();
                if (cleanSender.includes('edgestone.in')) return true; // Agent/system is always authorized
                if (t.email && t.email.toLowerCase() === cleanSender) return true;
                if (Array.isArray(t.cc) && t.cc.some(c => c.toLowerCase() === cleanSender)) return true;
                if (t.client && Array.isArray(t.client.emails) && t.client.emails.some(e => e.toLowerCase() === cleanSender)) return true;
                if (t.vendor && Array.isArray(t.vendor.emails) && t.vendor.emails.some(e => e.toLowerCase() === cleanSender)) return true;
                
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

                // Check corporate domain match with client
                if (t.client && Array.isArray(t.client.emails) && cleanSender.includes('@')) {
                    const senderDomain = cleanSender.split('@')[1];
                    const genericDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
                    if (!genericDomains.includes(senderDomain)) {
                        if (t.client.emails.some(e => e.toLowerCase().endsWith('@' + senderDomain))) {
                            return true;
                        }
                    }
                }
                return false;
            };

            let match = null;
            if (detectedCircuit) {
                // If a circuit was detected, ONLY match tickets on THAT specific circuit!
                match = allTickets.find(t =>
                    isCircuitCompatible(t.circuitId, t.ticketId) &&
                    normalizeSubject(t.header) === targetNormalized &&
                    isAuthorizedSender(t, from)
                );
                if (match) {
                    logger.info(`🎟️ [TICKET] 🧵 Reply matched via subject + Circuit ID "${detectedCircuitId}": "${stripped}" → Ticket ${match.ticketId}`);
                }
            } else if (from) {
                // If no circuit in reply, match subject ONLY if sender is verified on this ticket
                match = allTickets.find(t =>
                    normalizeSubject(t.header) === targetNormalized &&
                    isAuthorizedSender(t, from)
                );
                if (match) {
                    logger.info(`🎟️ [TICKET] 🧵 Reply matched via subject + verified sender (${from}): "${stripped}" → Ticket ${match.ticketId}`);
                }
            }

            if (match) {
                return await TicketModel.findTicketById(match.id);
            }
        }
    }

    return null;
};

module.exports = {
    findExistingTicketForReply,
    checkCircuitCompatibility
};
