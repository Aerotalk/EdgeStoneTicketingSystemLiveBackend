'use strict';

const prisma = require('../../models/index');
const TicketModel = require('../../models/ticket');
const ActivityLogModel = require('../../models/activityLog');
const logger = require('../../utils/logger');
const emailSender = require('../email/emailSender');
const { isAutoReplyEnabled } = require('../../utils/emailConfig');

/**
 * Generates the next sequential Ticket ID (e.g. #1025 or #V1025).
 * Queries highest numeric ID in the DB to avoid unique constraint collisions after deletions.
 */
const generateTicketId = async (ticketType = 'Client') => {
    const tickets = await prisma.ticket.findMany({ select: { ticketId: true } });
    
    let maxId = 1000;
    for (const t of tickets) {
        // Extract numeric part from IDs like "#1051" or "#V1052"
        const numMatch = t.ticketId.match(/\d+/);
        if (numMatch) {
            const num = parseInt(numMatch[0], 10);
            if (num > maxId) {
                maxId = num;
            }
        }
    }

    const nextNum = maxId + 1;
    if (ticketType === 'Vendor') {
        return `#V${nextNum}`;
    }
    return `#${nextNum}`;
};

/**
 * Fetches all tickets with replies, client, and vendor models.
 */
const getTickets = async () => {
    logger.debug('🐞 🎟️ [TICKET] 📋 Fetching all tickets...');
    const tickets = await TicketModel.findAllTickets({
        include: {
            replies: {
                orderBy: {
                    createdAt: 'asc'
                }
            },
            client: true,
            vendor: true
        },
        orderBy: {
            createdAt: 'desc'
        }
    });
    logger.debug(`🐞 🎟️ [TICKET] 🔢 Retrieved ${tickets.length} tickets.`);
    return tickets;
};

/**
 * Handles agent replies from the web application, dispatches outbound email via MS Graph,
 * starts the Client SLA clock if applicable, and logs the activity.
 */
