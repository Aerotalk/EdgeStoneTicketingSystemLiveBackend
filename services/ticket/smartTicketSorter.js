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
const MAINT_REGEX = /(?:emergency|planned|scheduled|urgent)?\s*maint(?:en|ain)[ae]nce|crq/i;
const PURE_MAINT_NOTICE_REGEX = /(?:emergency|planned|scheduled|urgent)\s*maint(?:en|ain)[ae]nce|crq\s*[-#:]*\s*\d+/i;
const INCIDENT_REGEX = /(?:flap|flapping|down|outage|rfo|issue|fault|alarm|los|degraded|packet\s*loss)/i;
const STRICT_INCIDENT_REGEX = /(?:flap|flapping|down|outage|rfo|packet\s*loss)/i;
const REPLY_PREFIX_REGEX = /^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/i;
const TICKET_TAG_REGEX = /(?:\[|【)#?[A-Za-z0-9_-]+?(?:-V)?(?:\]|】)/i;

const textOf = (subject, body) => `${subject || ''} \n ${body || ''}`;
const hasMaintenanceSignal = (subject, body) => MAINT_REGEX.test(textOf(subject, body));
const hasIncidentSignal = (subject, body) => INCIDENT_REGEX.test(textOf(subject, body));

// ─── 3. ROOT EMAIL DETECTION ────────────────────────────────────────────────
/**
 * A root email starts a brand-new conversation: no In-Reply-To / References,
 * no Re:/Fwd: prefix and no existing ticket tag such as [#1033] / [#V1031].
 */
const isRootEmail = ({ inReplyTo, references, subject } = {}) => {
    if (inReplyTo && String(inReplyTo).trim().length > 0) return false;
    if (references) {
        const refList = Array.isArray(references) ? references : String(references).split(/[\s,]+/);
        if (refList.some(r => r && String(r).trim().length > 0)) return false;
    }
    const sub = (subject || '').trim();
    if (REPLY_PREFIX_REGEX.test(sub)) return false;
    if (TICKET_TAG_REGEX.test(sub)) return false;
    return true;
};

// ─── 4. ORIGIN CLASSIFICATION ───────────────────────────────────────────────
/**
 * Classify by ticket ORIGIN, not by who the agent later emails.
 * A Maintenance ticket requires a vendor-originated email with maintenance
 * signals. Client emails mentioning maintenance remain Client Support tickets.
 */
const classifyOrigin = ({ ticketType, isVendorOrigin, subject, body }) => {
    const vendorOriginated = !!(isVendorOrigin || ticketType === 'Vendor');
    const isMaintenance = vendorOriginated && hasMaintenanceSignal(subject, body);
    return {
        category: isMaintenance ? 'Maintenance' : 'ClientSupport',
        isMaintenance,
        status: isMaintenance ? 'Maintenance' : 'Open'
    };
};

// ─── 5. REPLY VALIDATION BARRIERS ───────────────────────────────────────────
/** Incident / non-maintenance mail must never enter a Maintenance ticket. */
const isMaintenanceBarrierVeto = (candidate, { subject, body } = {}) => {
    if (!candidate) return false;
    const isMaint = candidate.isMaintenance || candidate.status === 'Maintenance';
    if (!isMaint) return false;

    // Direct thread continuation check: If this reply matches the ticket's subject or header, do NOT veto!
    const sub = (subject || '').toLowerCase().trim();
    const candHeader = (candidate.header || '').toLowerCase().trim();
    const normSub = sub.replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();
    const normHeader = candHeader.replace(/^(?:(?:re|fwd|fw|回复|答复|转发)[：:\s]+)+/gi, '').trim();
    if (normSub && normHeader && (normSub === normHeader || normSub.includes(normHeader) || normHeader.includes(normSub))) {
        return false; // Direct thread continuation for this maintenance ticket
    }

    // Check CRQ/Docket/Reference continuity on this maintenance ticket
    const fullText = `${subject || ''} ${body || ''}`;
    const crqMatch = fullText.match(/\b(CRQ[:\s“"'-]*\d{6,}|(?:UMW|RPO)\s*Reference\s*number\s*[A-Za-z0-9\\/_-]+|SR\d{6,}|INC\d{6,})\b/i);
    if (crqMatch && crqMatch[1]) {
        const numPart = crqMatch[1].match(/\d{6,}/)?.[0] || crqMatch[1];
        if (candHeader.toLowerCase().includes(numPart.toLowerCase())) {
            return false; // Same CRQ/docket/reference on this maintenance ticket
        }
    }

    // Strictly veto if an actual incident alarm/client complaint is trying to hijack a maintenance ticket
    if (STRICT_INCIDENT_REGEX.test(textOf(subject, body))) {
        logger.warn(`🚫 [SORTER:MAINTENANCE BARRIER] Blocked incident mail "${subject}" from Maintenance Ticket ${candidate.ticketId}.`);
        return true;
    }
    return false;
};

/** A vendor maintenance notice must never enter a Client Support ticket. */
const isClientSupportBarrierVeto = (candidate, { subject, body } = {}) => {
    if (!candidate) return false;
    if (candidate.ticketType === 'Client' && !candidate.isMaintenance) {
        const text = textOf(subject, body);
        if (PURE_MAINT_NOTICE_REGEX.test(text) && !STRICT_INCIDENT_REGEX.test(text)) {
            logger.warn(`🚫 [SORTER:CLIENT SUPPORT BARRIER] Blocked maintenance notice "${subject}" from Client Ticket ${candidate.ticketId}.`);
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
    hasMaintenanceSignal,
    hasIncidentSignal,
    isRootEmail,
    classifyOrigin,
    isMaintenanceBarrierVeto,
    isClientSupportBarrierVeto,
    isWithinActiveWindow,
    isValidReplyCandidate,
    toISTDate,
    getTicketDayMeta,
    buildDaySummary
};
