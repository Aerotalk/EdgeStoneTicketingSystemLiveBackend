'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const MAX_EMAIL_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB limit per attachment

const fetchMessageAttachments = async (msgId, hasAttachments, accessToken, userEmail) => {
    if (!hasAttachments) return [];
    const attachments = [];
    try {
        const attachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${msgId}/attachments`;
        const attachRes = await fetch(attachUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (attachRes.ok) {
            const attachResult = await attachRes.json();
            
            const attachmentsDir = path.join(__dirname, '../../uploads/attachments');
            if (!fs.existsSync(attachmentsDir)) {
                fs.mkdirSync(attachmentsDir, { recursive: true });
            }

            for (const attachment of attachResult.value || []) {
                const odataType = attachment['@odata.type'];
                const isFile = odataType === '#microsoft.graph.fileAttachment';
                const isItem = odataType === '#microsoft.graph.itemAttachment';

                // Process file attachments and attached email items
                if (!isFile && !isItem) {
                    continue;
                }

                // Filter out tiny 0-byte or 1px tracking pixels, but retain screenshots, attached images, and email items
                const isMeaningful = isItem || !attachment.isInline || (attachment.size && attachment.size > 1024) || (attachment.name && !attachment.name.startsWith('image00'));
                if (!isMeaningful) {
                    continue;
                }

                // Enforce 25MB size limit
                if (attachment.size && attachment.size > MAX_EMAIL_ATTACHMENT_SIZE) {
                    logger.warn(`[EMAIL] ⚠️ Attachment "${attachment.name}" on message ${msgId} exceeds 25MB limit (${(attachment.size / (1024 * 1024)).toFixed(1)}MB). Skipped.`);
                    attachments.push({
                        originalName: attachment.name || 'Large Attachment',
                        size: attachment.size,
                        error: 'File exceeds 25MB limit',
                        exceededLimit: true
                    });
                    continue;
                }

                let fileBuffer = null;
                let finalName = attachment.name || (isItem ? 'attached_email.eml' : 'attachment');

                if (isItem) {
                    // Ensure attached email has a valid email extension (.eml)
                    if (!finalName.toLowerCase().endsWith('.eml') && !finalName.toLowerCase().endsWith('.msg')) {
                        finalName = `${finalName}.eml`;
                    }

                    // For item attachments (attached emails), fetch the raw MIME stream (.eml format) via /$value
                    try {
                        const rawAttachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${msgId}/attachments/${attachment.id}/$value`;
                        const rawRes = await fetch(rawAttachUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                        if (rawRes.ok) {
                            const arrayBuffer = await rawRes.arrayBuffer();
                            fileBuffer = Buffer.from(arrayBuffer);
                            logger.info(`[EMAIL] 📥 Retrieved attached email item "${finalName}" (${(fileBuffer.length / 1024).toFixed(1)} KB) via $value MIME stream`);
                        } else {
                            // Fallback: fetch item metadata with expanded body
                            const expandUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${msgId}/attachments/${attachment.id}?$expand=microsoft.graph.itemAttachment/item`;
                            const expandRes = await fetch(expandUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                            if (expandRes.ok) {
                                const expandData = await expandRes.json();
                                const item = expandData.item || {};
                                const emlContent = [
                                    `From: ${item.from?.emailAddress?.name || ''} <${item.from?.emailAddress?.address || ''}>`,
                                    `To: ${(item.toRecipients || []).map(r => r.emailAddress?.address).join(', ')}`,
                                    `Subject: ${item.subject || ''}`,
                                    `Date: ${item.receivedDateTime || item.sentDateTime || new Date().toISOString()}`,
                                    `Content-Type: text/html; charset=utf-8`,
                                    ``,
                                    item.body?.content || ''
                                ].join('\r\n');
                                fileBuffer = Buffer.from(emlContent, 'utf-8');
                                logger.info(`[EMAIL] 📥 Constructed .eml from expanded item attachment "${finalName}"`);
                            }
                        }
                    } catch (itemErr) {
                        logger.error(`[EMAIL] ❌ Error fetching item attachment ${attachment.id}: ${itemErr.message}`);
                    }
                } else {
                    // File attachment handling:
                    // 1. If contentBytes is present directly (for files <= 3MB)
                    if (attachment.contentBytes) {
                        fileBuffer = Buffer.from(attachment.contentBytes, 'base64');
                    } else if (attachment.id) {
                        // 2. For large files (> 3MB), fetch the raw binary stream directly from the /$value endpoint:
                        try {
                            const rawAttachUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${msgId}/attachments/${attachment.id}/$value`;
                            const rawRes = await fetch(rawAttachUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                            if (rawRes.ok) {
                                const arrayBuffer = await rawRes.arrayBuffer();
                                fileBuffer = Buffer.from(arrayBuffer);
                                logger.info(`[EMAIL] 📥 Retrieved large attachment "${attachment.name}" (${(fileBuffer.length / (1024 * 1024)).toFixed(2)} MB) via $value stream`);
                            } else {
                                logger.error(`[EMAIL] ❌ Failed to fetch raw attachment content for ${attachment.id}: status ${rawRes.status}`);
                            }
                        } catch (fetchRawErr) {
                            logger.error(`[EMAIL] ❌ Error fetching raw attachment stream for ${attachment.id}: ${fetchRawErr.message}`);
                        }
                    }
                }

                if (fileBuffer) {
                    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                    const safeName = finalName ? finalName.replace(/[^a-zA-Z0-9.-]/g, '_') : 'attachment';
                    const fileName = `email-${uniqueSuffix}-${safeName}`;
                    const filePath = path.join(attachmentsDir, fileName);
                    
                    fs.writeFileSync(filePath, fileBuffer);
                    
                    const baseUrl = process.env.BACKEND_URL || 'http://localhost:5000';
                    const publicUrl = `${baseUrl}/uploads/attachments/${fileName}`;
                    const downloadUrl = `${baseUrl}/api/upload/attachments/${fileName}/download?name=${encodeURIComponent(finalName || safeName)}`;
                    
                    attachments.push({
                        url: publicUrl,
                        downloadUrl: downloadUrl,
                        originalName: finalName || fileName,
                        filename: fileName,
                        mimeType: isItem ? 'message/rfc822' : (attachment.contentType || 'application/octet-stream'),
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

module.exports = {
    fetchMessageAttachments,
    MAX_EMAIL_ATTACHMENT_SIZE
};