const replyToTicket = async (ticketId, message, agentEmail, agentName, htmlContent, attachments, emailOverrides = {}) => {
    logger.info(`🎟️ [TICKET] ↩️ Processing reply to ticket ${ticketId} by ${agentName} (${agentEmail})`);

    try {
        // 1. Find Ticket
        let ticket;
        if (ticketId.startsWith('#')) {
            ticket = await prisma.ticket.findFirst({ where: { ticketId: { equals: ticketId, mode: 'insensitive' } } });
        } else {
            ticket = await TicketModel.findTicketById(ticketId);
        }

        if (!ticket) {
            throw new Error(`Ticket not found: ${ticketId}`);
        }

        const recipientEmails = (emailOverrides.to && Array.isArray(emailOverrides.to) && emailOverrides.to.length > 0) ? emailOverrides.to : [ticket.email];
        const emailSubject = emailOverrides.subject || `Re: [${ticket.ticketId}] ${ticket.header}`;
        const rawCc = (emailOverrides.cc && Array.isArray(emailOverrides.cc)) ? emailOverrides.cc : (Array.isArray(ticket.cc) ? ticket.cc : []);
        const toLowerSet = new Set(recipientEmails.map(e => e && e.toLowerCase().trim()));
        const ccEmails = Array.from(new Set(rawCc.map(e => e && e.trim()).filter(Boolean)))
            .filter(e => !toLowerSet.has(e.toLowerCase()));
        const bccEmails = (emailOverrides.bcc && Array.isArray(emailOverrides.bcc)) ? emailOverrides.bcc : [];

        // 2. Create Reply Record
        const reply = await TicketModel.addReply(ticket.id, {
            text: message,
            time: new Date().toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }),
            date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
            author: agentName || 'Agent',
            type: 'agent',
            category: 'client',
            to: recipientEmails,
            cc: ccEmails,
            bcc: bccEmails,
            subject: emailSubject,
            attachments: attachments || []
        });

        // 2.5 Find all message IDs in the client thread for RFC 5322 In-Reply-To and References chain
        const replies = await prisma.reply.findMany({
            where: { ticketId: ticket.id, messageId: { not: null }, category: 'client' },
            orderBy: { createdAt: 'asc' }
        });

        // Build RFC 5322 References chain:
        // root message ID (ticket.messageId if present) + all reply message IDs up to the current one
        const referencesList = [];
        if (ticket.messageId && ticket.messageId.trim()) {
            referencesList.push(ticket.messageId.trim());
        }
        for (const rep of replies) {
            if (rep.messageId && rep.messageId.trim()) {
                const trimmed = rep.messageId.trim();
                if (!referencesList.includes(trimmed)) {
                    referencesList.push(trimmed);
                }
            }
        }

        const threadMessageId = (replies.length > 0 && replies[replies.length - 1].messageId)
            ? replies[replies.length - 1].messageId.trim()
            : (ticket.messageId ? ticket.messageId.trim() : null);

        if (referencesList.length === 0 && threadMessageId) {
            referencesList.push(threadMessageId);
        }

        const referencesChain = referencesList.join(' ');

        logger.info(`🎟️ [TICKET] ✅ Reply added to database for Ticket ${ticket.ticketId}`);

        // CHG-015: Persist any new CC recipients to ticket.cc
        if (ccEmails && ccEmails.length > 0) {
            try {
                const existingCcs = Array.isArray(ticket.cc) ? ticket.cc : [];
                const mergedCcs = Array.from(new Set([...existingCcs, ...ccEmails].map(e => e.trim().toLowerCase()))).filter(Boolean);
                await prisma.ticket.update({
                    where: { id: ticket.id },
                    data: { cc: { set: mergedCcs } }
                });
                ticket.cc = mergedCcs; // Ensure in-memory ticket has updated CCs
            } catch (ccSaveErr) {
                logger.error(`Failed to update ticket.cc in replyToTicket: ${ccSaveErr.message}`);
            }
        }

        // 3. Send Email to Client via MS Graph
        logger.info(`🎟️ [TICKET] 📧 Sending Agent Reply Email to: ${recipientEmails.join(', ')} | Subject: ${emailSubject}`);

        const baseEmailHtml = htmlContent
            ? htmlContent
            : `<div style="font-family: Arial, sans-serif;">
                <p>${message.replace(/\n/g, '<br>')}</p>
                <br/>
                <hr/>
                <p style="font-size: 12px; color: #666;">${agentName}<br/>EdgeStone Support</p>
               </div>`;

        const finalEmailHtml = baseEmailHtml;
        const finalEmailText = message || '';

        let sentResult = null;
        try {
            sentResult = await emailSender.sendAgentReplyEmail({
                to: recipientEmails,
                cc: ccEmails,
                bcc: bccEmails,
                subject: emailSubject,
                html: finalEmailHtml,
                text: finalEmailText,
                inReplyTo: threadMessageId,
                references: referencesChain || threadMessageId,
                attachments: attachments || []
            });
            logger.info(`🎟️ [TICKET] 📤 Reply email sent to ${recipientEmails.join(', ')}`);
        } catch (emailErr) {
            logger.error(`⚠️ 🎟️ [TICKET] Outbound reply email dispatch warning: ${emailErr.message}`);
        }

        // Try to capture and save the outgoing Message-ID for future reverse-matching
        try {
            const outboundMessageId = sentResult?.messageId;
            if (outboundMessageId) {
                await TicketModel.updateReply(reply.id, { messageId: outboundMessageId });
                logger.info(`🎟️ [TICKET] 💾 Saved outbound messageId ${outboundMessageId} to Reply record for threading.`);
            }
        } catch (captureErr) {
            logger.warn(`⚠️ 🎟️ [TICKET] ⚠️ Failed to capture outbound messageId: ${captureErr.message}`);
        }

        // 4. Log activity
        const now = new Date();
        await ActivityLogModel.createActivityLog({
            ticketId: ticket.id,
            action: 'replied',
            description: `${agentName} replied to the ticket`,
            time: now.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }),
            date: now.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric'
            }),
            author: agentName
        });

        logger.info(`🎟️ [TICKET] 📊 Activity logged: reply by ${agentName}`);

        // --- AUTOMATIC SLA START ON FIRST AGENT REPLY TO CLIENT ---
        // Strict Guard: SLA is NEVER created for Vendor (#V) tickets or tickets with SLA disabled
        const isVendorTicketForClientSla = ticket.ticketId?.startsWith('#V') || ticket.ticketType === 'Vendor';
        if (!isVendorTicketForClientSla && ticket.isSlaActive !== false) {
            try {
                const existingClientSla = await prisma.sLARecord.findFirst({
                    where: { ticketId: ticket.id, type: 'CLIENT' }
                });

                if (!existingClientSla) {
                    const slaStart = new Date();
                    await prisma.sLARecord.create({
                        data: {
                            ticketId: ticket.id,
                            type: 'CLIENT',
                            startDate: slaStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
                            startTime: slaStart.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).replace(/^24:/, '00:'),
                            status: 'Safe',
                            compensation: '-',
                            statusReason: 'Client SLA started'
                        }
                    });
                    logger.info(`⏱️ [SLA] ✨ Client SLA clock started for Ticket ${ticket.ticketId}`);
                }
            } catch (slaErr) {
                logger.warn(`⚠️ ⏱️ [SLA] ⚠️ Failed to start Client SLA: ${slaErr.message}`);
            }
        } else {
            logger.info(`⏱️ [SLA] ℹ️ Skipping Client SLA creation for Ticket ${ticket.ticketId}: SLA disabled for #V/Vendor tickets.`);
        }

        return reply;

    } catch (error) {
        logger.error(`🚨 🎟️ [TICKET] ❌ Error in replyToTicket: ${error.message}`, { stack: error.stack });
        throw error;
    }
};

