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

    // 2. Generic "Original Message" separator (English & Chinese/Vendor)
    idx = text.search(/-+\s*(?:Original Message|原始邮件)\s*-+/i);
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

const MONTH_MAP = {
    JAN: '01', JANUARY: '01',
    FEB: '02', FEBRUARY: '02',
    MAR: '03', MARCH: '03',
    APR: '04', APRIL: '04',
    MAY: '05',
    JUN: '06', JUNE: '06',
    JUL: '07', JULY: '07',
    AUG: '08', AUGUST: '08',
    SEP: '09', SEPT: '09', SEPTEMBER: '09',
    OCT: '10', OCTOBER: '10',
    NOV: '11', NOVEMBER: '11',
    DEC: '12', DECEMBER: '12'
};

/**
 * Normalizes a date string (DD/MM/YYYY, DD-MMM-YYYY, YYYY-MM-DD) into canonical YYYY-MM-DD format
 * so maintenance dates across vendor and EdgeStone formats can be compared reliably.
 */
const normalizeDateToken = (rawDate) => {
    if (!rawDate) return null;
    const clean = String(rawDate).trim().toUpperCase();

    // 1. YYYY-MM-DD or YYYY/MM/DD
    let m = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) {
        return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }

    // 2. DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    m = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (m) {
        const day = m[1].padStart(2, '0');
        const month = m[2].padStart(2, '0');
        const year = m[3].length === 2 ? `20${m[3]}` : m[3];
        if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
            return `${year}-${month}-${day}`;
        }
    }

    // 3. DD-MMM-YYYY or DD MMM YYYY or DD/MMM/YYYY (also supports ordinals like 21ST OCTOBER, 2026 or 29TH OCT'2026)
    m = clean.replace(/(\d{1,2})(?:ST|ND|RD|TH)\b/g, '$1').match(/^(\d{1,2})[-/\s.,']+([A-Z]{3,9})[-/\s.,']+(\d{2,4})$/);
    if (m && MONTH_MAP[m[2]]) {
        const day = m[1].padStart(2, '0');
        const month = MONTH_MAP[m[2]];
        const year = m[3].length === 2 ? `20${m[3]}` : m[3];
        return `${year}-${month}-${day}`;
    }

    return clean;
};

/**
 * Normalizes a circuit identifier by stripping lifecycle prefixes (temp/original/old/new),
 * collapsing whitespace and hyphen separators, and uppercasing for consistent comparison.
 */
const normalizeCircuitId = (rawId) => {
    if (!rawId) return '';
    return String(rawId)
        .replace(/^(?:original|temp|temporary|old|new)[\s-_:]+/i, '')
        .trim()
        .replace(/[\s_-]+/g, '-')
        .toUpperCase();
};

/**
 * Extracts an explicit historical or reported incident date (YYYY-MM-DD) from subject/body
 * (e.g., "Link down issue on 21st October, 2026" or "Reported incident (date/time ) :- Wed 21-10-2026").
 */
const extractHistoricalIncidentDate = (subject, body) => {
    const cleanSubject = stripHtml(subject || '');
    const cleanBody = stripQuotedReply(stripHtml(body || '')) || stripHtml(body || '');
    const combined = `${cleanSubject} \n ${cleanBody}`;

    // 1. Subject/Body phrasing: "issue on 21st October, 2026" / "reported issue on 29th Oct'2026"
    const phraseMatch = combined.match(/(?:issue|outage|flap(?:ped|ping)?|down|incident)\s+(?:reported\s+)?(?:issue\s+)?on\s+(\d{1,2}(?:st|nd|rd|th)?[\s,/'-]+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s,/'-]+\d{2,4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i);
    if (phraseMatch && phraseMatch[1]) {
        const norm = normalizeDateToken(phraseMatch[1]);
        if (norm && /^\d{4}-\d{2}-\d{2}$/.test(norm)) return norm;
    }

    // 2. Structured table/body field: "Reported incident (date/time ) :- Wed 21-10-2026"
    const labeledMatch = combined.match(/(?:reported\s+incident(?:\s*\([^)]*\))?|incident\s+date(?:\s*&\s*time)?|outage\s+date(?:\s*&\s*time)?)[\s:=-]*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[\s,.-]+)?(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}(?:st|nd|rd|th)?[\s,/'-]+[a-z]{3,9}[\s,/'-]+\d{2,4})/i);
    if (labeledMatch && labeledMatch[1]) {
        const norm = normalizeDateToken(labeledMatch[1]);
        if (norm && /^\d{4}-\d{2}-\d{2}$/.test(norm)) return norm;
    }

    return null;
};

/**
 * Extracts CRQ / Change ID / UMW / RPO Reference and Maintenance Scheduled Date from text.
 * Used for reliable deduplication so new maintenance activities never merge with past/unrelated tickets.
 */
