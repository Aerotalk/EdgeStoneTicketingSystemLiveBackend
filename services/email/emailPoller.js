'use strict';

const logger = require('../../utils/logger');
const { getGraphAccessToken, isGraphIdProcessed, markGraphIdProcessed } = require('./graphClient');
const { fetchMessageAttachments } = require('./emailAttachmentService');
const { isInternalAgentEmail } = require('../ticket/ticketSanitizer');

let isPolling = false;
let graphPollInterval = null;
let lastPolledAt = null;
let lastPollError = null;
let pollerActive = false;

const markEmailAsRead = async (messageId, accessToken) => {
    const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;
    const url = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${messageId}`;
    await fetch(url, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true })
    });
};

const { FRESH_TICKET_MIN_DATE: MIN_LIVE_DATE } = require('../ticket/smartTicketSorter'); // 28th Oct 2026 00:00 IST cutoff

const syncSentItemsEmails = async (accessToken, userEmail) => {
    try {
        const ticketService = require('../ticketService');
        const sentUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/sentitems/messages?$top=15&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,body,sentDateTime,internetMessageHeaders,hasAttachments&$orderby=sentDateTime desc`;
        const sentRes = await fetch(sentUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (!sentRes.ok) return;

        const sentData = await sentRes.json();
        const messages = sentData.value || [];

        for (const msg of messages) {
            const messageId = msg.internetMessageId || msg.id;
            if (isGraphIdProcessed(msg.id) || (msg.internetMessageId && isGraphIdProcessed(msg.internetMessageId))) {
                continue;
            }

            // Discard stale sent messages from before 28th Oct (minimizes live deployment window)
            const sentDate = msg.sentDateTime ? new Date(msg.sentDateTime) : null;
            if (sentDate && sentDate < MIN_LIVE_DATE) {
                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                continue;
            }

            const subject = msg.subject || '';
            const subjectLower = subject.toLowerCase();

            // Ignore system automated notifications (e.g. ticket creation acknowledgment)
            if (subjectLower.startsWith('ticket received:') || subjectLower.startsWith('ticket created:') || subjectLower.startsWith('new ticket assigned:')) {
                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                continue;
            }

            const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
            const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;
            const fromAddr = msg.from?.emailAddress?.address || userEmail;
            const fromName = msg.from?.emailAddress?.name || fromAddr;

            // Check if this sent message matches an existing ticket
            let existingTicket = await ticketService.findExistingTicketForReply(inReplyToHeader, referencesHeader, subject, msg.body?.content, fromAddr);
            if (!existingTicket) {
                // Check if this outbound email from agent was sent regarding an active maintenance circuit
                try {
                    const prisma = require('../../models/index');
                    const textScan = `${subject || ''} ${msg.body?.content || ''}`.toUpperCase();
                    const isIncidentContext = /(?:flap|flapping|down|outage|rfo|issue|fault|alarm|los|degraded|packet\s*loss)/i.test(`${subject || ''} ${msg.body?.content || ''}`);
                    const isMaintContext = /(?:emergency|planned|scheduled|urgent)?\s*maint(?:en|ain)[ae]nce/i.test(`${subject || ''} ${msg.body?.content || ''}`);
                    if (isMaintContext && !isIncidentContext) {
                        const allActiveMaintTickets = await prisma.ticket.findMany({
                            where: { 
                                OR: [ { isMaintenance: true }, { status: 'Maintenance' } ],
                                status: { notIn: ['Closed', 'Resolved'] },
                                createdAt: { gte: MIN_LIVE_DATE }
                            },
                            include: { replies: { select: { text: true, subject: true } } },
                            orderBy: { createdAt: 'desc' }
                        });
                        const outboundMeta = ticketService.extractMaintenanceMetadata(subject, msg.body?.content);

                        for (const amt of allActiveMaintTickets) {
                            if (amt.circuitId && textScan.includes(amt.circuitId.toUpperCase())) {
                                const hasCompletion = (amt.replies || []).some(r => /(?:successfully\s*completed|activity\s*completed|maintenance\s*completed)/i.test(r.text || ''));
                                if (hasCompletion) continue; // Skip completed maintenance

                                const amtMeta = ticketService.extractMaintenanceMetadata(amt.header, (amt.replies || []).map(r => `${r.subject || ''} ${r.text || ''}`).join(' '));
                                if (outboundMeta.crqId && amtMeta.crqId && outboundMeta.crqId.toUpperCase() !== amtMeta.crqId.toUpperCase()) {
                                    continue; // Different CRQ, do not link to old ticket!
                                }
                                if (outboundMeta.maintDate && amtMeta.maintDate && outboundMeta.maintDate !== amtMeta.maintDate) {
                                    continue; // Different scheduled date window, do not link to old ticket!
                                }

                                existingTicket = amt;
                                logger.info(`[EMAIL] 📤 Linked outbound agent maintenance email from Outlook to active Maintenance Ticket ${amt.ticketId} for circuit ${amt.circuitId}`);
                                break;
                            }
                        }
                    }
                } catch (_) {}
            }

            if (!existingTicket) {
                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                continue;
            }

            // Extract text to see if it was already created from the EdgeStone portal
            const cleanText = ticketService.stripQuotedReply(ticketService.stripHtml(msg.body?.content || '')) || '';
            const prisma = require('../../models/index');
            const existingReplies = await prisma.reply.findMany({
                where: { ticketId: existingTicket.id }
            });

            const alreadyRecorded = existingReplies.some(r => {
                if (r.messageId && msg.internetMessageId && r.messageId === msg.internetMessageId) return true;
                const cleanR = (r.text || '').trim();
                return cleanR.length > 5 && cleanText.includes(cleanR);
            });

            if (alreadyRecorded) {
                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                continue;
            }

            // This is a new outgoing agent reply sent directly from Outlook!
            logger.info(`[EMAIL] 📤 Found new Agent reply from Outlook in Sent Items for Ticket ${existingTicket.ticketId}`);
            
            const attachments = await fetchMessageAttachments(msg.id, msg.hasAttachments, accessToken, userEmail);
            const toRecips = msg.toRecipients ? msg.toRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
            const ccRecips = msg.ccRecipients ? msg.ccRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];

            await ticketService.appendAgentReplyFromOutlook(existingTicket, {
                from: fromAddr,
                fromName: fromName,
                to: toRecips,
                cc: ccRecips,
                subject: subject,
                body: msg.body?.content || '',
                html: msg.body?.contentType === 'html' ? msg.body?.content : null,
                date: msg.sentDateTime ? new Date(msg.sentDateTime) : new Date(),
                messageId: messageId,
                attachments
            });

            markGraphIdProcessed(msg.id);
            if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
        }
    } catch (sentErr) {
        logger.error(`[EMAIL] Sent Items Sync Error: ${sentErr.message}`);
    }
};