/**
 * Updates an existing ticket, handles status changes, auto-transitions, circuit assignment,
 * and SLA closure triggers.
 */
const updateTicket = async (ticketId, updates, agentName) => {
    logger.info(`🎟️ [TICKET] 🔄 Updating ticket ${ticketId} by ${agentName}`);
    logger.debug(`🐞 🎟️ [TICKET] Updates: ${JSON.stringify(updates)}`);

    try {
        // 1. Find the ticket
        let ticket;
        if (ticketId.startsWith('#')) {
            ticket = await prisma.ticket.findFirst({ where: { ticketId: { equals: ticketId, mode: 'insensitive' } } });
        } else {
            ticket = await TicketModel.findTicketById(ticketId);
        }

        if (!ticket) {
            throw new Error(`Ticket not found: ${ticketId}`);
        }

        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const dateString = now.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });

        // 2. Determine if we should auto-transition to "In Progress"
        let finalUpdates = { ...updates };

        // Check if ticket is currently "Open" and we're setting circuit/priority
        if (ticket.status === 'Open') {
            const settingCircuit = updates.circuitId && !ticket.circuitId;
            const hasPriority = updates.priority || ticket.priority;

            // Auto-transition to "In Progress" if circuit is being set and priority exists
            if (settingCircuit && hasPriority) {
                finalUpdates.status = 'In Progress';
                logger.info(`🎟️ [TICKET] ✨ Auto-transitioning ticket to "In Progress" (circuit + priority set)`);

                // Log the auto-transition
                await ActivityLogModel.createActivityLog({
                    ticketId: ticket.id,
                    action: 'status_changed',
                    description: `Status automatically changed to "In Progress" (circuit and priority assigned)`,
                    time: timeString,
                    date: dateString,
                    author: agentName,
                    oldValue: ticket.status,
                    newValue: 'In Progress',
                    fieldName: 'status'
                });
            }
        }

        // 3. Log individual field changes & sync client/vendor from circuit if missing
        if (updates.circuitId && updates.circuitId !== ticket.circuitId) {
            const circuit = await prisma.circuit.findFirst({
                where: {
                    OR: [
                        { customerCircuitId: updates.circuitId },
                        { supplierCircuitId: updates.circuitId },
                        { id: updates.circuitId }
                    ]
                }
            });
            if (circuit) {
                if (!ticket.clientId && circuit.clientId) {
                    finalUpdates.clientId = circuit.clientId;
                    logger.info(`🎟️ [TICKET] 🔗 Inherited Client ${circuit.clientId} for Ticket ${ticket.ticketId} from Circuit ${updates.circuitId}`);
                }
                if (!ticket.vendorId && circuit.vendorId) {
                    finalUpdates.vendorId = circuit.vendorId;
                }
            }

            await ActivityLogModel.createActivityLog({
                ticketId: ticket.id,
                action: 'updated',
                description: `Circuit ID ${ticket.circuitId ? 'updated' : 'assigned'}: ${updates.circuitId}`,
                time: timeString,
                date: dateString,
                author: agentName,
                oldValue: ticket.circuitId || 'None',
                newValue: updates.circuitId,
                fieldName: 'circuitId'
            });
        }

        if (updates.priority && updates.priority !== ticket.priority) {
            await ActivityLogModel.createActivityLog({
                ticketId: ticket.id,
                action: 'priority_changed',
                description: `Priority changed from "${ticket.priority}" to "${updates.priority}"`,
                time: timeString,
                date: dateString,
                author: agentName,
                oldValue: ticket.priority,
                newValue: updates.priority,
                fieldName: 'priority'
            });
        }

        // Log manual status change (if different from auto-transition)
        if (updates.status && updates.status !== ticket.status && updates.status !== finalUpdates.status) {
            await ActivityLogModel.createActivityLog({
                ticketId: ticket.id,
                action: 'status_changed',
                description: `Status changed from "${ticket.status}" to "${updates.status}"`,
                time: timeString,
                date: dateString,
                author: agentName,
                oldValue: ticket.status,
                newValue: updates.status,
                fieldName: 'status'
            });
        }

        // 4. Update the ticket
        const updatedTicket = await TicketModel.updateTicket(ticket.id, finalUpdates);

        logger.info(`🎟️ [TICKET] ✅ Ticket ${ticket.ticketId} updated successfully. New status: ${updatedTicket.status}`);

        // --- SLA Engine Integration for Ticket Closure ---
        if (finalUpdates.status === 'Closed' && ticket.status !== 'Closed') {
            try {
                const nowClosed = new Date();
                const closeDate = nowClosed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
                const closedTime = nowClosed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).replace(/^24:/, '00:') + ' hrs';
                
                const slaRecordService = require('../slaRecordService');
                await slaRecordService.updateSLAClosure(ticket.id, closeDate, closedTime);
                logger.info(`🎟️ [TICKET] ✅ SLA records closed successfully for Ticket ${ticket.ticketId}`);
            } catch (slaErr) {
                logger.error(`🚨 🎟️ [TICKET] ❌ Complete SLA Update Lifecycle failed for Ticket ${ticket.ticketId}: ${slaErr.message}`, { stack: slaErr.stack });
            }
        }

        return updatedTicket;

    } catch (error) {
        logger.error(`🚨 🎟️ [TICKET] ❌ Error in updateTicket: ${error.message}`, { stack: error.stack });
        throw error;
    }
};

