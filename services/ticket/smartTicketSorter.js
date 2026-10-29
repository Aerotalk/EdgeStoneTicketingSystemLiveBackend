'use strict';

/**
 * ============================================================================
 * SMART TICKET SORTER
 * ============================================================================
 * Single source of truth for every sorting decision in the ticketing pipeline:
 *
 *  1. Time boundaries      -> 28th Oct 2026 cutoff for new tickets / polling
 *  2. Root email detection -> first-time emails are NEVER treated as replies
 *  3. Origin classification-> Client Support vs Maintenance (by who originated it)
 *  4. Reply validation     -> circuit / maintenance / client-support / recency
 *                             barriers that stop replies landing in wrong tickets
 *  5. Day-wise tracking    -> per-ticket day metadata + daily summary buckets
 *
 * This module is pure (no DB, no email I/O) so it can be unit tested and is
 * safe to require from ingestion, threading, poller and API layers alike.
 * ============================================================================
 */

const logger = require('../../utils/logger');
const { extractMaintenanceMetadata, extractHistoricalIncidentDate, stripHtml } = require('./ticketSanitizer');

// ─── 1. TIME BOUNDARIES ─────────────────────────────────────────────────────
// New tickets / polled mail are only accepted from 28 Oct 2026 00:00 IST.
const FRESH_TICKET_MIN_DATE = new Date('2026-10-28T00:00:00+05:30');
// Existing tickets created from 26 Oct (including Airtel #V1030, #V1031) are allowed to receive replies.
const MIN_OPERATIONAL_DATE = new Date('2026-10-26T00:00:00.000Z');

const isBeforeCutoff = (date, cutoff = FRESH_TICKET_MIN_DATE) => {
    const d = date ? new Date(date) : new Date();
    return d < cutoff;
};

