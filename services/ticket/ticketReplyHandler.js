'use strict';

const prisma = require('../../models/index');
const TicketModel = require('../../models/ticket');
const logger = require('../../utils/logger');
const { stripHtml, stripQuotedReply, isEmailMatchingClientDomain } = require('./ticketSanitizer');

// ─────────────────────────────────────────────────────────────────────────────
// appendAgentReplyFromOutlook
// Appends an agent's reply email sent directly from an email client (e.g. Outlook)
// to the ticket's conversation thread so it reflects in the system dashboard.
// ─────────────────────────────────────────────────────────────────────────────
const appendAgentReplyFromOutlook = async (ticket, emailData) => {
    const { from, fromName, body, html, date, messageId, to, cc, subject, attachments } = emailData;
    const emailSentDate = date ? new Date(date) : new Date();

    logger.info(`🎟️ [TICKET] 📩 Appending Agent reply from Outlook to existing Ticket ${ticket.ticketId} from ${from}`);

    let replyText = stripHtml(html || body) || '(No Content)';
    replyText = stripQuotedReply(replyText) || replyText;

    // Duplicate check 1: by messageId
    if (messageId) {
        const dupMessageId = await prisma.reply.findFirst({
            where: { ticketId: ticket.id, messageId }
        });
        if (dupMessageId) {
            logger.info(`🎟️ [TICKET] Reply already recorded in Ticket ${ticket.ticketId} by messageId: ${messageId}`);
            return dupMessageId;
        }
    }

    // Duplicate check 2: by text match against existing replies
    const existingReplies = await prisma.reply.findMany({
        where: { ticketId: ticket.id }
    });
    const dupText = existingReplies.find(r => {
        const cleanRText = r.text.trim();
        return cleanRText && cleanRText.length > 5 && replyText.includes(cleanRText);
    });
    if (dupText) {
        logger.info(`🎟️ [TICKET] Reply content already exists in Ticket ${ticket.ticketId}. Linking messageId.`);
        if (!dupText.messageId && messageId) {
            await prisma.reply.update({
                where: { id: dupText.id },
                data: { messageId }
            });
        }
        return dupText;
    }

    // Determine category: Vendor thread or Client thread based on actual recipients
    let category = 'client';
    const isVendorTag = subject && /\[#?V?\d+-V\]/i.test(subject);
    const toRecips = (Array.isArray(to) ? to : (to ? [to] : [])).map(r => (r || '').toLowerCase().trim());
    const ccRecips = (Array.isArray(cc) ? cc : (cc ? [cc] : [])).map(r => (r || '').toLowerCase().trim());
    const allRecips = [...toRecips, ...ccRecips];

    if (isVendorTag) {
        category = ticket.vendorId ? `vendor_${ticket.vendorId}` : 'vendor';
    } else {
        try {
            const ClientModel = require('../../models/client');
            const VendorModel = require('../../models/vendor');

            // 1. Check if recipients match a registered client
            const clients = await ClientModel.findAllClients();
            const matchedClient = clients.find(c => (c.emails || []).some(e => allRecips.includes(e.toLowerCase().trim())));

            // 2. Check if recipients match a registered vendor
            const vendors = await VendorModel.findAllVendors();
            const matchedVendor = vendors.find(v => (v.emails || []).some(e => allRecips.includes(e.toLowerCase().trim())));

            if (matchedClient && !matchedVendor) {
                category = 'client';
            } else if (matchedVendor && !matchedClient) {
                category = `vendor_${matchedVendor.id}`;
            } else if (ticket.ticketType === 'Vendor') {
                category = ticket.vendorId ? `vendor_${ticket.vendorId}` : 'vendor';
            } else {
                category = 'client';
            }
        } catch (e) {
            logger.error(`Error checking recipient category: ${e.message}`);
            category = ticket.ticketType === 'Vendor' ? (ticket.vendorId ? `vendor_${ticket.vendorId}` : 'vendor') : 'client';
        }
    }

    const reply = await TicketModel.addReply(ticket.id, {
        text: replyText,
        time: emailSentDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'Asia/Kolkata'
        }),
        date: emailSentDate.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'Asia/Kolkata'
        }),
        author: fromName || 'EdgeStone Support',
        type: 'agent',
        category: category,
        to: Array.isArray(to) ? to : (to ? [to] : []),
        cc: Array.isArray(cc) ? cc : (cc ? [cc] : []),
        subject: subject || null,
        messageId: messageId || null,
        attachments: attachments || []
    });

    // Log activity
    const ActivityLogModel = require('../../models/activityLog');
    const now = new Date();
    await ActivityLogModel.createActivityLog({
        ticketId: ticket.id,
        action: 'replied',
        description: `${fromName || 'Agent'} replied to the ticket via Outlook email`,
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }),
        date: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
        author: fromName || from
    });

    logger.info(`🎟️ [TICKET] ✅ Agent Outlook reply appended to Ticket ${ticket.ticketId}`);

    try {
        const notificationService = require('../notificationService');
        await notificationService.sendNotification({
            type: 'agent_reply',
            title: 'Ticket Update (Outlook Reply)',
            message: `${fromName || 'Agent'} replied to Ticket ${ticket.ticketId} via Outlook`,
            ticketId: ticket.ticketId,
            sender: 'agent'
        });
    } catch(err) {
        logger.error(`Notification Error: ${err.message}`);
    }

    return reply;
};