const extractMaintenanceMetadata = (subject, body) => {
    const cleanSubject = stripHtml(subject || '');
    const cleanBodyFull = stripHtml(body || '');
    const cleanBodyTop = stripQuotedReply(cleanBodyFull) || cleanBodyFull;

    const scanForCrq = (txt) => {
        if (!txt) return null;
        // 1a. PCCW UMW / RPO Reference Number (e.g. U4584\26F, R7023\26E, U4582\26F)
        const umwMatch = txt.match(/(?:UMW|RPO)\s*Reference(?:\s*Number|\s*No)?[\s:"]*([A-Za-z0-9\\/_-]{4,})/i);
        if (umwMatch && /\d/.test(umwMatch[1])) {
            return umwMatch[1].trim().toUpperCase();
        }
        // 1b. Standard CRQ / Change ID / Activity ID / Ticket Reference Number
        const crqRegex = /(?:CRQ|Change(?:\s*Request)?(?:\s*ID|\s*No|\s*Number)?|Activity\s*ID|Ticket\s*Reference(?:\s*Number|\s*No)?)[\s:#"'-]*([A-Za-z0-9\\/_-]{4,})/gi;
        let match;
        while ((match = crqRegex.exec(txt)) !== null) {
            const candidate = match[1].trim();
            if (/\d/.test(candidate) && !/^(?:NUMBER|NO|ID|REF|REFERENCE|NULL|NONE)$/i.test(candidate)) {
                return candidate.toUpperCase();
            }
        }
        return null;
    };

    const scanForMaintDate = (subTxt, bodyTxt) => {
        const combined = `${subTxt || ''} \n ${bodyTxt || ''}`;

        // 2a. EdgeStone Subject Format: "Maintenance Activity | <Circuit> | DD/MM/YYYY"
        const pipeSubMatch = (subTxt || '').match(/maint(?:en|ain)[ae]nce\s*activity\s*\|\s*[^|]+\|\s*([0-9]{1,2}[-/.][A-Za-z0-9]+[-/.][0-9]{2,4})/i);
        if (pipeSubMatch) {
            return normalizeDateToken(pipeSubMatch[1]);
        }

        // 2b. Labeled Date Time / Scheduled Date / Activity Date / Maintenance Date / Window
        const labeledMatch = combined.match(/(?:date\s*(?:&\s*)?time|scheduled\s*date|activity\s*date|maintenance\s*date|start\s*date(?:\s*&\s*time)?|window(?:\s*start)?)[\s:"]*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{2,4}|[0-9]{1,2}[-/\s.][A-Za-z]{3,9}[-/\s.][0-9]{2,4}|[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})/i);
        if (labeledMatch) {
            return normalizeDateToken(labeledMatch[1]);
        }

        // 2c. Date range window e.g. "27/10/2026 12:00:00 to 01/11/2026 23:59:00 GMT"
        const rangeMatch = combined.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\s+\d{1,2}:\d{2}(?::\d{2})?\s+to\s+\d{1,2}\/\d{1,2}\/\d{4}\b/i);
        if (rangeMatch) {
            return normalizeDateToken(rangeMatch[1]);
        }

        // 2d. Standalone DD-MMM-YYYY (e.g. 30-OCT-2026)
        const dmyMatch = combined.match(/\b(\d{1,2}-(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4})\b/i);
        if (dmyMatch) {
            return normalizeDateToken(dmyMatch[1]);
        }

        return null;
    };

    const crqId = scanForCrq(`${cleanSubject} \n ${cleanBodyTop}`) || scanForCrq(cleanBodyFull);
    const maintDate = scanForMaintDate(cleanSubject, cleanBodyTop) || scanForMaintDate(cleanSubject, cleanBodyFull);

    return { crqId, maintDate };
};

/**
 * Extracts searchable circuit tokens from a raw circuit ID or supplier PO string.
 * Splits compound supplier circuit strings (e.g., "SR247976: MSL(PCG)-SNG(PCG) EP8201 S0049516"
 * or "SR247976 SR258964") into individual alphanumeric identifiers ("SR247976", "EP8201", "S0049516").
 */
const extractTokensFromCircuitId = (id) => {
    if (!id) return [];
    const raw = String(id).trim();
    if (!raw) return [];
    const tokens = [raw];

    const stripped = raw.replace(/^(?:original|temp|temporary|old|new)[\s-_:]+/i, '').trim();
    if (stripped && stripped !== raw && stripped.length > 2) {
        tokens.push(stripped);
    }

    // Generate whitespace/hyphen normalized variants for multi-part circuit IDs (e.g. "G773 276" <-> "G773-276")
    if (stripped.length >= 5 && /[A-Za-z]/.test(stripped) && /\d/.test(stripped) && /[\s-]/.test(stripped)) {
        const hyphenated = stripped.replace(/\s+/g, '-');
        const spaced = stripped.replace(/-+/g, ' ');
        if (hyphenated && !tokens.includes(hyphenated)) tokens.push(hyphenated);
        if (spaced && !tokens.includes(spaced)) tokens.push(spaced);
    }

    // Split compound strings on whitespace, colons, commas, semicolons, or pipes
    const parts = stripped.split(/[\s,:;|]+/).map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
        if (
            part.length >= 5 &&
            /\d/.test(part) &&
            !/^(?:202\d|\d+(?:G|M|K)?(?:BPS|GE|B|E)|STM\d+)$/i.test(part) &&
            !tokens.includes(part)
        ) {
            tokens.push(part);
        }
    }

    // Also extract standalone 6+ digit numeric sequences
    const numMatches = stripped.match(/\b\d{6,}\b/g) || [];
    for (const nm of numMatches) {
        if (!tokens.includes(nm)) {
            tokens.push(nm);
        }
    }

    return tokens;
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
    normalizeDateToken,
    normalizeCircuitId,
    extractHistoricalIncidentDate,
    extractMaintenanceMetadata,
    extractTokensFromCircuitId,
    isInternalAgentEmail
};