// ─── 2. TEXT SIGNALS ────────────────────────────────────────────────────────
const MAINT_REGEX = /(?:emergency|planned|scheduled|urgent)?\s*maint(?:en|ain)[ae]nce|planned\s*outage\s*notification|(?:umw|rpo)\s*reference|\bcrq\b|change\s*request/i;
const PURE_MAINT_NOTICE_REGEX = /(?:(?:emergency|planned|scheduled|urgent)\s*maint(?:en|ain)[ae]nce|maint(?:en|ain)[ae]nce\s*(?:activity|notification|notice|advisory|work|window)|planned\s*outage\s*notification|(?:umw|rpo)\s*reference\s*(?:number|no)?[\s:]*[a-z0-9\\/_-]+|\bcrq\s*[-#:"']*\s*\d+)/i;
const INCIDENT_REGEX = /(?:flap|flapping|down|outage|rfo|issue|fault|alarm|los|degraded|packet\s*loss)/i;
const STRICT_INCIDENT_REGEX = /(?:flap|flapping|down|outage|rfo|packet\s*loss)/i;
const SLA_REBATE_REGEX = /\b(?:sla\s*rebate|rebate\s*request|rebate\s*calculation|rebate\s*information|rebate\s*claim|credit\s*note|sla\s*credit|service\s*credit|sla\s*penalty|sla\s*compensation|billing\s*dispute|invoice\s*dispute|commercial\s*rebate)\b/i;
const REPLY_PREFIX_REGEX = /^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/i;
const TICKET_TAG_REGEX = /(?:\[|【)#?[A-Za-z0-9_-]+?(?:-V)?(?:\]|】)/i;
const VENDOR_APPENDED_SUFFIX_REGEX = /(?:\byj\d{8,}\s+\d{10,}|\|\s*neutrality\.one\s*#\d+)\s*$/i;

const textOf = (subject, body) => `${subject || ''} \n ${body || ''}`;

/**
 * Strips standard maintenance notification template lines that contain words like
 * "Outage", "down", or "fault" so maintenance advisories are never misclassified as incident alarms.
 */
const stripMaintenanceBoilerplate = (text) => {
    if (!text) return '';
    return String(text)
        .replace(/planned\s+outage\s+notification(?:\s+of\s+international\s+service)?/gi, ' ')
        .replace(/outage\s+description\s*:[^\r\n]*/gi, ' ')
        .replace(/impact\s*:\s*service\s+is\s+down\s+during\s+the\s+maintenance\s+period/gi, ' ')
        .replace(/shunt\s+fault\s+(?:cable\s+)?repair/gi, ' ')
        .replace(/no\s+outage\s+found/gi, ' ');
};

/**
 * Strips generic troubleshooting checklist phrases from client incident reports
 * (e.g., "Check for any maintenance activities, fiber issues...") so incident emails
 * are not misclassified as maintenance notices.
 */
const stripIncidentChecklistBoilerplate = (text) => {
    if (!text) return '';
    return String(text)
        .replace(/check\s+for\s+any\s+maint(?:en|ain)[ae]nce(?:\s+activities)?/gi, ' ')
        .replace(/whether\s+any\s+maint(?:en|ain)[ae]nce(?:\s+activity|\s+activities|\s+work)?/gi, ' ')
        .replace(/any\s+maint(?:en|ain)[ae]nce\s+activities\s*,\s*fiber\s+issues/gi, ' ')
        .replace(/no\s+planned\s+maint(?:en|ain)[ae]nce/gi, ' ');
};

/**
 * Detects whether an email is an SLA Rebate, Service Credit, or Commercial/Billing communication
 * rather than an operational network incident or maintenance notification.
 */
const isSlaRebateOrCommercialEmail = (subject, body) => {
    const cleanSub = stripHtml(subject || '').trim();
    const cleanBody = stripHtml(body || '').trim();
    if (SLA_REBATE_REGEX.test(cleanSub)) return true;
    // Check top of body (excluding quoted history)
    const topBody = cleanBody.split(/(?:-+\s*(?:Original Message|原始邮件)\s*-+|From:\s.*?\nSent:\s)/i)[0] || cleanBody;
    return SLA_REBATE_REGEX.test(topBody);
};

/**
 * Detects whether an email is a formal Maintenance Notification / Advisory
 * (either from a Vendor like PCCW/Airtel/Telstra or an EdgeStone "Maintenance Activity | <Circuit> | <Date>" notice).
 */
const isFormalMaintenanceNotice = (subject, body) => {
    if (isSlaRebateOrCommercialEmail(subject, body)) return false;
    const cleanSub = stripHtml(subject || '').trim();
    const cleanBody = stripHtml(body || '').trim();
    const combined = `${cleanSub} \n ${cleanBody}`;

    if (/^(?:(?:re|fwd|fw)[：:\s]+)*maint(?:en|ain)[ae]nce\s*activity\s*\|/i.test(cleanSub)) {
        return true;
    }
    if (PURE_MAINT_NOTICE_REGEX.test(cleanSub)) {
        return true;
    }
    if (PURE_MAINT_NOTICE_REGEX.test(combined)) {
        const meta = extractMaintenanceMetadata(cleanSub, cleanBody);
        if (meta.crqId || meta.maintDate || /wished\s+to\s+advise\s+you\s+that\s+the\s+following\s+network\s+activity/i.test(combined)) {
            return true;
        }
    }
    return false;
};

const hasStrictIncidentSignal = (subject, body) => {
    if (isFormalMaintenanceNotice(subject, body)) return false;
    if (isSlaRebateOrCommercialEmail(subject, body)) return false;
    const cleaned = stripMaintenanceBoilerplate(stripHtml(textOf(subject, body)));
    return STRICT_INCIDENT_REGEX.test(cleaned);
};

const hasIncidentSignal = (subject, body) => {
    if (isFormalMaintenanceNotice(subject, body)) return false;
    if (isSlaRebateOrCommercialEmail(subject, body)) return false;
    const cleaned = stripMaintenanceBoilerplate(stripHtml(textOf(subject, body)));
    return INCIDENT_REGEX.test(cleaned);
};

const hasMaintenanceSignal = (subject, body) => {
    if (isSlaRebateOrCommercialEmail(subject, body)) return false;
    if (isFormalMaintenanceNotice(subject, body)) return true;
    const cleanSub = stripIncidentChecklistBoilerplate(stripHtml(subject || ''));
    if (MAINT_REGEX.test(cleanSub)) return true;
    // If subject has a strict incident signal (e.g. "Link Flapped") and is not a formal maintenance notice,
    // do not let incidental word "maintenance" in the body checklist turn it into a maintenance email.
    if (STRICT_INCIDENT_REGEX.test(stripMaintenanceBoilerplate(cleanSub))) return false;
    const cleaned = stripIncidentChecklistBoilerplate(stripHtml(textOf(subject, body)));
    return MAINT_REGEX.test(cleaned);
};

/**
 * Extracts the CRQ/UMW/RPO ID and scheduled maintenance date (normalized YYYY-MM-DD)
 * associated with an existing candidate ticket from its header and replies.
 */
const extractCandidateMaintenanceMeta = (candidate) => {
    if (!candidate) return { crqId: null, maintDate: null };
    const headerMeta = extractMaintenanceMetadata(candidate.header || '', '');
    let crqId = headerMeta.crqId;
    let maintDate = headerMeta.maintDate;

    if ((!crqId || !maintDate) && Array.isArray(candidate.replies) && candidate.replies.length > 0) {
        for (const r of candidate.replies) {
            const rMeta = extractMaintenanceMetadata(r.subject || '', r.text || '');
            if (!crqId && rMeta.crqId) crqId = rMeta.crqId;
            if (!maintDate && rMeta.maintDate) maintDate = rMeta.maintDate;
            if (crqId && maintDate) break;
        }
    }
    return { crqId, maintDate };
};

/**
 * Checks if the incoming email has a scheduled maintenance date or CRQ/UMW/RPO reference
 * that conflicts with the candidate ticket.
 */
const hasMaintenanceScheduleConflict = (candidate, { subject, body } = {}) => {
    if (!candidate) return false;
    const incomingMeta = extractMaintenanceMetadata(subject, body);
    const candMeta = extractCandidateMaintenanceMeta(candidate);

    // 1. Explicit CRQ / UMW / RPO Reference mismatch
    if (incomingMeta.crqId && candMeta.crqId && incomingMeta.crqId.toUpperCase() !== candMeta.crqId.toUpperCase()) {
        logger.warn(`🚫 [SORTER:SCHEDULE BARRIER] Blocked "${subject}" (Ref: ${incomingMeta.crqId}) from Ticket ${candidate.ticketId} (Ref: ${candMeta.crqId}).`);
        return true;
    }

    // 2. Explicit Scheduled Maintenance Date mismatch (e.g., 2026-10-30 vs 2026-11-04 vs 2026-10-27)
    if (incomingMeta.maintDate && candMeta.maintDate && incomingMeta.maintDate !== candMeta.maintDate) {
        logger.warn(`🚫 [SORTER:SCHEDULE BARRIER] Blocked "${subject}" (Scheduled Date: ${incomingMeta.maintDate}) from Ticket ${candidate.ticketId} (Scheduled Date: ${candMeta.maintDate}).`);
        return true;
    }

    // 3. Outbound root "Maintenance Activity | <Circuit> | <Date>" notice must only merge into a ticket with the SAME scheduled date
    const cleanSub = (subject || '').trim();
    if (/^maint(?:en|ain)[ae]nce\s*activity\s*\|/i.test(cleanSub) && incomingMeta.maintDate) {
        if (!candMeta.maintDate || candMeta.maintDate !== incomingMeta.maintDate) {
            logger.warn(`🚫 [SORTER:SCHEDULE BARRIER] Blocked root Maintenance Activity notice "${subject}" (Date: ${incomingMeta.maintDate}) from Ticket ${candidate.ticketId} (Ticket Date: ${candMeta.maintDate || 'none'}).`);
            return true;
        }
    }

    return false;
};

// ─── 3. ROOT EMAIL DETECTION ────────────────────────────────────────────────
/**
 * A root email starts a brand-new conversation: no In-Reply-To / References,
 * no Re:/Fwd: prefix, no existing ticket tag such as [#1033] / [#V1031],
 * and not an automated vendor ticket reply quoting an earlier message.
 */
const isRootEmail = ({ inReplyTo, references, subject, body } = {}) => {
    if (inReplyTo && String(inReplyTo).trim().length > 0) return false;
    if (references) {
        const refList = Array.isArray(references) ? references : String(references).split(/[\s,]+/);
        if (refList.some(r => r && String(r).trim().length > 0)) return false;
    }
    const sub = (subject || '').trim();
    if (REPLY_PREFIX_REGEX.test(sub)) return false;
    if (TICKET_TAG_REGEX.test(sub)) return false;
    if (VENDOR_APPENDED_SUFFIX_REGEX.test(sub)) return false;
    if (body) {
        const cleanB = stripHtml(body);
        if (
            /(?:-+\s*(?:Original Message|原始邮件)\s*-+|From:\s.*?\nSent:\s)/i.test(cleanB) &&
            /(?:created\s+a\s+ticket|ticket\s+[\w-]+\]?\s+for\s+you|\byj\d{8,}\s+\d{10,}\b|\bneutrality\.one\s*#\d+\b)/i.test(`${sub} \n ${cleanB}`)
        ) {
            return false;
        }
    }
    return true;
};

// ─── 4. ORIGIN CLASSIFICATION ───────────────────────────────────────────────
/**
 * Classify by ticket ORIGIN, not by who the agent later emails.
 * A Maintenance ticket requires a vendor-originated email with maintenance
 * signals (and not a strict incident report), or an agent-originated formal
 * "Maintenance Activity | <Circuit> | <Date>" advisory.
 * Client emails mentioning maintenance remain Client Support tickets.
 */
const classifyOrigin = ({ ticketType, isVendorOrigin, isAgentOrigin, subject, body }) => {
    const vendorOriginated = ticketType === 'Vendor' || (!!isVendorOrigin && ticketType !== 'Client');
    const agentMaintOriginated = !!(isAgentOrigin && isFormalMaintenanceNotice(subject, body));
    const isMaintenance =
        (vendorOriginated && (isFormalMaintenanceNotice(subject, body) || (hasMaintenanceSignal(subject, body) && !hasStrictIncidentSignal(subject, body)))) ||
        agentMaintOriginated;
    return {
        category: isMaintenance ? 'Maintenance' : 'ClientSupport',
        isMaintenance,
        status: isMaintenance ? 'Maintenance' : 'Open'
    };
};

// ─── 5. REPLY VALIDATION BARRIERS ───────────────────────────────────────────
/**
 * Business-process & historical-incident barrier:
 * Prevents commercial/SLA rebate/billing emails (or emails referencing a past incident date)
 * from merging into active technical incident or maintenance tickets.
 */
const isBusinessProcessBarrierVeto = (candidate, { subject, body } = {}) => {
    if (!candidate) return false;

    const incomingIsRebate = isSlaRebateOrCommercialEmail(subject, body);
    const candidateIsRebate = isSlaRebateOrCommercialEmail(candidate.header || '', '');

    if (incomingIsRebate !== candidateIsRebate) {
        logger.warn(`🚫 [SORTER:BUSINESS PROCESS BARRIER] Blocked "${subject}" (Rebate/Commercial=${incomingIsRebate}) from Ticket ${candidate.ticketId} ("${candidate.header}", Rebate/Commercial=${candidateIsRebate}).`);
        return true;
    }

    // Check if the incoming email explicitly references a historical incident date that predates the candidate ticket
    const historicalDate = extractHistoricalIncidentDate(subject, body);
    const candidateHistoricalDate = extractHistoricalIncidentDate(candidate.header || '', '');
    if (historicalDate && candidateHistoricalDate && historicalDate !== candidateHistoricalDate) {
        logger.warn(`🚫 [SORTER:HISTORICAL INCIDENT BARRIER] Blocked "${subject}" (Incident Date: ${historicalDate}) from Ticket ${candidate.ticketId} (Incident Date: ${candidateHistoricalDate}).`);
        return true;
    }
    if (historicalDate && !candidateHistoricalDate && candidate.createdAt) {
        const histEndMs = new Date(`${historicalDate}T23:59:59.999Z`).getTime();
        const candCreatedMs = new Date(candidate.createdAt).getTime();
        // If the candidate ticket was created >36 hours after the historical incident date, it is a different event
        if (!isNaN(histEndMs) && !isNaN(candCreatedMs) && (candCreatedMs - histEndMs) > 36 * 60 * 60 * 1000) {
            logger.warn(`🚫 [SORTER:HISTORICAL INCIDENT BARRIER] Blocked "${subject}" (Historical Incident Date: ${historicalDate}) from active Ticket ${candidate.ticketId} (Created: ${new Date(candidate.createdAt).toISOString()}).`);
            return true;
        }
    }

    return false;
};

/** Incident / non-maintenance mail or conflicting maintenance schedule must never enter a Maintenance ticket. */
const isMaintenanceBarrierVeto = (candidate, { subject, body } = {}) => {
    if (!candidate) return false;

    // Enforce Scheduled Date & CRQ/UMW/RPO isolation across ALL tickets first
    if (hasMaintenanceScheduleConflict(candidate, { subject, body })) {
        return true;
    }

    // Note: If a Client Support ticket (ticketType === 'Client', isSlaActive === true) was historically
    // mis-tagged with status='Maintenance' despite having an incident header, treat it as a Client Support ticket.
    const isGenuineMaintCandidate =
        (candidate.isMaintenance || candidate.status === 'Maintenance') &&
        !(candidate.ticketType === 'Client' && candidate.isSlaActive && hasStrictIncidentSignal(candidate.header || '', ''));
    if (!isGenuineMaintCandidate) return false;

    // Direct thread continuation check: If this reply matches the ticket's subject or header, do NOT veto!
    const sub = (subject || '').toLowerCase().trim();
    const candHeader = (candidate.header || '').toLowerCase().trim();
    const normSub = sub.replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();
    const normHeader = candHeader.replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();
    if (normSub && normHeader && (normSub === normHeader || normSub.includes(normHeader) || normHeader.includes(normSub))) {
        return false; // Direct thread continuation for this maintenance ticket
    }

    // Check CRQ/Docket/Reference continuity on this maintenance ticket
    const incomingMeta = extractMaintenanceMetadata(subject, body);
    const candMeta = extractCandidateMaintenanceMeta(candidate);
    if (incomingMeta.crqId && candMeta.crqId && incomingMeta.crqId.toUpperCase() === candMeta.crqId.toUpperCase()) {
        return false;
    }
    if (incomingMeta.maintDate && candMeta.maintDate && incomingMeta.maintDate === candMeta.maintDate) {
        return false;
    }

    // Strictly veto if an actual incident alarm/client complaint is trying to hijack a maintenance ticket
    if (hasStrictIncidentSignal(subject, body)) {
        logger.warn(`🚫 [SORTER:MAINTENANCE BARRIER] Blocked incident mail "${subject}" from Maintenance Ticket ${candidate.ticketId}.`);
        return true;
    }
    return false;
};

/** A new maintenance notice for a different date/activity must never enter a Client Support ticket. */
const isClientSupportBarrierVeto = (candidate, { subject, body } = {}) => {
    if (!candidate) return false;

    // Enforce Scheduled Date & CRQ/UMW/RPO isolation first
    if (hasMaintenanceScheduleConflict(candidate, { subject, body })) {
        return true;
    }

    if (candidate.ticketType === 'Client' && !candidate.isMaintenance) {
        if (isFormalMaintenanceNotice(subject, body)) {
            const incomingMeta = extractMaintenanceMetadata(subject, body);
            const candMeta = extractCandidateMaintenanceMeta(candidate);
            const isSameCrq = incomingMeta.crqId && candMeta.crqId && incomingMeta.crqId.toUpperCase() === candMeta.crqId.toUpperCase();
            const isSameDate = incomingMeta.maintDate && candMeta.maintDate && incomingMeta.maintDate === candMeta.maintDate;
            const isReply = !isRootEmail({ subject });

            // Allow ONLY if this is a continuation reply (RE:) for the exact same maintenance activity already tracked on this ticket
            if (isReply && (isSameCrq || isSameDate)) {
                return false;
            }

            logger.warn(`🚫 [SORTER:CLIENT SUPPORT BARRIER] Blocked maintenance notice "${subject}" (Ref: ${incomingMeta.crqId || 'none'}, Date: ${incomingMeta.maintDate || 'none'}) from Client Ticket ${candidate.ticketId}.`);
            return true;
        }
    }
    return false;
};

/** Candidate must be inside the operational window (created on or after 26 Oct 2026). */
const isWithinActiveWindow = (candidate) => {
    if (!candidate) return false;
    if (!candidate.createdAt) return true;
    const created = new Date(candidate.createdAt);
    if (created < MIN_OPERATIONAL_DATE) {
        logger.warn(`🚫 [SORTER:RECENCY BARRIER] Rejected ${candidate.ticketId} (created ${created.toISOString()}).`);
        return false;
    }
    return true;
};

/**
 * Unified double-check run on EVERY reply candidate before an email is attached.
 * @param {object}   candidate               ticket record
 * @param {object}   ctx                     { subject, body, isCircuitCompatible(circuitId, label) }
 */
const isValidReplyCandidate = (candidate, ctx = {}) => {
    if (!candidate) return false;
    if (!isWithinActiveWindow(candidate)) return false;
    if (typeof ctx.isCircuitCompatible === 'function' &&
        !ctx.isCircuitCompatible(candidate.circuitId, candidate.ticketId)) return false;
    if (isBusinessProcessBarrierVeto(candidate, ctx)) return false;
    if (isMaintenanceBarrierVeto(candidate, ctx)) return false;
    if (isClientSupportBarrierVeto(candidate, ctx)) return false;
    return true;
};

// ─── 6. DAY-WISE TRACKING ───────────────────────────────────────────────────
const toISTDate = (value) => {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
};

const OPEN_STATES = ['open', 'in progress', 'in-progress', 'maintenance'];

/**
 * Day-wise metadata for ONE ticket. Ticket identity never changes; only the
 * activity dates and state buckets are derived for the requested day.
 */
const getTicketDayMeta = (ticket, today = toISTDate(new Date())) => {
    const replies = Array.isArray(ticket.replies) ? ticket.replies : [];
    const latest = replies.length ? replies[replies.length - 1] : null;
    const createdDate = toISTDate(ticket.createdAt);
    const lastActivityAt = latest ? latest.createdAt : ticket.createdAt;
    const lastActivityDate = toISTDate(lastActivityAt);
    const lastActor = latest ? latest.type : (ticket.ticketType === 'Vendor' ? 'vendor' : 'client');
    const status = String(ticket.status || '').toLowerCase();
    const isOpen = OPEN_STATES.includes(status);
    const isMaint = !!(ticket.isMaintenance || ticket.ticketType === 'Vendor');

    return {
        createdDate,
        lastActivityAt,
        lastActivityDate,
        lastActor,
        isMaintenance: isMaint,
        newSupportToday: !isMaint && createdDate === today,
        newMaintenanceToday: isMaint && createdDate === today,
        repliedToday: replies.some(r => toISTDate(r.createdAt) === today && r.type !== 'agent'),
        activeToday: lastActivityDate === today || createdDate === today,
        needsAgentAction: isOpen && (lastActor === 'client' || lastActor === 'vendor'),
        awaitingResponse: isOpen && lastActor === 'agent',
        carriedForward: isOpen && !!createdDate && createdDate < today,
        resolvedToday: ['closed', 'resolved'].includes(status) && lastActivityDate === today
    };
};

/** Daily summary buckets (ticket ids per bucket) for a list of tickets. */
const buildDaySummary = (tickets = [], today = toISTDate(new Date())) => {
    const summary = {
        date: today,
        newSupport: [], newMaintenance: [], repliedToday: [], activeToday: [],
        needsAgentAction: [], awaitingResponse: [], carriedForward: [], resolvedToday: []
    };
    for (const t of tickets) {
        const m = getTicketDayMeta(t, today);
        if (m.newSupportToday) summary.newSupport.push(t.ticketId);
        if (m.newMaintenanceToday) summary.newMaintenance.push(t.ticketId);
        if (m.repliedToday) summary.repliedToday.push(t.ticketId);
        if (m.activeToday) summary.activeToday.push(t.ticketId);
        if (m.needsAgentAction) summary.needsAgentAction.push(t.ticketId);
        if (m.awaitingResponse) summary.awaitingResponse.push(t.ticketId);
        if (m.carriedForward) summary.carriedForward.push(t.ticketId);
        if (m.resolvedToday) summary.resolvedToday.push(t.ticketId);
    }
    return summary;
};

module.exports = {
    FRESH_TICKET_MIN_DATE,
    MIN_OPERATIONAL_DATE,
    isBeforeCutoff,
    isSlaRebateOrCommercialEmail,
    isFormalMaintenanceNotice,
    hasMaintenanceSignal,
    hasIncidentSignal,
    hasStrictIncidentSignal,
    extractCandidateMaintenanceMeta,
    hasMaintenanceScheduleConflict,
    isRootEmail,
    classifyOrigin,
    isBusinessProcessBarrierVeto,
    isMaintenanceBarrierVeto,
    isClientSupportBarrierVeto,
    isWithinActiveWindow,
    isValidReplyCandidate,
    toISTDate,
    getTicketDayMeta,
    buildDaySummary
};
