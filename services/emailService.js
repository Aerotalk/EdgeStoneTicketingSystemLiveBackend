'use strict';

const emailConfig = require('../config/emailConfig');
const ticketService = require('./ticketService');
const logger = require('../utils/logger');

let graphAccessToken = null;
let tokenExpiresAt = 0;
let isPolling = false;
let graphPollInterval = null;
let lastPolledAt = null;
let lastPollError = null;
let pollerActive = false;

const processedGraphIds = new Set();

const getGraphAccessToken = async () => {
    const tenantId = process.env.TENANT_ID;
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        throw new Error('Missing MS Graph API configuration.');
    }

    if (graphAccessToken && Date.now() < tokenExpiresAt) {
        return graphAccessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const tokenData = new URLSearchParams({
        client_id: clientId,
        scope: 'https://graph.microsoft.com/.default',
        client_secret: clientSecret,
        grant_type: 'client_credentials'
    });

    const response = await fetch(tokenUrl, {
        method: 'POST',
        body: tokenData,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = await response.json();
    if (!response.ok) {
        throw new Error(`Graph Token Error: ${result.error?.message}`);
    }

    graphAccessToken = result.access_token;
    tokenExpiresAt = Date.now() + (result.expires_in * 1000) - 300000;
    return graphAccessToken;
};

const MAX_EMAIL_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB limit per attachment

const sendViaGraph = async (options) => {
    let { to, cc, bcc, subject, text, body, html, inReplyTo, references, extraHeaders = {} } = options;
    const accessToken = await getGraphAccessToken();
    const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;
    const fs = require('fs');
    const path = require('path');
    
    // Parse HTML for base64 inline images and convert them to cid attachments
    if (html && typeof html === 'string') {
        let cidCounter = 0;
        const regex = /src=["']data:image\/([a-zA-Z0-9+.-]+);base64,([^"']+)["']/gi;
        
        html = html.replace(regex, (match, ext, base64Data) => {
            cidCounter++;
            const cid = `inline-img-${cidCounter}-${Date.now()}`;
            
            if (!options.attachments) options.attachments = [];
            options.attachments.push({
                name: `image-${cidCounter}.${ext}`,
                mimeType: `image/${ext}`,
                contentBytes: base64Data,
                isInline: true,
                contentId: cid
            });
            
            return `src="cid:${cid}"`;
        });
    }

    const formatRecipients = (recipients) => {
        if (!recipients) return [];
        const rawArr = Array.isArray(recipients) ? recipients : [recipients];
        const cleaned = [];
        for (const r of rawArr) {
            if (!r) continue;
            const strVal = typeof r === 'string' ? r : (r.address || r.email || '');
            if (typeof strVal === 'string') {
                strVal.split(/[,;]+/).forEach(item => {
                    const trimmed = item.trim();
                    if (trimmed && !cleaned.includes(trimmed)) {
                        cleaned.push(trimmed);
                    }
                });
            }
        }
        return cleaned.map(email => ({ emailAddress: { address: email } }));
    };

    const message = {
        subject: subject,
        body: {
            contentType: html ? 'HTML' : 'Text',
            content: html || text || body || ''
        },
        toRecipients: formatRecipients(to)
    };

    let processedAttachments = [];
    let totalAttachmentBytes = 0;

    if (options.attachments && options.attachments.length > 0) {
        for (const att of options.attachments) {
            let buffer = null;
            if (att.content) {
                buffer = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content, typeof att.content === 'string' ? 'base64' : undefined);
            } else if (att.contentBytes) {
                buffer = Buffer.from(att.contentBytes, 'base64');
            } else if (att.filename) {
                try {
                    const filePath = path.join(__dirname, '../uploads/attachments', att.filename);
                    if (fs.existsSync(filePath)) {
                        buffer = fs.readFileSync(filePath);
                    }
                } catch (err) {
                    logger.error(`Failed to read attachment file for sending: ${err.message}`);
                }
            }

            if (buffer) {
                if (buffer.length > MAX_EMAIL_ATTACHMENT_SIZE) {
                    throw new Error(`Attachment "${att.originalName || att.filename || att.name}" exceeds the maximum email attachment limit of 25MB.`);
                }
                totalAttachmentBytes += buffer.length;
                processedAttachments.push({
                    name: att.originalName || att.filename || att.name || 'attachment',
                    contentType: att.mimeType || 'application/octet-stream',
                    buffer: buffer,
                    isInline: !!att.isInline,
                    contentId: att.contentId
                });
            }
        }
    }

    if (cc) {
        const ccRecips = formatRecipients(cc);
        if (ccRecips.length > 0) message.ccRecipients = ccRecips;
    }
    if (bcc) {
        const bccRecips = formatRecipients(bcc);
        if (bccRecips.length > 0) message.bccRecipients = bccRecips;
    }

    // Format RFC 5322 Message-IDs with angle brackets
    const formatMsgId = (id) => {
        if (!id || typeof id !== 'string') return null;
        let clean = id.trim();
        if (!clean) return null;
        if (!clean.startsWith('<')) clean = `<${clean}`;
        if (!clean.endsWith('>')) clean = `${clean}>`;
        return clean;
    };

    const formatReferences = (refs) => {
        if (!refs) return null;
        const rawList = Array.isArray(refs) ? refs : refs.split(/\s+/);
        const formatted = [];
        for (const item of rawList) {
            const clean = formatMsgId(item);
            if (clean && !formatted.includes(clean)) {
                formatted.push(clean);
            }
        }
        return formatted.length > 0 ? formatted.join(' ') : null;
    };

    const formattedInReplyTo = inReplyTo ? formatMsgId(inReplyTo) : null;
    const formattedReferences = references ? formatReferences(references) : null;

    // Helper: Upload attachments to a draft message (direct or uploadSession for > 3MB)
    const uploadDraftAttachments = async (draftId, attachmentsToUpload) => {
        for (const att of attachmentsToUpload) {
            if (att.buffer.length <= (3 * 1024 * 1024)) {
                const addAttachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${draftId}/attachments`;
                const attachPayload = {
                    '@odata.type': '#microsoft.graph.fileAttachment',
                    name: att.name,
                    contentType: att.contentType,
                    contentBytes: att.buffer.toString('base64'),
                    isInline: att.isInline,
                    contentId: att.contentId
                };
                const addRes = await fetch(addAttachUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(attachPayload)
                });
                if (!addRes.ok) {
                    logger.error(`Failed to attach ${att.name} directly to draft ${draftId}`);
                }
            } else {
                logger.info(`[EMAIL] Creating upload session for large attachment: ${att.name} (${(att.buffer.length / (1024*1024)).toFixed(2)} MB)`);
                const sessionUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${draftId}/attachments/createUploadSession`;
                const sessionRes = await fetch(sessionUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        AttachmentItem: {
                            attachmentType: 'file',
                            name: att.name,
                            size: att.buffer.length,
                            contentType: att.contentType
                        }
                    })
                });

                if (!sessionRes.ok) {
                    const sessErr = await sessionRes.json().catch(() => ({}));
                    throw new Error(`Failed to create upload session for ${att.name}: ${sessErr.error?.message || sessionRes.status}`);
                }

                const { uploadUrl } = await sessionRes.json();
                const chunkSize = 320 * 1024 * 10;
                let offset = 0;
                while (offset < att.buffer.length) {
                    const chunkEnd = Math.min(offset + chunkSize, att.buffer.length);
                    const chunk = att.buffer.slice(offset, chunkEnd);
                    const chunkRes = await fetch(uploadUrl, {
                        method: 'PUT',
                        headers: {
                            'Content-Length': chunk.length.toString(),
                            'Content-Range': `bytes ${offset}-${chunkEnd - 1}/${att.buffer.length}`
                        },
                        body: chunk
                    });

                    if (!chunkRes.ok && chunkRes.status !== 200 && chunkRes.status !== 201 && chunkRes.status !== 202) {
                        throw new Error(`Failed to upload chunk for ${att.name} at offset ${offset}`);
                    }
                    offset = chunkEnd;
                }
                logger.info(`[EMAIL] Large attachment ${att.name} uploaded successfully to draft.`);
            }
        }
    };

    // Helper: Find parent message in Graph API by internetMessageId or Graph message ID
    const findParentGraphMessage = async (replyToTarget, referencesTarget) => {
        const candidateIds = [];
        if (replyToTarget && typeof replyToTarget === 'string') {
            candidateIds.push(replyToTarget.trim());
        }
        if (referencesTarget) {
            const rawRefs = Array.isArray(referencesTarget) ? referencesTarget : referencesTarget.split(/\s+/);
            for (let i = rawRefs.length - 1; i >= 0; i--) {
                const r = rawRefs[i]?.trim();
                if (r && !candidateIds.includes(r)) {
                    candidateIds.push(r);
                }
            }
        }

        for (const rawId of candidateIds) {
            if (!rawId) continue;
            const clean = rawId.trim();

            // Direct Graph ID check (Graph IDs are long alphanumeric base64 strings with no '@')
            if (!clean.includes('@') && !clean.startsWith('<') && clean.length > 50) {
                try {
                    const directUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${clean}?$select=id,conversationId,subject`;
                    const dRes = await fetch(directUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                    if (dRes.ok) {
                        const data = await dRes.json();
                        if (data && data.id) return data;
                    }
                } catch (e) {
                    logger.warn(`[EMAIL] Direct Graph ID lookup failed for ${clean}: ${e.message}`);
                }
            }

            const withBrackets = clean.startsWith('<') && clean.endsWith('>') ? clean : `<${clean.replace(/^<+|>+$/g, '')}>`;
            const withoutBrackets = clean.replace(/^<+|>+$/g, '');

            try {
                const queryUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages?$filter=internetMessageId eq '${encodeURIComponent(withBrackets)}'&$select=id,conversationId,subject&$top=1`;
                const res = await fetch(queryUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                if (res.ok) {
                    const data = await res.json();
                    if (data.value && data.value.length > 0) return data.value[0];
                }
            } catch (e) {
                logger.warn(`[EMAIL] Parent lookup with brackets failed for ${withBrackets}: ${e.message}`);
            }

            try {
                const queryUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages?$filter=internetMessageId eq '${encodeURIComponent(withoutBrackets)}'&$select=id,conversationId,subject&$top=1`;
                const res = await fetch(queryUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                if (res.ok) {
                    const data = await res.json();
                    if (data.value && data.value.length > 0) return data.value[0];
                }
            } catch (e) {
                logger.warn(`[EMAIL] Parent lookup without brackets failed for ${withoutBrackets}: ${e.message}`);
            }
        }

        return null;
    };

    const toEmails = Array.isArray(to) ? to.join(', ') : to;

    // --- NATIVE GRAPH THREADING: Use createReply when replying to an existing message ---
    if (inReplyTo || references) {
        logger.info(`[EMAIL] 🧵 Threading requested. Searching for parent message in MS Graph for inReplyTo: "${inReplyTo || ''}"...`);
        const parentMsg = await findParentGraphMessage(inReplyTo, references);

        if (parentMsg && parentMsg.id) {
            logger.info(`[EMAIL] 🎯 Found parent Graph message ${parentMsg.id} (conversationId: ${parentMsg.conversationId}). Using native Graph createReply.`);
            
            // 1. Create a native reply draft linked directly to the parent's conversationId & conversationIndex
            const createReplyUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${parentMsg.id}/createReply`;
            const replyDraftRes = await fetch(createReplyUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({})
            });

            if (replyDraftRes.ok) {
                const draftData = await replyDraftRes.json();
                const draftId = draftData.id;
                const draftInternetMessageId = draftData.internetMessageId;

                // 2. Patch draft with custom recipients, subject, and content
                const patchUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${draftId}`;
                const patchPayload = {
                    subject: subject,
                    body: {
                        contentType: html ? 'HTML' : 'Text',
                        content: html || text || body || ''
                    },
                    toRecipients: formatRecipients(to)
                };
                if (cc) patchPayload.ccRecipients = formatRecipients(cc);
                if (bcc) patchPayload.bccRecipients = formatRecipients(bcc);

                const patchRes = await fetch(patchUrl, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(patchPayload)
                });

                if (!patchRes.ok) {
                    const patchErr = await patchRes.json().catch(() => ({}));
                    throw new Error(`Failed to update reply draft: ${patchErr.error?.message || patchRes.status}`);
                }

                // 3. Attach files if any
                if (processedAttachments.length > 0) {
                    await uploadDraftAttachments(draftId, processedAttachments);
                }

                // 4. Send the reply draft
                const sendDraftUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${draftId}/send`;
                const sendRes = await fetch(sendDraftUrl, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });

                if (sendRes.ok || sendRes.status === 202) {
                    logger.info(`[EMAIL] 🚀 Native reply sent via Graph to ${toEmails} | Message-ID: ${draftInternetMessageId} | ConversationId: ${draftData.conversationId}`);
                    processedGraphIds.add(draftId);
                    if (draftInternetMessageId) processedGraphIds.add(draftInternetMessageId);

                    return {
                        messageId: draftInternetMessageId || null,
                        conversationId: draftData.conversationId || parentMsg.conversationId || null,
                        accepted: Array.isArray(to) ? to : [to],
                        response: '202 Accepted'
                    };
                }

                const sendErr = await sendRes.json().catch(() => ({}));
                throw new Error(`Reply draft send failed: ${sendErr.error?.message || sendRes.status}`);
            } else {
                const repErr = await replyDraftRes.json().catch(() => ({}));
                logger.warn(`[EMAIL] ⚠️ createReply failed (${repErr.error?.message || replyDraftRes.status}). Falling back to standard send.`);
            }
        } else {
            logger.info(`[EMAIL] ℹ️ Parent message for inReplyTo "${inReplyTo || ''}" not found in MS Graph. Falling back to standard send.`);
        }
    }

    // --- FALLBACK PATH: Standard draft/sendMail workflow for brand-new emails or when parent not found ---
    const headers = [];
    const addHeader = (name, value) => {
        if (name && (name.toLowerCase().startsWith('x-') || name.toLowerCase() === 'reply-to')) {
            headers.push({ name, value });
        }
    };
    Object.keys(extraHeaders).forEach(key => {
        addHeader(key, extraHeaders[key]);
    });
    if (headers.length > 0) {
        message.internetMessageHeaders = headers;
    }

    // Microsoft Graph /sendMail endpoint has a hard 4MB request payload limit.
    // If total attachments > 3MB, we must create a draft message and upload attachments.
    const isLargePayload = totalAttachmentBytes > (3 * 1024 * 1024);

    if (isLargePayload) {
        logger.info(`[EMAIL] Total attachment size is ${(totalAttachmentBytes / (1024*1024)).toFixed(2)} MB. Using Graph Draft + Upload Session workflow.`);
        
        // 1. Create Draft Message
        const draftUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages`;
        const draftRes = await fetch(draftUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        });

        if (!draftRes.ok) {
            const draftErr = await draftRes.json().catch(() => ({}));
            throw new Error(`Failed to create draft for large email: ${draftErr.error?.message || draftRes.status}`);
        }

        const draftData = await draftRes.json();
        const draftId = draftData.id;

        // 2. Attach each file to the draft
        await uploadDraftAttachments(draftId, processedAttachments);

        // 3. Send the draft
        const sendDraftUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${draftId}/send`;
        const sendRes = await fetch(sendDraftUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (sendRes.ok || sendRes.status === 202) {
            logger.info(`[EMAIL] Sent large email via Graph draft to ${toEmails}`);
            processedGraphIds.add(draftId);
            if (draftData.internetMessageId) processedGraphIds.add(draftData.internetMessageId);
            return { messageId: draftData.internetMessageId || null, accepted: Array.isArray(to) ? to : [to], response: '202 Accepted' };
        }

        const sendErr = await sendRes.json().catch(() => ({}));
        throw new Error(`Draft send failed: ${sendErr.error?.message || sendRes.status}`);
    }

    // Standard fast path for payloads <= 3MB
    if (processedAttachments.length > 0) {
        message.hasAttachments = true;
        message.attachments = processedAttachments.map(att => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.name,
            contentBytes: att.buffer.toString('base64'),
            isInline: att.isInline,
            contentId: att.contentId
        }));
    }

    const headersUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/sendMail`;
    const directMessage = { ...message };

    const response = await fetch(headersUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: directMessage, saveToSentItems: true })
    });

    if (response.ok || response.status === 202) {
        logger.info(`[EMAIL] Sent email via Graph to ${toEmails}`);
        return { messageId: null, accepted: Array.isArray(to) ? to : [to], response: '202 Accepted' };
    }
    
    const errBody = await response.json().catch(() => ({}));
    throw new Error(`SendMail failed: ${errBody.error?.message || response.status}`);
};

const sendEmail = async (options) => {
    return sendViaGraph(options);
};

const sendAgentReplyEmail = async (options) => {
    const toEmails = Array.isArray(options.to) ? options.to.join(', ') : options.to;
    logger.info(`[EMAIL] Sending Agent Reply to ${toEmails} for Subject: ${options.subject}`);
    return sendViaGraph(options);
};

const markEmailAsRead = async (messageId, accessToken) => {
    const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;
    const url = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${messageId}`;
    await fetch(url, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true })
    });
};

