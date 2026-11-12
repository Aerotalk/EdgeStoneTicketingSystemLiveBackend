'use strict';

const logger = require('../../utils/logger');
const { getGraphAccessToken, isGraphIdProcessed, markGraphIdProcessed } = require('./graphClient');
const { fetchMessageAttachments } = require('./emailAttachmentService');
const { isInternalAgentEmail, extractTokensFromCircuitId } = require('../ticket/ticketSanitizer');
const SmartSorter = require('../ticket/smartTicketSorter');

let isPolling = false;
let pollStartedAt = 0;
const MAX_POLL_DURATION_MS = 90 * 1000; // 90s watchdog to break any hung Graph fetch lock
let graphPollInterval = null;
let lastPolledAt = null;
let lastPollError = null;
let pollerActive = false;
let lastInboxWatermarkIso = null;
let lastSentWatermarkIso = null;

const { FRESH_TICKET_MIN_DATE: MIN_LIVE_DATE, MIN_OPERATIONAL_DATE } = require('../ticket/smartTicketSorter'); // 28th Oct 2026 00:00 IST cutoff

const ensureWatermarksInitialized = async () => {
    if (lastInboxWatermarkIso && lastSentWatermarkIso) return;
    try {
        const prisma = require('../../models/index');
        const [latestTicket, latestReply] = await Promise.all([
            prisma.ticket.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
            prisma.reply.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
        ]);
        const tTime = latestTicket?.createdAt ? latestTicket.createdAt.getTime() : 0;
        const rTime = latestReply?.createdAt ? latestReply.createdAt.getTime() : 0;
        const maxTime = Math.max(tTime, rTime, MIN_LIVE_DATE.getTime());
        // Subtract 2 minutes for safety overlap
        const safeWatermark = new Date(Math.max(MIN_LIVE_DATE.getTime(), maxTime - 120 * 1000)).toISOString();
        if (!lastInboxWatermarkIso) lastInboxWatermarkIso = safeWatermark;
        if (!lastSentWatermarkIso) lastSentWatermarkIso = safeWatermark;
        logger.info(`[EMAIL] 🧭 Initialized Graph poller watermarks from DB at ${safeWatermark}`);
    } catch (err) {
        const fallbackIso = MIN_LIVE_DATE.toISOString();
        if (!lastInboxWatermarkIso) lastInboxWatermarkIso = fallbackIso;
        if (!lastSentWatermarkIso) lastSentWatermarkIso = fallbackIso;
    }
};

const isMessageIdInDb = async (internetMessageId) => {
    if (!internetMessageId) return false;
    try {
        const prisma = require('../../models/index');
        const trimmed = String(internetMessageId).trim();
        const bare = trimmed.replace(/^<+|>+$/g, '').trim();
        const candidates = Array.from(new Set([trimmed, bare, `<${bare}>`].filter(Boolean)));
        const [existingReply, existingTicket] = await Promise.all([
            prisma.reply.findFirst({ where: { messageId: { in: candidates } }, select: { id: true } }),
            prisma.ticket.findFirst({ where: { messageId: { in: candidates } }, select: { id: true } })
        ]);
        return !!(existingReply || existingTicket);
    } catch (_) {
        return false;
    }
};

const isInternalOnlyRecipientList = (toRecips = [], ccRecips = []) => {
    const allRecips = [...toRecips, ...ccRecips].map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    if (allRecips.length === 0) return false;
    return allRecips.every(addr => /@edgestone\.(?:in|com)$/i.test(addr));
};

const isCalendarOrSystemReportSubject = (subject = '', fromAddr = '') => {
    const cleanSub = String(subject || '').trim();
    if (/^(?:Accepted|Declined|Tentative|Canceled|Automatic\s+reply):/i.test(cleanSub)) return true;
    if (/^Message\s+Recall\s+Report\s+for\s+message:/i.test(cleanSub)) return true;
    if (/office365reports@microsoft\.com/i.test(String(fromAddr || ''))) return true;
    return false;
};