// ─────────────────────────────────────────────────────────────────────────────
// appendClientReplyToTicket
// Appends a client's reply email to an existing ticket's conversation thread.
// Does NOT send another auto-reply (client already has the ticket open).
// ─────────────────────────────────────────────────────────────────────────────
const appendClientReplyToTicket = async (ticket, emailData) => {
    const { from, fromName, body, html, date } = emailData;
    const emailReceivedDate = date ? new Date(date) : new Date();

    logger.info(`🎟️ [TICKET] 📩 Appending client reply to existing Ticket ${ticket.ticketId} from ${from}`);

    let replyText = stripHtml(html || body) || '(No Content)';
    replyText = stripQuotedReply(replyText) || replyText; // fallback if stripping removes everything somehow

    const toList = [from];
    if (Array.isArray(emailData.to)) {
        emailData.to.forEach(e => {
            const clean = e && e.trim().toLowerCase();
            if (clean && clean !== from.toLowerCase() && !toList.some(x => x.toLowerCase() === clean)) {
                toList.push(e.trim());
            }
        });
    }

    const reply = await TicketModel.addReply(ticket.id, {
        text: replyText,
        time: emailReceivedDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }),
        date: emailReceivedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        author: fromName || from,
        type: 'client',
        category: 'client',
        to: toList,
        cc: emailData.cc || [],
        subject: emailData.subject || null,
        messageId: emailData.messageId || null,
        attachments: emailData.attachments || []
    });

    // Log activity
    const ActivityLogModel = require('../../models/activityLog');
    const now = new Date();
    await ActivityLogModel.createActivityLog({
        ticketId: ticket.id,
        action: 'client_replied',
        description: `Client ${fromName || from} replied to the ticket via email`,
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        date: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        author: fromName || from,
    });

    // Update ticket.cc if incoming email has CCs/TOs or comes from a new participant
    try {
        const VendorModel = require('../../models/vendor');
        const ClientModel = require('../../models/client');

        // Load all vendors to block vendor emails and vendor domains from leaking into client CCs
        const allVendors = await VendorModel.findAllVendors();
        const allVendorEmails = new Set(allVendors.flatMap(v => (v.emails || []).map(e => e.toLowerCase().trim())));
        const publicDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'edgestone.in'];
        const vendorDomains = Array.from(allVendorEmails)
            .map(e => e.split('@')[1])
            .filter(d => d && !publicDomains.includes(d.toLowerCase()));

        const vendorNameTokens = new Set();
        for (const v of allVendors) {
            if (v.name) {
                const cleanName = v.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (cleanName.length > 3) {
                    vendorNameTokens.add(cleanName);
                }
            }
        }

        const isVendorPerson = (email) => {
            if (!email) return false;
            const clean = email.toLowerCase().trim();
            if (allVendorEmails.has(clean)) return true;
            const domain = clean.split('@')[1];
            if (domain) {
                if (vendorDomains.includes(domain)) return true;
                for (const token of vendorNameTokens) {
                    if (domain.includes(token)) return true;
                }
            }
            return false;
        };

        const allOtherClients = ticket.clientId ? (await ClientModel.findAllClients()).filter(c => c.id !== ticket.clientId) : [];
        const allOtherClientEmails = new Set(allOtherClients.flatMap(c => (c.emails || []).map(e => e.toLowerCase().trim())));

        const existingCcs = Array.isArray(ticket.cc) ? ticket.cc : [];
        const incomingCcs = Array.isArray(emailData.cc) ? emailData.cc : [];
        const incomingTos = (Array.isArray(emailData.to) ? emailData.to : []).filter(e => {
            const clean = e && e.toLowerCase().trim();
            return clean && !clean.includes('edgestone.in') && clean !== ticket.email?.toLowerCase();
        });
        const newParticipants = [...existingCcs, ...incomingCcs, ...incomingTos];
        if (from && from.toLowerCase() !== ticket.email?.toLowerCase() && !from.toLowerCase().includes('edgestone.in')) {
            newParticipants.push(from);
        }

        // STRICT SEGREGATION: Never allow vendor emails or foreign client emails to be added to client ticket.cc!
        const mergedCcs = Array.from(new Set(newParticipants.map(e => e.trim().toLowerCase()))).filter(e => {
            if (!e || e === ticket.email?.toLowerCase()) return false;
            if (isVendorPerson(e) || allOtherClientEmails.has(e)) return false;
            return true;
        });
        
        const existingSet = new Set(existingCcs.map(e => e.trim().toLowerCase()));
        const hasChanged = mergedCcs.length !== existingCcs.length || mergedCcs.some(e => !existingSet.has(e));

        if (hasChanged) {
            await prisma.ticket.update({
                where: { id: ticket.id },
                data: { cc: { set: mergedCcs } }
            });
            ticket.cc = mergedCcs; // Ensure in-memory ticket object is updated
            logger.info(`🎟️ [TICKET] 👥 Updated ticket CC list for Ticket ${ticket.ticketId}: ${mergedCcs.join(', ')}`);
        }

        // Auto-register new client email contacts into Client database
        // STRICT ISOLATION: Prevent adding vendors or contacts of other clients
        if (ticket.clientId) {
            const client = await prisma.client.findUnique({ where: { id: ticket.clientId } });
            if (client) {
                const currentEmails = Array.isArray(client.emails) ? client.emails : [];
                const newEmailsToAdd = [];
                const candidates = [from, ...incomingCcs, ...incomingTos];

                candidates.forEach(email => {
                    const clean = email && email.trim().toLowerCase();
                    if (clean && !clean.includes('edgestone.in') && !isVendorPerson(clean) && !allOtherClientEmails.has(clean)) {
                        if (isEmailMatchingClientDomain(clean, client)) {
                            if (!currentEmails.some(e => e.toLowerCase() === clean) && !newEmailsToAdd.some(e => e.toLowerCase() === clean)) {
                                newEmailsToAdd.push(email.trim());
                            }
                        } else {
                            logger.warn(`🛑 [CLIENT] Refused to auto-register contact ${email} into ${client.name} in reply: Domain does not match client's corporate domain.`);
                        }
                    }
                });
                if (newEmailsToAdd.length > 0) {
                    await prisma.client.update({
                        where: { id: ticket.clientId },
                        data: { emails: [...currentEmails, ...newEmailsToAdd] }
                    });
                    logger.info(`👤 [CLIENT] ➕ Auto-registered new client contact emails for ${client.name}: ${newEmailsToAdd.join(', ')}`);
                }
            }
        }
    } catch (ccErr) {
        logger.error(`Failed to update ticket.cc / client.emails in appendClientReplyToTicket: ${ccErr.message}`);
    }

    logger.info(`🎟️ [TICKET] ✅ Client reply appended to Ticket ${ticket.ticketId}`);
    try {
        const notificationService = require('../notificationService');
        const isClosed = ticket.status && ticket.status.toLowerCase() === 'closed';
        const senderLabel = 'Client';
        const senderName = fromName || from;

        if (isClosed) {
            await notificationService.sendNotification({
                type: 'closed_ticket_reply',
                title: `Closed Ticket Reply (${senderLabel})`,
                message: `${senderLabel} (${senderName}) replied to closed Ticket ${ticket.ticketId}. Please review and reopen if needed.`,
                ticketId: ticket.ticketId,
                sender: 'client'
            });
        } else {
            await notificationService.sendNotification({
                type: 'client_reply',
                title: ticket.isMaintenance ? `Client Maintenance Reply (${ticket.ticketId})` : 'Ticket Update',
                message: `${senderLabel} (${senderName}) replied to Ticket ${ticket.ticketId}`,
                ticketId: ticket.ticketId,
                sender: 'client'
            });
        }
    } catch(err) { logger.error(`Notification Error: ${err.message}`) }
    return reply;
};