const fetchMessageAttachments = async (msgId, hasAttachments, accessToken, userEmail) => {
    if (!hasAttachments) return [];
    const attachments = [];
    try {
        const attachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${msgId}/attachments`;
        const attachRes = await fetch(attachUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (attachRes.ok) {
            const attachResult = await attachRes.json();
            const fs = require('fs');
            const path = require('path');
            
            const attachmentsDir = path.join(__dirname, '../uploads/attachments');
            if (!fs.existsSync(attachmentsDir)) {
                fs.mkdirSync(attachmentsDir, { recursive: true });
            }

            for (const attachment of attachResult.value || []) {
                // Only process file attachments
                if (attachment['@odata.type'] !== '#microsoft.graph.fileAttachment') {
                    continue;
                }

                // Filter out tiny 0-byte or 1px tracking pixels, but retain screenshots and attached images
                const isMeaningful = !attachment.isInline || (attachment.size && attachment.size > 1024) || (attachment.name && !attachment.name.startsWith('image00'));
                if (!isMeaningful) {
                    continue;
                }

                // Enforce 25MB size limit
                if (attachment.size && attachment.size > MAX_EMAIL_ATTACHMENT_SIZE) {
                    logger.warn(`[EMAIL] ⚠️ Attachment "${attachment.name}" on message ${msgId} exceeds 25MB limit (${(attachment.size / (1024*1024)).toFixed(1)}MB). Skipped.`);
                    attachments.push({
                        originalName: attachment.name || 'Large Attachment',
                        size: attachment.size,
                        error: 'File exceeds 25MB limit',
                        exceededLimit: true
                    });
                    continue;
                }

                let fileBuffer = null;

                // 1. If contentBytes is present directly (for files <= 3MB)
                if (attachment.contentBytes) {
                    fileBuffer = Buffer.from(attachment.contentBytes, 'base64');
                } else if (attachment.id) {
                    // 2. For large files (> 3MB), Microsoft Graph omits contentBytes.
                    // We fetch the raw binary stream directly from the /$value endpoint:
                    try {
                        const rawAttachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${msgId}/attachments/${attachment.id}/$value`;
                        const rawRes = await fetch(rawAttachUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                        if (rawRes.ok) {
                            const arrayBuffer = await rawRes.arrayBuffer();
                            fileBuffer = Buffer.from(arrayBuffer);
                            logger.info(`[EMAIL] 📥 Retrieved large attachment "${attachment.name}" (${(fileBuffer.length / (1024*1024)).toFixed(2)} MB) via $value stream`);
                        } else {
                            logger.error(`[EMAIL] ❌ Failed to fetch raw attachment content for ${attachment.id}: status ${rawRes.status}`);
                        }
                    } catch (fetchRawErr) {
                        logger.error(`[EMAIL] ❌ Error fetching raw attachment stream for ${attachment.id}: ${fetchRawErr.message}`);
                    }
                }

                if (fileBuffer) {
                    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                    const safeName = attachment.name ? attachment.name.replace(/[^a-zA-Z0-9.-]/g, '_') : 'attachment';
                    const fileName = `email-${uniqueSuffix}-${safeName}`;
                    const filePath = path.join(attachmentsDir, fileName);
                    
                    fs.writeFileSync(filePath, fileBuffer);
                    
                    const baseUrl = process.env.BACKEND_URL || 'http://localhost:5000';
                    const publicUrl = `${baseUrl}/uploads/attachments/${fileName}`;
                    const downloadUrl = `${baseUrl}/api/upload/attachments/${fileName}/download?name=${encodeURIComponent(attachment.name || safeName)}`;
                    
                    attachments.push({
                        url: publicUrl,
                        downloadUrl: downloadUrl,
                        originalName: attachment.name || fileName,
                        filename: fileName,
                        mimeType: attachment.contentType,
                        size: fileBuffer.length || attachment.size
                    });
                }
            }
        }
    } catch (attachErr) {
        logger.error(`[EMAIL] Failed to fetch/save attachments for message ${msgId}: ${attachErr.message}`);
    }
    return attachments;
};

