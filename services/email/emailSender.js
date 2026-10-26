'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { isAutoReplyEnabled } = require('../../utils/emailConfig');
const { getGraphAccessToken, markGraphIdProcessed } = require('./graphClient');
const { MAX_EMAIL_ATTACHMENT_SIZE } = require('./emailAttachmentService');

/**
 * Normalizes HTML tables to ensure crisp borders, padding, and layout preservation
 * across Microsoft Outlook desktop, Outlook Web, and mobile clients.
 */
const normalizeEmailTablesForOutlook = (html) => {
    if (!html || typeof html !== 'string' || !/<table[\s>]/i.test(html)) {
        return html;
    }

    let modified = html;

    // 1. Ensure table tags have proper presentation attributes and MSO inline styles
    modified = modified.replace(/<table\b([^>]*)>/gi, (match, attrs) => {
        let styleVal = '';
        const styleMatch = attrs.match(/style=["']([^"']*)["']/i);
        if (styleMatch) {
            styleVal = styleMatch[1].replace(/;?$/, '; ');
        }
        const cleanAttrs = attrs
            .replace(/\s*style=["'][^"']*["']/gi, '')
            .replace(/\s*border=["'][^"']*["']/gi, '')
            .replace(/\s*cellpadding=["'][^"']*["']/gi, '')
            .replace(/\s*cellspacing=["'][^"']*["']/gi, '');

        const tableStyle = `width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; border: 1px solid #cbd5e1; mso-table-lspace: 0pt; mso-table-rspace: 0pt; ${styleVal}`.trim();
        return `<table border="1" cellpadding="0" cellspacing="0" class="edgestone-table" style="${tableStyle}" ${cleanAttrs}>`;
    });

    // 2. Ensure th tags have header styles
    modified = modified.replace(/<th\b([^>]*)>/gi, (match, attrs) => {
        let styleVal = '';
        const styleMatch = attrs.match(/style=["']([^"']*)["']/i);
        if (styleMatch) {
            styleVal = styleMatch[1].replace(/;?$/, '; ');
        }
        const cleanAttrs = attrs.replace(/\s*style=["'][^"']*["']/gi, '');
        const thStyle = `background-color: #f1f5f9; color: #0f172a; font-weight: 700; padding: 8px 12px; border: 1px solid #cbd5e1; text-align: left; font-size: 13px; ${styleVal}`.trim();
        return `<th style="${thStyle}" ${cleanAttrs}>`;
    });

    // 3. Ensure td tags have cell borders and padding
    modified = modified.replace(/<td\b([^>]*)>/gi, (match, attrs) => {
        let styleVal = '';
        const styleMatch = attrs.match(/style=["']([^"']*)["']/i);
        if (styleMatch) {
            styleVal = styleMatch[1].replace(/;?$/, '; ');
        }
        const cleanAttrs = attrs.replace(/\s*style=["'][^"']*["']/gi, '');
        const tdStyle = `padding: 8px 12px; border: 1px solid #cbd5e1; color: #334155; vertical-align: top; font-size: 13px; ${styleVal}`.trim();
        return `<td style="${tdStyle}" ${cleanAttrs}>`;
    });

    return modified;
};

