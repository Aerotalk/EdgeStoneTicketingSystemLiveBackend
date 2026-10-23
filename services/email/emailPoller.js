'use strict';

const logger = require('../../utils/logger');
const { getGraphAccessToken, isGraphIdProcessed, markGraphIdProcessed } = require('./graphClient');
const { fetchMessageAttachments } = require('./emailAttachmentService');

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
                    const isMaintContext = /(?:emergency|planned|scheduled|urgent)?\s*maint(?:en|ain)[ae]nce/i.test(`${subject || ''} ${msg.body?.content || ''}`);
                    if (isMaintContext) {
                        const allActiveMaintTickets = await prisma.ticket.findMany({
                            where: { 
                                OR: [ { isMaintenance: true }, { status: 'Maintenance' } ],
                                status: { notIn: ['Closed', 'Resolved'] }
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

                if (!fromAddr) {
                    await markEmailAsRead(msg.id, accessToken);
                    continue;
                }

                const isOwnEmail = ownEmail && fromAddr.toLowerCase() === ownEmail;
                const isSystemBounce = fromAddr.toLowerCase().includes('postmaster') || fromAddr.toLowerCase().includes('mailer-daemon');
                
                if (isSystemBounce) {
                    await markEmailAsRead(msg.id, accessToken);
                    continue;
                }

                const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
                const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;

                // If ownEmail sends a message into Inbox (e.g. self-CC or loopback):
                if (isOwnEmail) {
                    const existingTicket = await ticketService.findExistingTicketForReply(inReplyToHeader, referencesHeader, msg.subject, msg.body?.content, fromAddr);
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