const syncSentItemsEmails = async (accessToken, userEmail) => {
    try {
        const sentUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/sentitems/messages?$top=15&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,body,sentDateTime,internetMessageHeaders,hasAttachments&$orderby=sentDateTime desc`;
        const sentRes = await fetch(sentUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (!sentRes.ok) return;

        const sentData = await sentRes.json();
        const messages = sentData.value || [];

        for (const msg of messages) {
            const messageId = msg.internetMessageId || msg.id;
            if (processedGraphIds.has(msg.id) || (msg.internetMessageId && processedGraphIds.has(msg.internetMessageId))) {
                continue;
            }

            const subject = msg.subject || '';
            const subjectLower = subject.toLowerCase();

            // Ignore system automated notifications (e.g. ticket creation acknowledgment)
            if (subjectLower.startsWith('ticket received:') || subjectLower.startsWith('ticket created:') || subjectLower.startsWith('new ticket assigned:')) {
                processedGraphIds.add(msg.id);
                if (msg.internetMessageId) processedGraphIds.add(msg.internetMessageId);
                continue;
            }

            const inReplyToHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
            const referencesHeader = msg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'references')?.value || null;
            const fromAddr = msg.from?.emailAddress?.address || userEmail;
            const fromName = msg.from?.emailAddress?.name || fromAddr;

            // Check if this sent message matches an existing ticket
            const existingTicket = await ticketService.findExistingTicketForReply(inReplyToHeader, referencesHeader, subject, msg.body?.content, fromAddr);
            if (!existingTicket) {
                processedGraphIds.add(msg.id);
                if (msg.internetMessageId) processedGraphIds.add(msg.internetMessageId);
                continue;
            }

            // Extract text to see if it was already created from the EdgeStone portal
            const cleanText = ticketService.stripQuotedReply(ticketService.stripHtml(msg.body?.content || '')) || '';
            const prisma = require('../models/index');
            const existingReplies = await prisma.reply.findMany({
                where: { ticketId: existingTicket.id }
            });

            const alreadyRecorded = existingReplies.some(r => {
                if (r.messageId && msg.internetMessageId && r.messageId === msg.internetMessageId) return true;
                const cleanR = (r.text || '').trim();
                return cleanR.length > 5 && cleanText.includes(cleanR);
            });

            if (alreadyRecorded) {
                processedGraphIds.add(msg.id);
                if (msg.internetMessageId) processedGraphIds.add(msg.internetMessageId);
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

            processedGraphIds.add(msg.id);
            if (msg.internetMessageId) processedGraphIds.add(msg.internetMessageId);
        }
    } catch (sentErr) {
        logger.error(`[EMAIL] Sent Items Sync Error: ${sentErr.message}`);
    }
};

const fetchNewGraphEmails = async () => {
    if (isPolling) return;
    isPolling = true;

    try {
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
                    if (existingTicket && !processedGraphIds.has(msg.id)) {
                        processedGraphIds.add(msg.id);
                        if (msg.internetMessageId) processedGraphIds.add(msg.internetMessageId);
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

                if (processedGraphIds.has(msg.id)) {
                    await markEmailAsRead(msg.id, accessToken);
                    continue;
                }

                processedGraphIds.add(msg.id);
                if (msg.internetMessageId) processedGraphIds.add(msg.internetMessageId);
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
    sendEmail,
    sendAgentReplyEmail,
    startImapListener,
    fetchNewGraphEmails,
    syncSentItemsEmails,
    fetchMessageAttachments,
    getPollerStatus
};