// ─────────────────────────────────────────────────────────────────────────────
// appendVendorReplyToTicket
// Appends a vendor's reply email to an existing ticket's vendor thread.
// ─────────────────────────────────────────────────────────────────────────────
const appendVendorReplyToTicket = async (ticket, emailData, vendorId = null, isMultiVendor = false) => {
    const { from, fromName, body, html, date } = emailData;
    const emailReceivedDate = date ? new Date(date) : new Date();

    logger.info(`📝 [TICKET] 📥 Appending vendor reply to existing Ticket ${ticket.ticketId} from ${from}`);

    let replyText = stripHtml(html || body) || '(No Content)';
    replyText = stripQuotedReply(replyText) || replyText;

    const toList = [from];
    if (Array.isArray(emailData.to)) {
        emailData.to.forEach(e => {
            const clean = e && e.trim().toLowerCase();
            if (clean && clean !== from.toLowerCase() && !toList.some(x => x.toLowerCase() === clean)) {
                toList.push(e.trim());
            }
        });
    }

    let finalCategory = 'vendor';
    if (vendorId) {
        const isVendorTicket = ticket.ticketType === 'Vendor' || (ticket.ticketId && ticket.ticketId.startsWith('#V')) || ticket.isMaintenance;
        if (isMultiVendor || isVendorTicket) {
            finalCategory = `vendor_${vendorId}`;
        } else {
            // Check if ticket or circuit is multi-vendor or has prior replies for vendor_${vendorId}
            try {
                let isMulti = false;
                if (ticket.circuitId) {
                    const ckt = await prisma.circuit.findFirst({
                        where: { OR: [ { customerCircuitId: ticket.circuitId }, { supplierCircuitId: ticket.circuitId }, { id: ticket.circuitId } ] },
                        include: { vendorCircuits: true }
                    });
                    if (ckt && (ckt.isMultiVendor || (ckt.vendorCircuits && ckt.vendorCircuits.length > 0))) {
                        isMulti = true;
                    }
                }
                if (!isMulti) {
                    const existingRep = await prisma.reply.findFirst({
                        where: { ticketId: ticket.id, category: `vendor_${vendorId}` }
                    });
                    if (existingRep) isMulti = true;
                }
                if (isMulti) {
                    finalCategory = `vendor_${vendorId}`;
                }
            } catch (_) {}
        }
    }

    const reply = await TicketModel.addReply(ticket.id, {
        text: replyText,
        time: emailReceivedDate.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }),
        date: emailReceivedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        author: fromName || from,
        type: 'vendor',
        category: finalCategory,
        to: toList,
        cc: emailData.cc || [],
        subject: emailData.subject || null,
        messageId: emailData.messageId || null,
        attachments: emailData.attachments || []
    });

    // Auto-register new vendor email contacts into Vendor database
    if (vendorId) {
        try {
            const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
            if (vendor) {
                const currentEmails = Array.isArray(vendor.emails) ? vendor.emails : [];
                const clientCcs = Array.isArray(ticket.cc) ? ticket.cc.map(c => c.toLowerCase().trim()) : [];
                const clientEmail = ticket.email ? ticket.email.toLowerCase().trim() : null;
                const newEmailsToAdd = [];

                const candidates = [from, ...(emailData.to || []), ...(emailData.cc || [])];
                candidates.forEach(email => {
                    const clean = email && email.trim().toLowerCase();
                    if (clean && !clean.includes('edgestone.in') && clean !== clientEmail && !clientCcs.includes(clean)) {
                        if (!currentEmails.some(e => e.toLowerCase() === clean) && !newEmailsToAdd.some(e => e.toLowerCase() === clean)) {
                            newEmailsToAdd.push(email.trim());
                        }
                    }
                });

                if (newEmailsToAdd.length > 0) {
                    await prisma.vendor.update({
                        where: { id: vendorId },
                        data: { emails: [...currentEmails, ...newEmailsToAdd] }
                    });
                    logger.info(`🏢 [VENDOR] ➕ Auto-registered new vendor contact emails for ${vendor.name}: ${newEmailsToAdd.join(', ')}`);
                }
            }
        } catch (vErr) {
            logger.error(`Failed to update vendor.emails in appendVendorReplyToTicket: ${vErr.message}`);
        }
    }

    // Log activity
    const ActivityLogModel = require('../../models/activityLog');
    const now = new Date();
    await ActivityLogModel.createActivityLog({
        ticketId: ticket.id,
        action: 'vendor_replied',
        description: `Vendor ${fromName || from} replied to the ticket via email`,
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        date: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        author: fromName || from,
    });

    logger.info(`🎟️ [TICKET] ✅ Vendor reply appended to Ticket ${ticket.ticketId}`);
    try {
        const notificationService = require('../notificationService');
        const isClosed = ticket.status && ticket.status.toLowerCase() === 'closed';
        const senderName = fromName || from;

        if (isClosed) {
            await notificationService.sendNotification({
                type: 'closed_ticket_reply',
                title: 'Closed Ticket Reply (Vendor)',
                message: `Vendor (${senderName}) replied to closed Ticket ${ticket.ticketId}. Please review and reopen if needed.`,
                ticketId: ticket.ticketId,
                sender: 'vendor'
            });
        } else {
            await notificationService.sendNotification({
                type: 'vendor_reply',
                title: 'Ticket Update',
                message: `Vendor (${senderName}) replied to Ticket ${ticket.ticketId}`,
                ticketId: ticket.ticketId,
                sender: 'vendor'
            });
        }
    } catch(err) { logger.error(`Notification Error: ${err.message}`) }

    // --- AUTOMATIC SLA START ON FIRST VENDOR REPLY ---
    // Strict Guard: SLA is NEVER created for Vendor (#V) tickets or tickets with SLA disabled
    const isVendorTicketForSla = ticket.ticketId?.startsWith('#V') || ticket.ticketType === 'Vendor';
    if (!isVendorTicketForSla && ticket.isSlaActive !== false) {
        try {
            const existingVendorSla = await prisma.sLARecord.findFirst({
                where: { ticketId: ticket.id, type: 'VENDOR' }
            });

            if (!existingVendorSla) {
                const slaStart = new Date();
                await prisma.sLARecord.create({
                    data: {
                        ticketId: ticket.id,
                        type: 'VENDOR',
                        startDate: slaStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
                        startTime: slaStart.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).replace(/^24:/, '00:'),
                        status: 'Safe',
                        compensation: '-',
                        statusReason: 'Vendor SLA started on first vendor reply'
                    }
                });
                logger.info(`⏱️ [SLA] ✨ Vendor SLA clock started for Ticket ${ticket.ticketId}`);
            }
        } catch (slaErr) {
            logger.warn(`⚠️ ⏱️ [SLA] ⚠️ Failed to start Vendor SLA: ${slaErr.message}`);
        }
    } else {
        logger.info(`⏱️ [SLA] ℹ️ Skipping Vendor SLA creation for Ticket ${ticket.ticketId}: SLA disabled for #V/Vendor tickets.`);
    }

    return reply;
};

module.exports = {
    appendAgentReplyFromOutlook,
    appendClientReplyToTicket,
    appendVendorReplyToTicket
};
