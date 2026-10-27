'use strict';

// Pure unit tests for services/ticket/smartTicketSorter.js (no DB required)
const S = require('../services/ticket/smartTicketSorter');

let passed = 0, failed = 0;
const check = (cond, msg) => { cond ? (passed++, console.log(`✅ ${msg}`)) : (failed++, console.error(`❌ ${msg}`)); };

// Root email detection
check(S.isRootEmail({ subject: 'Link Flapping || CKT ID : X' }) === true, 'plain subject is a root email');
check(S.isRootEmail({ subject: 'Re: Link Flapping' }) === false, 'Re: prefix is not root');
check(S.isRootEmail({ subject: 'Hello', inReplyTo: '<a@b>' }) === false, 'In-Reply-To is not root');
check(S.isRootEmail({ subject: 'Hello', references: '<a@b> <c@d>' }) === false, 'References is not root');
check(S.isRootEmail({ subject: 'Update [#1033] flap' }) === false, 'ticket tag is not root');

// Cutoff
check(S.isBeforeCutoff('2026-10-27T23:59:00+05:30') === true, '27 Oct 23:59 IST is before cutoff');
check(S.isBeforeCutoff('2026-10-28T00:00:01+05:30') === false, '28 Oct 00:00:01 IST is accepted');

// Origin classification
check(S.classifyOrigin({ isVendorOrigin: true, subject: 'Planned Maintenance CRQ-1', body: '' }).isMaintenance === true, 'vendor + maintenance => Maintenance');
check(S.classifyOrigin({ isVendorOrigin: false, ticketType: 'Client', subject: 'Maintenance question', body: '' }).isMaintenance === false, 'client mentioning maintenance => Client Support');

// Barriers
const maint = { ticketId: '#V1', isMaintenance: true, status: 'Maintenance', createdAt: '2026-10-28T01:00:00Z' };
const client = { ticketId: '#1', ticketType: 'Client', isMaintenance: false, status: 'Open', createdAt: '2026-10-28T01:00:00Z' };
check(S.isMaintenanceBarrierVeto(maint, { subject: 'Re: link flapping RFO', body: '' }) === true, 'incident blocked from Maintenance ticket');
check(S.isMaintenanceBarrierVeto(maint, { subject: 'Maintenance completed CRQ-1', body: '' }) === false, 'maintenance follow-up allowed into Maintenance ticket');
check(S.isClientSupportBarrierVeto(client, { subject: 'Planned Maintenance CRQ-123', body: '' }) === true, 'maintenance notice blocked from Client ticket');
check(S.isValidReplyCandidate({ ...client, createdAt: '2026-10-20T00:00:00Z' }, {}) === false, 'old ticket rejected by recency window');
check(S.isValidReplyCandidate(client, { subject: 'Re: update', body: '', isCircuitCompatible: () => false }) === false, 'circuit mismatch rejected');
check(S.isValidReplyCandidate(client, { subject: 'Re: update', body: '', isCircuitCompatible: () => true }) === true, 'valid candidate accepted');

// Day-wise
const today = '2026-10-28';
const tickets = [
    { ticketId: '#1', ticketType: 'Client', status: 'Open', createdAt: '2026-10-28T05:00:00Z', replies: [{ type: 'client', createdAt: '2026-10-28T05:00:00Z' }] },
    { ticketId: '#V2', ticketType: 'Vendor', isMaintenance: true, status: 'Maintenance', createdAt: '2026-10-28T06:00:00Z', replies: [{ type: 'vendor', createdAt: '2026-10-28T06:00:00Z' }] },
    { ticketId: '#3', ticketType: 'Client', status: 'Open', createdAt: '2026-10-27T05:00:00Z', replies: [{ type: 'client', createdAt: '2026-10-27T05:00:00Z' }, { type: 'agent', createdAt: '2026-10-27T06:00:00Z' }] },
    { ticketId: '#4', ticketType: 'Client', status: 'Closed', createdAt: '2026-10-27T05:00:00Z', replies: [{ type: 'agent', createdAt: '2026-10-28T04:00:00Z' }] }
];
const sum = S.buildDaySummary(tickets, today);
check(sum.newSupport.join() === '#1', 'day summary: new support = #1');
check(sum.newMaintenance.join() === '#V2', 'day summary: new maintenance = #V2');
check(sum.carriedForward.join() === '#3', 'day summary: carried forward = #3');
check(sum.awaitingResponse.join() === '#3', 'day summary: awaiting response = #3');
check(sum.needsAgentAction.includes('#1') && sum.needsAgentAction.includes('#V2'), 'day summary: needs action includes #1 and #V2');
check(sum.resolvedToday.join() === '#4', 'day summary: resolved today = #4');

console.log(`\nSUMMARY: ${passed} PASSED, ${failed} FAILED`);
process.exit(failed ? 1 : 0);