/**
 * Manually sends an automated acknowledgment reply to specified recipients.
 */
const sendManualAutoReply = async (ticketId, toEmails, agentName = 'System', agentEmail = 'support@edgestone.in') => {
    try {
        if (!isAutoReplyEnabled()) {
            logger.warn(`🎟️ [TICKET] 🛑 Skipped manual auto-reply for Ticket ${ticketId}: Auto-reply is disabled via environment configuration (AUTOREPLY=false)`);
            throw new Error('Auto-reply is disabled via environment configuration (AUTOREPLY=false)');
        }

        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) throw new Error('Ticket not found');
        
        const messageId = ticket.messageId;
        const targetEmails = (toEmails && toEmails.length > 0) ? toEmails : [ticket.email];

        logger.info(`🎟️ [TICKET] 🤖 Sending manual auto-reply to ${targetEmails.join(', ')} for Ticket ${ticket.ticketId}...`);
        
        const sendFn = emailSender.sendAutoReplyEmail || emailSender.sendEmail;
        await sendFn({
            to: targetEmails,
            subject: `Re: [${ticket.ticketId}] ${ticket.header}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <p>Thank you for reaching out to us. We have received your ticket and our team will get back to you as soon as possible.</p>
                    <p>Please note that this is an automated response and this email box is not be monitored.</p>
                    <br/>
                    <p>Sorry for Inconvenience.</p>
                    <hr/>
                    <p style="font-size: 12px; color: #666;">EdgeStone Support Team</p>
                </div>
            `,
            text: `Thank you for reaching out to us. We have received your ticket and our team will get back to you as soon as possible. Please note that this is an automated response and this email box is not be monitored.`,
            inReplyTo: messageId,
            references: messageId
        });
        
        const now = new Date();
        await ActivityLogModel.createActivityLog({
            ticketId: ticket.id,
            action: 'auto_replied',
            description: `Auto-reply manually sent to ${targetEmails.join(', ')}`,
            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            date: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
            author: agentName
        });
        
        logger.info(`🎟️ [TICKET] 📤 Manual Auto-reply sent successfully to ${targetEmails.join(', ')}`);
        
        return ticket;
    } catch (error) {
        logger.error(`🚨 🎟️ [TICKET] ❌ FAILED to send manual auto-reply for Ticket ${ticketId}: ${error.message}`);
        throw error;
    }
};