/**
 * Handles Non-Delivery Reports (NDR) / bounces from postmaster or mailer-daemon.
 * Extracts failed recipient email, identifies originating ticket, logs activity, and alerts agents.
 */
const handleSystemBounce = async (msg, accessToken) => {
    try {
        const ticketService = require('../ticketService');
        const ActivityLogModel = require('../../models/activityLog');
        const notificationService = require('../notificationService');

        const bodyContent = msg.body?.content || '';
        const subject = msg.subject || '';
        const combinedText = `${subject} ${bodyContent}`;

        // 1. Extract failed recipient email
        let failedEmail = null;
        const prefixMatch = combinedText.match(/(?:couldn['’]?t be delivered to|failed recipients?|was unable to deliver.*?to the following addresses:?|Final-Recipient:\s*rfc822;\s*|recipient\s*address:?)\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/i);
        if (prefixMatch && prefixMatch[1]) {
            failedEmail = prefixMatch[1].replace(/[<>]/g, '').trim().toLowerCase();
        } else {
            const allEmails = combinedText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g) || [];
            const ownEmail = (process.env.SENDER_EMAIL || process.env.MAIL_USER || '').toLowerCase();
            for (const em of allEmails) {
                const clean = em.replace(/[<>]/g, '').trim().toLowerCase();
                if (!clean.includes('postmaster') && !clean.includes('mailer-daemon') && !clean.includes('microsoft') && clean !== ownEmail) {
                    failedEmail = clean;
                    break;
                }
            }
        }

        // 2. Extract bounce diagnostic reason if present
        let diagnosticCode = 'Undeliverable / Mailbox rejected';
        const diagMatch = combinedText.match(/(?:Remote Server returned|Diagnostic-Code:.*?|Diagnostic explanation:?)\s*['"]?([^\r\n<]+)/i) ||
            combinedText.match(/(?:5\d{2}\s+5\.\d+\.\d+[^<\r\n]+)/i);
        if (diagMatch && diagMatch[1]) {
            diagnosticCode = diagMatch[1].trim().substring(0, 150);
        } else if (diagMatch && diagMatch[0]) {
            diagnosticCode = diagMatch[0].trim().substring(0, 150);
        }

        // 3. Find matching ticket via headers or subject
        const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
        const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;

        const ticket = await ticketService.findExistingTicketForReply(
            inReplyToHeader,
            referencesHeader,
            subject,
            bodyContent,
            msg.from?.emailAddress?.address
        );

        if (ticket) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

            const alertText = `⚠️ Delivery Failure: Email to ${failedEmail || 'recipient'} could not be delivered. Reason: ${diagnosticCode}`;

            // Create activity log
            await ActivityLogModel.createActivityLog({
                ticketId: ticket.id,
                action: 'delivery_failure',
                description: alertText,
                time: timeStr,
                date: dateStr,
                author: 'Mailer Daemon'
            });

            // Emit live notification to agents
            try {
                await notificationService.sendNotification({
                    type: 'delivery_failure',
                    title: `⚠️ Delivery Failed (${ticket.ticketId})`,
                    message: `Outbound email to ${failedEmail || 'recipient'} bounced: ${diagnosticCode}`,
                    ticketId: ticket.ticketId,
                    sender: 'system'
                });
            } catch (_) {}

            logger.warn(`🚨 [BOUNCE] NDR detected for Ticket ${ticket.ticketId} | Failed recipient: ${failedEmail} | Reason: ${diagnosticCode}`);
        } else {
            logger.warn(`🚨 [BOUNCE] Unmatched NDR received | Failed recipient: ${failedEmail || 'unknown'} | Subject: ${subject}`);
        }
    } catch (err) {
        logger.error(`[BOUNCE] Error processing NDR bounce: ${err.message}`);
    }
};

const fetchNewGraphEmails = async () => {
    if (isPolling) return;
    isPolling = true;

    try {
        const ticketService = require('../ticketService');
        const accessToken = await getGraphAccessToken();
        const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;
        const messagesUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/inbox/messages?$filter=isRead eq false&$top=20&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,body,receivedDateTime,internetMessageHeaders,hasAttachments`;

        const response = await fetch(messagesUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (response.ok) {
            const result = await response.json();
            const messages = result.value || [];
            const ownEmail = (process.env.SENDER_EMAIL || process.env.MAIL_USER || '').toLowerCase();

            for (const msg of messages) {
                const messageId = msg.internetMessageId || msg.id;
                const fromAddr = msg.from?.emailAddress?.address;
                const fromName = msg.from?.emailAddress?.name || fromAddr;

                // Discard stale incoming emails from before 28th Oct (minimizes live deployment window)
                const msgDate = msg.receivedDateTime ? new Date(msg.receivedDateTime) : null;
                if (msgDate && msgDate < MIN_LIVE_DATE) {
                    logger.info(`[EMAIL] ⏭️ Discarding stale inbox email from before 28th Oct: "${msg.subject}" (${msgDate.toISOString()})`);
                    await markEmailAsRead(msg.id, accessToken);
                    markGraphIdProcessed(msg.id);
                    if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                    continue;
                }

                if (!fromAddr) {
                    await markEmailAsRead(msg.id, accessToken);
                    continue;
                }

                const isAgentSender = await isInternalAgentEmail(fromAddr);
                const isOwnEmail = (ownEmail && fromAddr.toLowerCase() === ownEmail) || isAgentSender;
                const isSystemBounce = fromAddr.toLowerCase().includes('postmaster') ||
                    fromAddr.toLowerCase().includes('mailer-daemon') ||
                    /^(?:undeliverable|delivery\s*status\s*notification|mail\s*delivery\s*failed)/i.test(msg.subject || '');

                if (isSystemBounce) {
                    await handleSystemBounce(msg, accessToken);
                    await markEmailAsRead(msg.id, accessToken);
                    continue;
                }

                const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
                const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;

                // If internal agent or own mailbox sends a message into Inbox (e.g. self-CC or loopback):
                if (isOwnEmail) {
                    let existingTicket = await ticketService.findExistingTicketForReply(inReplyToHeader, referencesHeader, msg.subject, msg.body?.content, fromAddr);

                    // Fallback: If not matched by headers/subject, check if this agent email references an active maintenance or circuit ticket
                    if (!existingTicket) {
                        try {
                            const prisma = require('../../models/index');
                            const textScan = `${msg.subject || ''} \n ${msg.body?.content || ''}`.toUpperCase();

                            // 1. Check if agent email is regarding an active Maintenance ticket
                            const isIncidentContext = /(?:flap|flapping|down|outage|rfo|issue|fault|alarm|los|degraded|packet\s*loss)/i.test(textScan);
                            const isMaintContext = /(?:emergency|planned|scheduled|urgent)?\s*maint(?:en|ain)[ae]nce/i.test(textScan);
                            if (isMaintContext && !isIncidentContext) {
                                const allActiveMaintTickets = await prisma.ticket.findMany({
                                    where: { 
                                        OR: [ { isMaintenance: true }, { status: 'Maintenance' } ],
                                        status: { notIn: ['Closed', 'Resolved', 'Spam'] },
                                        createdAt: { gte: MIN_LIVE_DATE }
                                    },
                                    include: { replies: { select: { text: true, subject: true } } },
                                    orderBy: { createdAt: 'desc' }
                                });
                                const outboundMeta = ticketService.extractMaintenanceMetadata(msg.subject, msg.body?.content);

                                for (const amt of allActiveMaintTickets) {
                                    if (amt.circuitId && textScan.includes(amt.circuitId.toUpperCase())) {
                                        const hasCompletion = (amt.replies || []).some(r => /(?:successfully\s*completed|activity\s*completed|maintenance\s*completed)/i.test(r.text || ''));
                                        if (hasCompletion) continue; // Skip completed maintenance

                                        const amtMeta = ticketService.extractMaintenanceMetadata(amt.header, (amt.replies || []).map(r => `${r.subject || ''} ${r.text || ''}`).join(' '));
                                        if (outboundMeta.crqId && amtMeta.crqId && outboundMeta.crqId.toUpperCase() !== amtMeta.crqId.toUpperCase()) {
                                            continue; // Different CRQ, do not link to old ticket!
                                        }
                                        if (outboundMeta.maintDate && amtMeta.maintDate && outboundMeta.maintDate !== amtMeta.maintDate) {
                                            continue; // Different scheduled date window, do not link to old ticket!
                                        }

                                        existingTicket = amt;
                                        logger.info(`[EMAIL] 📤 Linked incoming agent maintenance email from ${fromAddr} to active Maintenance Ticket ${amt.ticketId} for circuit ${amt.circuitId}`);
                                        break;
                                    }
                                }
                            }

                            // 2. Check if agent email references an active normal/incident ticket on circuit
                            if (!existingTicket) {
                                const circuits = await prisma.circuit.findMany({
                                    select: { id: true, customerCircuitId: true, supplierCircuitId: true, isMultiVendor: true, vendorCircuits: true }
                                });
                                const matchesCircuitToken = (txt, targetId) => {
                                    if (!txt || !targetId) return false;
                                    const escaped = String(targetId).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?:$|[^a-zA-Z0-9_-])`, 'i');
                                    return regex.test(txt);
                                };

                                for (const c of circuits) {
                                    const hasCkt = (c.customerCircuitId && matchesCircuitToken(textScan, c.customerCircuitId)) ||
                                                   (c.supplierCircuitId && matchesCircuitToken(textScan, c.supplierCircuitId)) ||
                                                   (c.isMultiVendor && Array.isArray(c.vendorCircuits) && c.vendorCircuits.some(vc => vc.supplierCircuitId && matchesCircuitToken(textScan, vc.supplierCircuitId)));
                                    if (hasCkt) {
                                        const normBase = (id) => String(id || '').replace(/^(?:original|temp|temporary|old|new)[\s-_:]+/i, '').trim();
                                        const baseCust = normBase(c.customerCircuitId);

                                        const activeTicket = await prisma.ticket.findFirst({
                                            where: {
                                                OR: [
                                                    { circuitId: c.customerCircuitId },
                                                    { circuitId: c.supplierCircuitId },
                                                    { circuitId: c.id },
                                                    ...(baseCust ? [
                                                        { circuitId: baseCust },
                                                        { circuitId: `temp-${baseCust}` },
                                                        { circuitId: `original-${baseCust}` }
                                                    ] : [])
                                                ],
                                                status: { notIn: ['Closed', 'Resolved', 'Spam'] },
                                                createdAt: { gte: MIN_LIVE_DATE }
                                            },
                                            orderBy: { createdAt: 'desc' },
                                            include: { client: true, vendor: true }
                                        });

                                        if (activeTicket) {
                                            existingTicket = activeTicket;
                                            logger.info(`[EMAIL] 📤 Linked incoming agent email from ${fromAddr} to active Ticket ${activeTicket.ticketId} on circuit ${c.customerCircuitId || c.supplierCircuitId}`);
                                            break;
                                        }
                                    }
                                }
                            }
                        } catch (cErr) {
                            logger.error(`Error finding circuit ticket for agent email: ${cErr.message}`);
                        }
                    }

                    if (existingTicket && !isGraphIdProcessed(msg.id)) {
                        markGraphIdProcessed(msg.id);
                        if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                        const attachments = await fetchMessageAttachments(msg.id, msg.hasAttachments, accessToken, userEmail);
                        const toRecips = msg.toRecipients ? msg.toRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
                        const ccRecips = msg.ccRecipients ? msg.ccRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
                        await ticketService.appendAgentReplyFromOutlook(existingTicket, {
                            from: fromAddr,
                            fromName: fromName,
                            to: toRecips,
                            cc: ccRecips,
                            subject: msg.subject || '(No Subject)',
                            body: msg.body?.content || '',
                            html: msg.body?.contentType === 'html' ? msg.body?.content : null,
                            date: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
                            messageId: messageId,
                            attachments
                        });
                    } else if (!existingTicket) {
                        logger.info(`[EMAIL] ℹ️ Ignored unlinked email from EdgeStone agent (${fromAddr}): Agents cannot create new tickets.`);
                    }

                    await markEmailAsRead(msg.id, accessToken);
                    continue;
                }

                const toRecips = msg.toRecipients ? msg.toRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
                const ccRecips = msg.ccRecipients ? msg.ccRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];

                const emailData = {
                    from: fromAddr,
                    fromName: fromName,
                    to: toRecips,
                    cc: ccRecips,
                    subject: msg.subject || '(No Subject)',
                    body: msg.body?.content || '',
                    html: msg.body?.contentType === 'html' ? msg.body?.content : null,
                    date: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
                    messageId: messageId,
                    inReplyTo: inReplyToHeader,
                    references: referencesHeader,
                    attachments: []
                };

                emailData.attachments = await fetchMessageAttachments(msg.id, msg.hasAttachments, accessToken, userEmail);

                if (isGraphIdProcessed(msg.id)) {
                    await markEmailAsRead(msg.id, accessToken);
                    continue;
                }

                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                await ticketService.createTicketFromEmail(emailData);
                await markEmailAsRead(msg.id, accessToken);
            }
        }

        // Also check Sent Items for replies sent directly from Outlook / external mail clients
        await syncSentItemsEmails(accessToken, userEmail);

        lastPolledAt = new Date().toISOString();
        lastPollError = null;
    } catch (err) {
        lastPollError = err.message;
        logger.error(`[EMAIL] Fetch Error: ${err.message}`);
    } finally {
        isPolling = false;
    }
};

const startImapListener = () => {
    logger.info('[EMAIL] Starting Graph API Poller (Inbox & Sent Items)...');
    pollerActive = true;
    fetchNewGraphEmails();
    if (!graphPollInterval) {
        graphPollInterval = setInterval(fetchNewGraphEmails, 5000);
        logger.info('📧 Graph API Email Poller active (polling every 5 seconds)');
    }
};

const getPollerStatus = () => {
    return {
        active: pollerActive || !!graphPollInterval,
        isPolling,
        lastPolledAt,
        lastPollError,
        senderEmail: process.env.SENDER_EMAIL || process.env.MAIL_USER || null,
        configured: !!(process.env.TENANT_ID && process.env.CLIENT_ID && process.env.CLIENT_SECRET)
    };
};

module.exports = {
    fetchNewGraphEmails,
    syncSentItemsEmails,
    startImapListener,
    getPollerStatus,
    markEmailAsRead
};