const sendViaGraph = async (options) => {
    let { to, cc, bcc, subject, text, body, html, inReplyTo, references, extraHeaders = {} } = options;
    const accessToken = await getGraphAccessToken();
    const userEmail = process.env.SENDER_EMAIL || process.env.MAIL_USER;

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

        // Normalize HTML tables for Outlook email clients
        html = normalizeEmailTablesForOutlook(html);
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

    const formattedToRecipients = formatRecipients(to);
    if (!formattedToRecipients || formattedToRecipients.length === 0) {
        throw new Error('Cannot send email: No valid recipient email address was provided.');
    }

    const message = {
        subject: subject,
        body: {
            contentType: html ? 'HTML' : 'Text',
            content: html || text || body || ''
        },
        toRecipients: formattedToRecipients
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
                    const filePath = path.join(__dirname, '../../uploads/attachments', att.filename);
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
                logger.info(`[EMAIL] Creating upload session for large attachment: ${att.name} (${(att.buffer.length / (1024 * 1024)).toFixed(2)} MB)`);
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
                    toRecipients: formattedToRecipients
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
                    markGraphIdProcessed(draftId);
                    if (draftInternetMessageId) markGraphIdProcessed(draftInternetMessageId);

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
    if (formattedInReplyTo) {
        headers.push({ name: 'In-Reply-To', value: formattedInReplyTo });
    }
    if (formattedReferences) {
        headers.push({ name: 'References', value: formattedReferences });
    }
    const addHeader = (name, value) => {
        if (name && (name.toLowerCase().startsWith('x-') || name.toLowerCase() === 'reply-to' || name.toLowerCase() === 'in-reply-to' || name.toLowerCase() === 'references')) {
            // Avoid duplicate headers
            if (!headers.some(h => h.name.toLowerCase() === name.toLowerCase())) {
                headers.push({ name, value });
            }
        }
    };
    Object.keys(extraHeaders).forEach(key => {
        addHeader(key, extraHeaders[key]);
    });
    if (headers.length > 0) {
        message.internetMessageHeaders = headers;
    }

    // Use Graph Draft + Send workflow so internetMessageId is ALWAYS captured and returned for reply threading.
    // This solves Problem 1 (threading breaks because sendMail returns 202 without Message-ID).
    try {
        const draftUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages`;
        const draftRes = await fetch(draftUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        });

        if (draftRes.ok) {
            const draftData = await draftRes.json();
            const draftId = draftData.id;

            // Upload attachments (handles both small base64 attachments and large upload sessions)
            if (processedAttachments.length > 0) {
                await uploadDraftAttachments(draftId, processedAttachments);
            }

            const sendDraftUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${draftId}/send`;
            const sendRes = await fetch(sendDraftUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (sendRes.ok || sendRes.status === 202) {
                logger.info(`[EMAIL] 🚀 Sent email via Graph draft to ${toEmails} | Message-ID: ${draftData.internetMessageId || draftId}`);
                markGraphIdProcessed(draftId);
                if (draftData.internetMessageId) markGraphIdProcessed(draftData.internetMessageId);
                return {
                    messageId: draftData.internetMessageId || null,
                    conversationId: draftData.conversationId || null,
                    accepted: Array.isArray(to) ? to : [to],
                    response: '202 Accepted'
                };
            }
            logger.warn(`[EMAIL] Draft send returned status ${sendRes.status}. Falling back to sendMail.`);
        } else {
            const draftErr = await draftRes.json().catch(() => ({}));
            logger.warn(`[EMAIL] Draft creation returned ${draftRes.status}: ${draftErr.error?.message}. Falling back to sendMail.`);
        }
    } catch (draftWorkflowErr) {
        logger.warn(`[EMAIL] Draft workflow failed (${draftWorkflowErr.message}). Falling back to standard sendMail.`);
    }

    // --- FALLBACK PATH: Direct /sendMail ---
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
        logger.info(`[EMAIL] Sent email via Graph sendMail fallback to ${toEmails}`);
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

const sendAutoReplyEmail = async (options) => {
    if (!isAutoReplyEnabled()) {
        const toEmails = Array.isArray(options.to) ? options.to.join(', ') : options.to;
        logger.info(`[EMAIL] 🛑 Skipped Auto-Reply to ${toEmails}: AUTOREPLY is disabled via environment configuration (AUTOREPLY=false)`);
        return { messageId: null, accepted: [], rejected: [], response: 'Skipped: AUTOREPLY is disabled', skipped: true };
    }
    const toEmails = Array.isArray(options.to) ? options.to.join(', ') : options.to;
    logger.info(`[EMAIL] 🤖 Sending Auto-Reply to ${toEmails} for Subject: ${options.subject}`);
    return sendViaGraph(options);
};

module.exports = {
    sendEmail,
    sendAgentReplyEmail,
    sendAutoReplyEmail,
    sendViaGraph,
    isAutoReplyEnabled
};