const markEmailAsRead = async (messageId, accessToken) => {
    try {
        const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;
        const url = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${messageId}`;
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ isRead: true }),
            signal: AbortSignal.timeout(15000)
        });
    } catch (_) {}
};

const syncSentItemsEmails = async (accessToken, userEmail) => {
    try {
        await ensureWatermarksInitialized();
        const ticketService = require('../ticketService');
        const selectFields = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,body,sentDateTime,internetMessageHeaders,hasAttachments';
        const recentSentUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/sentitems/messages?$top=15&$select=${selectFields}&$orderby=sentDateTime desc`;
        const watermarkSentUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`sentDateTime ge ${lastSentWatermarkIso}`)}&$top=100&$select=${selectFields}&$orderby=sentDateTime asc`;

        const [recentRes, wmRes] = await Promise.all([
            fetch(recentSentUrl, { headers: { 'Authorization': `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) }).catch(() => null),
            fetch(watermarkSentUrl, { headers: { 'Authorization': `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) }).catch(() => null)
        ]);

        const mergedMap = new Map();
        for (const res of [wmRes, recentRes]) {
            if (res && res.ok) {
                const data = await res.json();
                for (const m of (data.value || [])) {
                    if (m && m.id && !mergedMap.has(m.id)) mergedMap.set(m.id, m);
                }
            }
        }
        const messages = Array.from(mergedMap.values()).sort((a, b) =>
            new Date(a.sentDateTime || 0).getTime() - new Date(b.sentDateTime || 0).getTime()
        );

        for (const msg of messages) {
            const messageId = msg.internetMessageId || msg.id;
            if (isGraphIdProcessed(msg.id) || (msg.internetMessageId && isGraphIdProcessed(msg.internetMessageId))) {
                if (msg.sentDateTime && msg.sentDateTime > lastSentWatermarkIso) lastSentWatermarkIso = msg.sentDateTime;
                continue;
            }

            if (await isMessageIdInDb(msg.internetMessageId)) {
                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                if (msg.sentDateTime && msg.sentDateTime > lastSentWatermarkIso) lastSentWatermarkIso = msg.sentDateTime;
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
            const toRecipsList = msg.toRecipients ? msg.toRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
            const ccRecipsList = msg.ccRecipients ? msg.ccRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];

            // Ignore system automated notifications, calendar RSVPs, or internal-only team forwards
            if (
                subjectLower.startsWith('ticket received:') ||
                subjectLower.startsWith('ticket created:') ||
                subjectLower.startsWith('new ticket assigned:') ||
                isCalendarOrSystemReportSubject(subject, msg.from?.emailAddress?.address) ||
                isInternalOnlyRecipientList(toRecipsList, ccRecipsList)
            ) {
                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                if (msg.sentDateTime && msg.sentDateTime > lastSentWatermarkIso) lastSentWatermarkIso = msg.sentDateTime;
                continue;
            }

            const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
            const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;
            const fromAddr = msg.from?.emailAddress?.address || userEmail;
            const fromName = msg.from?.emailAddress?.name || fromAddr;

            // Check if this sent message matches an existing ticket
            let existingTicket = await ticketService.findExistingTicketForReply(inReplyToHeader, referencesHeader, subject, msg.body?.content, fromAddr);
            const isFormalMaint = SmartSorter.isFormalMaintenanceNotice(subject, msg.body?.content);
            const isMaintContext = isFormalMaint || SmartSorter.hasMaintenanceSignal(subject, msg.body?.content);
            const isIncidentContext = SmartSorter.hasStrictIncidentSignal(subject, msg.body?.content);
            const isRebateOrCommercial = SmartSorter.isSlaRebateOrCommercialEmail(subject, msg.body?.content);

            if (!existingTicket && !isRebateOrCommercial) {
                // Check if this outbound email from agent was sent regarding an active maintenance circuit
                try {
                    const prisma = require('../../models/index');
                    const textScan = `${subject || ''} ${msg.body?.content || ''}`.toUpperCase();
                    if (isMaintContext && !isIncidentContext) {
                        const allActiveMaintTickets = await prisma.ticket.findMany({
                            where: { 
                                OR: [ { isMaintenance: true }, { status: 'Maintenance' } ],
                                status: { notIn: ['Closed', 'Resolved', 'Spam'] },
                                createdAt: { gte: MIN_OPERATIONAL_DATE }
                            },
                            include: { replies: { select: { text: true, subject: true } } },
                            orderBy: { createdAt: 'desc' }
                        });
                        const outboundMeta = ticketService.extractMaintenanceMetadata(subject, msg.body?.content);

                        for (const amt of allActiveMaintTickets) {
                            if (amt.circuitId && textScan.includes(amt.circuitId.toUpperCase())) {
                                const hasCompletion = (amt.replies || []).some(r => /(?:successfully\s*completed|activity\s*completed|maintenance\s*completed)/i.test(r.text || ''));
                                if (hasCompletion) continue; // Skip completed maintenance

                                if (SmartSorter.hasMaintenanceScheduleConflict(amt, { subject, body: msg.body?.content })) {
                                    continue;
                                }

                                const amtMeta = SmartSorter.extractCandidateMaintenanceMeta(amt);
                                if (outboundMeta.crqId && (!amtMeta.crqId || outboundMeta.crqId.toUpperCase() !== amtMeta.crqId.toUpperCase())) {
                                    continue; // Different or missing CRQ, do not link to old ticket!
                                }
                                if (outboundMeta.maintDate && (!amtMeta.maintDate || outboundMeta.maintDate !== amtMeta.maintDate)) {
                                    continue; // Different or missing scheduled date window, do not link to old ticket!
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
                if (isFormalMaint) {
                    const attachments = await fetchMessageAttachments(msg.id, msg.hasAttachments, accessToken, userEmail);
                    const toRecips = msg.toRecipients ? msg.toRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
                    const ccRecips = msg.ccRecipients ? msg.ccRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
                    markGraphIdProcessed(msg.id);
                    if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                    logger.info(`[EMAIL] 🆕 Creating new Maintenance Ticket from outbound agent maintenance advisory: "${subject}"`);
                    await ticketService.createTicketFromEmail({
                        from: fromAddr,
                        fromName: fromName,
                        to: toRecips,
                        cc: ccRecips,
                        subject: subject,
                        body: msg.body?.content || '',
                        html: msg.body?.contentType === 'html' ? msg.body?.content : null,
                        date: msg.sentDateTime ? new Date(msg.sentDateTime) : new Date(),
                        messageId: messageId,
                        inReplyTo: inReplyToHeader,
                        references: referencesHeader,
                        attachments
                    });
                    if (msg.sentDateTime && msg.sentDateTime > lastSentWatermarkIso) lastSentWatermarkIso = msg.sentDateTime;
                    continue;
                }
                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                if (msg.sentDateTime && msg.sentDateTime > lastSentWatermarkIso) lastSentWatermarkIso = msg.sentDateTime;
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
                if (msg.sentDateTime && msg.sentDateTime > lastSentWatermarkIso) lastSentWatermarkIso = msg.sentDateTime;
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
            if (msg.sentDateTime && msg.sentDateTime > lastSentWatermarkIso) lastSentWatermarkIso = msg.sentDateTime;
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
    if (isPolling) {
        if (pollStartedAt && (Date.now() - pollStartedAt) > MAX_POLL_DURATION_MS) {
            logger.warn(`⚠️ [EMAIL] Poll cycle exceeded ${MAX_POLL_DURATION_MS / 1000}s watchdog; resetting stuck isPolling lock.`);
            isPolling = false;
        } else {
            return;
        }
    }
    isPolling = true;
    pollStartedAt = Date.now();

    try {
        await ensureWatermarksInitialized();
        const ticketService = require('../ticketService');
        const accessToken = await getGraphAccessToken();
        const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;
        const selectFields = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,body,receivedDateTime,isRead,internetMessageHeaders,hasAttachments';
        const unreadUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/inbox/messages?$filter=isRead eq false&$top=25&$select=${selectFields}&$orderby=receivedDateTime asc`;
        const watermarkUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${lastInboxWatermarkIso}`)}&$top=100&$select=${selectFields}&$orderby=receivedDateTime asc`;

        const [unreadRes, wmRes] = await Promise.all([
            fetch(unreadUrl, { headers: { 'Authorization': `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) }).catch(() => null),
            fetch(watermarkUrl, { headers: { 'Authorization': `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) }).catch(() => null)
        ]);

        const mergedMap = new Map();
        for (const res of [unreadRes, wmRes]) {
            if (res && res.ok) {
                const data = await res.json();
                for (const m of (data.value || [])) {
                    if (m && m.id && !mergedMap.has(m.id)) mergedMap.set(m.id, m);
                }
            }
        }

        const messages = Array.from(mergedMap.values()).sort((a, b) =>
            new Date(a.receivedDateTime || 0).getTime() - new Date(b.receivedDateTime || 0).getTime()
        );

        if (messages.length > 0) {
            const ownEmail = (process.env.SENDER_EMAIL || process.env.MAIL_USER || '').toLowerCase();

            for (const msg of messages) {
                const messageId = msg.internetMessageId || msg.id;
                const fromAddr = msg.from?.emailAddress?.address;
                const fromName = msg.from?.emailAddress?.name || fromAddr;

                if (isGraphIdProcessed(msg.id) || (msg.internetMessageId && isGraphIdProcessed(msg.internetMessageId))) {
                    if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                    if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
                    continue;
                }

                if (await isMessageIdInDb(msg.internetMessageId)) {
                    markGraphIdProcessed(msg.id);
                    if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                    if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                    if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
                    continue;
                }

                // Discard stale incoming emails from before 28th Oct (minimizes live deployment window)
                const msgDate = msg.receivedDateTime ? new Date(msg.receivedDateTime) : null;
                if (msgDate && msgDate < MIN_LIVE_DATE) {
                    logger.info(`[EMAIL] ⏭️ Discarding stale inbox email from before 28th Oct: "${msg.subject}" (${msgDate.toISOString()})`);
                    if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                    markGraphIdProcessed(msg.id);
                    if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                    continue;
                }

                if (!fromAddr || isCalendarOrSystemReportSubject(msg.subject, fromAddr)) {
                    markGraphIdProcessed(msg.id);
                    if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                    if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                    if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
                    continue;
                }

                const isAgentSender = await isInternalAgentEmail(fromAddr);
                const isOwnEmail = (ownEmail && fromAddr.toLowerCase() === ownEmail) || isAgentSender;
                const isSystemBounce = fromAddr.toLowerCase().includes('postmaster') ||
                    fromAddr.toLowerCase().includes('mailer-daemon') ||
                    /^(?:undeliverable|delivery\s*status\s*notification|mail\s*delivery\s*failed)/i.test(msg.subject || '');

                if (isSystemBounce) {
                    if (!msg.isRead) {
                        await handleSystemBounce(msg, accessToken);
                        await markEmailAsRead(msg.id, accessToken);
                    }
                    markGraphIdProcessed(msg.id);
                    if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                    if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
                    continue;
                }

                const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
                const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;
                const toRecips = msg.toRecipients ? msg.toRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];
                const ccRecips = msg.ccRecipients ? msg.ccRecipients.map(r => r.emailAddress?.address).filter(Boolean) : [];

                // If internal agent or own mailbox sends a message into Inbox (e.g. self-CC or loopback):
                if (isOwnEmail) {
                    if (isInternalOnlyRecipientList(toRecips, ccRecips)) {
                        markGraphIdProcessed(msg.id);
                        if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                        if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                        if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
                        continue;
                    }
                    let existingTicket = await ticketService.findExistingTicketForReply(inReplyToHeader, referencesHeader, msg.subject, msg.body?.content, fromAddr);
                    const isFormalMaint = SmartSorter.isFormalMaintenanceNotice(msg.subject, msg.body?.content);
                    const isMaintContext = isFormalMaint || SmartSorter.hasMaintenanceSignal(msg.subject, msg.body?.content);
                    const isIncidentContext = SmartSorter.hasStrictIncidentSignal(msg.subject, msg.body?.content);
                    const isRebateOrCommercial = SmartSorter.isSlaRebateOrCommercialEmail(msg.subject, msg.body?.content);

                    // Fallback: If not matched by headers/subject, check if this agent email references an active maintenance or circuit ticket
                    if (!existingTicket && !isRebateOrCommercial) {
                        try {
                            const prisma = require('../../models/index');
                            const textScan = `${msg.subject || ''} \n ${msg.body?.content || ''}`.toUpperCase();

                            // 1. Check if agent email is regarding an active Maintenance ticket
                            if (isMaintContext && !isIncidentContext) {
                                const allActiveMaintTickets = await prisma.ticket.findMany({
                                    where: { 
                                        OR: [ { isMaintenance: true }, { status: 'Maintenance' } ],
                                        status: { notIn: ['Closed', 'Resolved', 'Spam'] },
                                        createdAt: { gte: MIN_OPERATIONAL_DATE }
                                    },
                                    include: { replies: { select: { text: true, subject: true } } },
                                    orderBy: { createdAt: 'desc' }
                                });
                                const outboundMeta = ticketService.extractMaintenanceMetadata(msg.subject, msg.body?.content);

                                for (const amt of allActiveMaintTickets) {
                                    if (amt.circuitId && textScan.includes(amt.circuitId.toUpperCase())) {
                                        const hasCompletion = (amt.replies || []).some(r => /(?:successfully\s*completed|activity\s*completed|maintenance\s*completed)/i.test(r.text || ''));
                                        if (hasCompletion) continue; // Skip completed maintenance

                                        if (SmartSorter.hasMaintenanceScheduleConflict(amt, { subject: msg.subject, body: msg.body?.content })) {
                                            continue;
                                        }

                                        const amtMeta = SmartSorter.extractCandidateMaintenanceMeta(amt);
                                        if (outboundMeta.crqId && (!amtMeta.crqId || outboundMeta.crqId.toUpperCase() !== amtMeta.crqId.toUpperCase())) {
                                            continue; // Different or missing CRQ, do not link to old ticket!
                                        }
                                        if (outboundMeta.maintDate && (!amtMeta.maintDate || outboundMeta.maintDate !== amtMeta.maintDate)) {
                                            continue; // Different or missing scheduled date window, do not link to old ticket!
                                        }

                                        existingTicket = amt;
                                        logger.info(`[EMAIL] 📤 Linked incoming agent maintenance email from ${fromAddr} to active Maintenance Ticket ${amt.ticketId} for circuit ${amt.circuitId}`);
                                        break;
                                    }
                                }
                            }

                            // 2. Check if agent email references an active normal/incident ticket on circuit
                            // NEVER dump a formal Maintenance Activity notification or SLA Rebate request into a normal incident ticket!
                            const isReplyOrIncidentEscalation =
                                isIncidentContext ||
                                SmartSorter.hasIncidentSignal(msg.subject, msg.body?.content) ||
                                !SmartSorter.isRootEmail({ inReplyTo: inReplyToHeader, references: referencesHeader, subject: msg.subject, body: msg.body?.content });

                            if (!existingTicket && !isMaintContext && isReplyOrIncidentEscalation) {
                                const circuits = await prisma.circuit.findMany({
                                    select: { id: true, customerCircuitId: true, supplierCircuitId: true, supplierPoNumber: true, isMultiVendor: true, vendorCircuits: true }
                                });
                                const matchesCircuitToken = (txt, targetId) => {
                                    if (!txt || !targetId) return false;
                                    const escaped = String(targetId).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?:$|[^a-zA-Z0-9_-])`, 'i');
                                    return regex.test(txt);
                                };

                                for (const c of circuits) {
                                    const checkField = (field) => extractTokensFromCircuitId(field).some(tok => matchesCircuitToken(textScan, tok));
                                    const hasCkt = (c.customerCircuitId && checkField(c.customerCircuitId)) ||
                                                   (c.supplierCircuitId && checkField(c.supplierCircuitId)) ||
                                                   (c.supplierPoNumber && checkField(c.supplierPoNumber)) ||
                                                   (c.isMultiVendor && Array.isArray(c.vendorCircuits) && c.vendorCircuits.some(vc => vc.supplierCircuitId && checkField(vc.supplierCircuitId)));
                                    if (hasCkt) {
                                        const normBase = (id) => String(id || '').replace(/^(?:original|temp|temporary|old|new)[\s-_:]+/i, '').trim();
                                        const baseCust = normBase(c.customerCircuitId);
                                        const vcCircuitFilters = (c.isMultiVendor && Array.isArray(c.vendorCircuits))
                                            ? c.vendorCircuits.map(vc => vc.supplierCircuitId).filter(Boolean).map(sid => ({ circuitId: sid }))
                                            : [];

                                        const activeTicket = await prisma.ticket.findFirst({
                                            where: {
                                                OR: [
                                                    { circuitId: c.customerCircuitId },
                                                    { circuitId: c.supplierCircuitId },
                                                    { circuitId: c.id },
                                                    ...vcCircuitFilters,
                                                    ...(baseCust ? [
                                                        { circuitId: baseCust },
                                                        { circuitId: `temp-${baseCust}` },
                                                        { circuitId: `original-${baseCust}` }
                                                    ] : [])
                                                ],
                                                status: { notIn: ['Closed', 'Resolved', 'Spam'] },
                                                createdAt: { gte: MIN_OPERATIONAL_DATE }
                                            },
                                            orderBy: { createdAt: 'asc' },
                                            include: { client: true, vendor: true, replies: { select: { text: true, subject: true } } }
                                        });

                                        if (activeTicket && SmartSorter.isValidReplyCandidate(activeTicket, { subject: msg.subject, body: msg.body?.content })) {
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
                    } else if (!existingTicket && isFormalMaint && !isGraphIdProcessed(msg.id)) {
                        markGraphIdProcessed(msg.id);
                        if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                        const attachments = await fetchMessageAttachments(msg.id, msg.hasAttachments, accessToken, userEmail);
                        logger.info(`[EMAIL] 🆕 Creating new Maintenance Ticket from agent maintenance advisory: "${msg.subject}"`);
                        await ticketService.createTicketFromEmail({
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
                            attachments
                        });
                    } else if (!existingTicket) {
                        markGraphIdProcessed(msg.id);
                        if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                        logger.info(`[EMAIL] ℹ️ Ignored unlinked email from EdgeStone agent (${fromAddr}): Agents cannot create new tickets.`);
                    }

                    if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                    if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
                    continue;
                }

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
                    if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                    if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
                    continue;
                }

                markGraphIdProcessed(msg.id);
                if (msg.internetMessageId) markGraphIdProcessed(msg.internetMessageId);
                await ticketService.createTicketFromEmail(emailData);
                if (!msg.isRead) await markEmailAsRead(msg.id, accessToken);
                if (msg.receivedDateTime && msg.receivedDateTime > lastInboxWatermarkIso) lastInboxWatermarkIso = msg.receivedDateTime;
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
        pollStartedAt = 0;
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
