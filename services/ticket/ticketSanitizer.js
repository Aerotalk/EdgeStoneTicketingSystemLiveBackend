'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// stripHtml — strips HTML tags & decodes common HTML entities
// Microsoft Graph API returns email bodies as full HTML documents.
// We strip them before saving to DB so the frontend renders clean plain text,
// but preserve rich sanitized tables when present.
// ─────────────────────────────────────────────────────────────────────────────
const stripHtml = (str) => {
    if (!str) return '';

    // Check if the content contains HTML table markup
    const hasTable = /<\s*table[\s>]/i.test(str);

    if (hasTable) {
        // PRESERVE TABLE STRUCTURE: Clean scripts/styles/Office XML junk but keep table elements and paragraph breaks
        let clean = str
            .replace(/<style[\s\S]*?<\/style>/gi, '') // remove <style> blocks
            .replace(/<script[\s\S]*?<\/script>/gi, '') // remove <script> blocks
            .replace(/<head[\s\S]*?<\/head>/gi, '') // remove <head> blocks
            .replace(/<xml[\s\S]*?<\/xml>/gi, '') // remove Office XML blocks
            .replace(/<!--[\s\S]*?-->/gi, '') // remove HTML comments
            .replace(/<\/?o:[^>]*>/gi, '') // remove Outlook <o:p> tags
            .replace(/<\/?w:[^>]*>/gi, '') // remove Word <w:...> tags
            .replace(/<\/?m:[^>]*>/gi, '') // remove MathML <m:...> tags
            .replace(/<\/?font[^>]*>/gi, '') // remove <font>
            .replace(/<\/?span[^>]*>/gi, '') // remove <span>
            .replace(/<br\s*\/?>/gi, '<br/>')
            .replace(/<p\s+[^>]*>/gi, '<p>')
            .replace(/<div\s+[^>]*>/gi, '<div>')
            .replace(/<\/div>/gi, '</div>');

        // Clean table tag attributes to eliminate bloated MSO/Word styles while keeping colspan/rowspan
        clean = clean.replace(/<table\b[^>]*>/gi, '<table class="edgestone-table">');
        clean = clean.replace(/<tr\b[^>]*>/gi, '<tr>');
        clean = clean.replace(/<th\b([^>]*)>/gi, (match, attrs) => {
            const colspan = attrs.match(/colspan=["']?(\d+)["']?/i);
            const rowspan = attrs.match(/rowspan=["']?(\d+)["']?/i);
            const extra = [colspan ? `colspan="${colspan[1]}"` : '', rowspan ? `rowspan="${rowspan[1]}"` : ''].filter(Boolean).join(' ');
            return `<th${extra ? ' ' + extra : ''}>`;
        });
        clean = clean.replace(/<td\b([^>]*)>/gi, (match, attrs) => {
            const colspan = attrs.match(/colspan=["']?(\d+)["']?/i);
            const rowspan = attrs.match(/rowspan=["']?(\d+)["']?/i);
            const extra = [colspan ? `colspan="${colspan[1]}"` : '', rowspan ? `rowspan="${rowspan[1]}"` : ''].filter(Boolean).join(' ');
            return `<td${extra ? ' ' + extra : ''}>`;
        });

        // Strip any remaining unwanted tags outside allowed whitelist
        clean = clean.replace(/<(?!\/?(?:table|thead|tbody|tfoot|tr|th|td|p|br|b|strong|i|em|ul|ol|li|a)\b)[^>]+>/gi, '');

        // Decode common entities
        clean = clean
            .replace(/&nbsp;/gi, ' ')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .trim();

        return clean;
    }

    // Standard plain-text stripping when no table is present
    return str
        .replace(/<style[\s\S]*?<\/style>/gi, '') // remove <style> blocks entirely
        .replace(/<script[\s\S]*?<\/script>/gi, '') // remove <script> blocks
        .replace(/<br\s*\/?>/gi, '\n') // <br> → newline
        .replace(/<\/p>/gi, '\n') // </p> → newline
        .replace(/<\/div>/gi, '\n') // </div> → newline
        .replace(/<[^>]+>/g, '') // strip remaining tags
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]{2,}/g, ' ') // collapse multiple spaces
        .replace(/\n{3,}/g, '\n\n') // collapse excessive newlines
        .trim();
};

// ─────────────────────────────────────────────────────────────────────────────
// stripQuotedReply — Removes quoted email history from plain text email body.
// ─────────────────────────────────────────────────────────────────────────────
const stripQuotedReply = (text) => {
    if (!text) return '';
    
    // Helper to check if a match index is safely outside an open HTML table
    const isInsideTable = (str, index) => {
        const lastTableOpen = str.lastIndexOf('<table', index);
        const lastTableClose = str.lastIndexOf('</table>', index);
        return lastTableOpen !== -1 && (lastTableClose === -1 || lastTableClose < lastTableOpen);
    };

    // 1. Outlook / Exchange Style
    let idx = text.search(/From:\s.*?\nSent:\s/i);
    if (idx !== -1 && !isInsideTable(text, idx)) text = text.substring(0, idx);

    // 2. Generic "Original Message" separator
    idx = text.search(/-+\s*Original Message\s*-+/i);
    if (idx !== -1 && !isInsideTable(text, idx)) text = text.substring(0, idx);

    // 3. Gmail Style "On [date], [name] wrote:"
    idx = text.search(/(?:^|\n)\s*On\s+[\s\S]{10,150}?wrote:/i);
    if (idx !== -1 && !isInsideTable(text, idx)) text = text.substring(0, idx);
    
    // 4. Sometimes Outlook includes "________________________________" before From:
    idx = text.search(/_{10,}/);
    if (idx !== -1 && !isInsideTable(text, idx)) text = text.substring(0, idx);

    return text.trim();
};

// List of generic/public webmail domains that must NOT be used for corporate domain matching
const GENERIC_PUBLIC_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'zoho.com', 'proton.me', 'protonmail.com',
    'mail.com', 'gmx.com', 'gmx.net', 'yandex.com', 'fastmail.com'
]);

/**
 * Checks if a given email belongs to a client:
 * 1. Exact match with any registered email in client.emails
 * 2. Matches a non-generic corporate domain extracted from client.emails
 */
const isEmailMatchingClientDomain = (email, client) => {
    if (!email || !client || !Array.isArray(client.emails) || client.emails.length === 0) {
        return false;
    }
    const cleanEmail = email.toLowerCase().trim();
    // Direct exact match with an existing registered email
    if (client.emails.some(e => e.toLowerCase().trim() === cleanEmail)) {
        return true;
    }
    const parts = cleanEmail.split('@');
    if (parts.length !== 2) return false;
    const senderDomain = parts[1].trim();

    // Generic/public domains cannot be used for cross-sender domain matching
    if (GENERIC_PUBLIC_DOMAINS.has(senderDomain) || senderDomain.includes('edgestone.in')) {
        return false;
    }

    // Extract valid corporate domains from the client's registered emails
    const clientCorporateDomains = client.emails
        .map(e => (e.split('@')[1] || '').toLowerCase().trim())
        .filter(d => d && !GENERIC_PUBLIC_DOMAINS.has(d) && !d.includes('edgestone.in'));

    return clientCorporateDomains.includes(senderDomain);
};

/**
 * Extracts CRQ / Change ID and Maintenance Scheduled Date from text.
 * Used for reliable deduplication so new maintenance activities never merge with past/unrelated tickets.
 */
const extractMaintenanceMetadata = (subject, body) => {
    const text = `${subject || ''} \n ${body || ''}`;
    
    // 1. Extract CRQ / Change ID (e.g. CRQ: "1100493081", Change ID 1100493081, CRQ00000123)
    let crqId = null;
    const crqMatch = text.match(/(?:CRQ|Change(?:\s*Request)?(?:\s*ID|\s*No|\s*Number)?|Activity\s*ID)[\s:"]*([A-Za-z0-9_-]{5,})/i);
    if (crqMatch) {
        crqId = crqMatch[1].trim();
    }

    // 2. Extract Maintenance Scheduled Date / Window (e.g. 31-OCT-2026, 24-OCT-2026, 2026-10-31)
    let maintDate = null;
    const dateMatch1 = text.match(/(?:scheduled\s*date|activity\s*date|maintenance\s*date|window(?:\s*start)?)[\s:"]*([0-9]{1,2}[-/.][A-Za-z0-9]+[-/.][0-9]{2,4})/i);
    if (dateMatch1) {
        maintDate = dateMatch1[1].trim().toUpperCase();
    } else {
        const dateMatch2 = text.match(/\b\d{1,2}-(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4}\b/i);
        if (dateMatch2) {
            maintDate = dateMatch2[0].trim().toUpperCase();
        }
    }

    return { crqId, maintDate };
};

/**
 * Determines whether an email address belongs to an EdgeStone internal agent, officer, or system address.
 * Matches @edgestone.in domain, MAIL_USER / SENDER_EMAIL, or records in Agent/User tables.
 */
const isInternalAgentEmail = async (email) => {
    if (!email) return false;
    const clean = String(email).trim().toLowerCase();
    if (clean.endsWith('@edgestone.in')) return true;
    const ownEmail = (process.env.SENDER_EMAIL || process.env.MAIL_USER || '').toLowerCase();
    if (ownEmail && clean === ownEmail) return true;
    try {
        const prisma = require('../../models/index');
        const agent = await prisma.agent.findFirst({
            where: {
                OR: [
                    { email: { equals: clean, mode: 'insensitive' } },
                    { emails: { has: clean } }
                ]
            }
        });
        if (agent) return true;
        const user = await prisma.user.findFirst({
            where: { email: { equals: clean, mode: 'insensitive' } }
        });
        if (user) return true;
    } catch (_) {}
    return false;
};

module.exports = {
    stripHtml,
    stripQuotedReply,
    GENERIC_PUBLIC_DOMAINS,
    isEmailMatchingClientDomain,
    extractMaintenanceMetadata,
    isInternalAgentEmail
};