/**
 * Cascading deletion of a ticket and all its child relations
 * (replies, notes, worknotes, slaRecords, activityLogs, notifications).
 */
const deleteTicket = async (id) => {
    try {
        const cleanId = id.trim();
        const formattedId = cleanId.startsWith('#') ? cleanId : `#${cleanId}`;

        const ticket = await prisma.ticket.findFirst({
            where: {
                OR: [
                    { id: cleanId },
                    { ticketId: cleanId },
                    { ticketId: formattedId }
                ]
            }
        });

        if (!ticket) {
            throw new Error('Ticket not found');
        }

        const targetId = ticket.id;
        logger.info(`🎟️ [TICKET] 🗑️ Commencing cascading deletion of Ticket ${ticket.ticketId} (UUID: ${targetId})`);

        await prisma.reply.deleteMany({ where: { ticketId: targetId } });
        await prisma.note.deleteMany({ where: { ticketId: targetId } });
        await prisma.workNote.deleteMany({ where: { ticketId: targetId } });
        await prisma.sLARecord.deleteMany({ where: { ticketId: targetId } });
        await prisma.activityLog.deleteMany({ where: { ticketId: targetId } });
        await prisma.notification.deleteMany({
            where: {
                OR: [
                    { ticketId: targetId },
                    { ticketId: ticket.ticketId }
                ]
            }
        });

        const deletedTicket = await prisma.ticket.delete({ where: { id: targetId } });
        logger.info(`🎟️ [TICKET] ✅ Ticket ${ticket.ticketId} deleted successfully along with all child records`);
        return deletedTicket;
    } catch (error) {
        logger.error(`🚨 🎟️ [TICKET] ❌ Error deleting ticket ${id}: ${error.message}`, { stack: error.stack });
        throw error;
    }
};

module.exports = {
    generateTicketId,
    getTickets,
    updateTicket,
    replyToTicket,
    sendManualAutoReply,
    deleteTicket
};
