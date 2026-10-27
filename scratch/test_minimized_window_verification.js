'use strict';

const prisma = require('../models/index');
const { findExistingTicketForReply } = require('../services/ticket/ticketThreadingService');

async function runTests() {
    console.log('🧪 ========================================================');
    console.log('🧪 VERIFYING MINIMIZED OPERATIONAL WINDOW & TICKET MATCHING');
    console.log('🧪 ========================================================\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Subject explicitly quoting an old ticket from before 27th Oct (e.g. [#V1031] or [#1026])
    console.log('--- Test 1: Incoming email with [#V1031] (created 26th Oct) ---');
    const resultOldTicket = await findExistingTicketForReply(
        null,
        null,
        'Re: [#V1031] Planned Airtel Maintenance Notice',
        'Testing reply to old ticket',
        'airtel.noc@airtel.com'
    );
    if (resultOldTicket === null) {
        console.log('✅ PASSED: Ticket #V1031 (from 26th Oct) was rejected because it precedes the 27th/28th active window.\n');
        passed++;
    } else {
        console.error(`❌ FAILED: Unexpectedly matched old ticket ${resultOldTicket.ticketId}\n`);
        failed++;
    }

    // Test 2: Subject explicitly quoting an old ticket [#1026] (created 16th Oct)
    console.log('--- Test 2: Incoming email with [#1026] (created 16th Oct) ---');
    const resultOld1026 = await findExistingTicketForReply(
        null,
        null,
        'Re: [#1026] Old Outage',
        'Testing reply to old 16th Oct ticket',
        'customer@test.com'
    );
    if (resultOld1026 === null) {
        console.log('✅ PASSED: Ticket #1026 (from 16th Oct) was rejected because it precedes the 27th/28th active window.\n');
        passed++;
    } else {
        console.error(`❌ FAILED: Unexpectedly matched old ticket ${resultOld1026.ticketId}\n`);
        failed++;
    }

    // Test 3: Incoming email quoting active ticket [#1033] (created 27th Oct)
    console.log('--- Test 3: Incoming email with [#1033] (created 27th Oct) ---');
    const resultActive1033 = await findExistingTicketForReply(
        null,
        null,
        'Re: [#1033] Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request',
        'Customer reply on today\'s incident',
        'noc@neutrality.one'
    );
    if (resultActive1033 && resultActive1033.ticketId === '#1033') {
        console.log('✅ PASSED: Ticket #1033 (27th Oct) matched cleanly within the active operational window.\n');
        passed++;
    } else {
        console.error(`❌ FAILED: Expected #1033, got: ${resultActive1033?.ticketId}\n`);
        failed++;
    }

    // Test 4: Incoming email with incident context + circuit N1/SG1-MUM/ESPL-007
    console.log('--- Test 4: Subject match on circuit N1/SG1-MUM/ESPL-007 ---');
    const resultIncident = await findExistingTicketForReply(
        null,
        null,
        'Re: Link Flapping || CKT ID : CAR12MUMSNG005533 || 27th OCT 2026 || ticket EN_IM_27102026_603516',
        'Update from Vodafone engineer: link stable',
        'ebill.support@vodafoneidea.com'
    );
    if (resultIncident && resultIncident.ticketId === '#1033') {
        console.log('✅ PASSED: Vodafone fault update routed to active incident #1033 (did NOT touch #V1031).\n');
        passed++;
    } else {
        console.error(`❌ FAILED: Expected #1033, got: ${resultIncident?.ticketId}\n`);
        failed++;
    }

    // Test 5: Check database state of #V1031 and #1033
    console.log('--- Test 5: Verify Ticket Structure in Database ---');
    const tV1031 = await prisma.ticket.findFirst({
        where: { ticketId: '#V1031' },
        include: { replies: true }
    });
    const t1033 = await prisma.ticket.findFirst({
        where: { ticketId: '#1033' },
        include: { replies: true }
    });

    const v1031ClientReplies = (tV1031.replies || []).filter(r => r.category === 'client');
    const v1031VendorReplies = (tV1031.replies || []).filter(r => r.category?.startsWith('vendor'));
    const t1033ClientReplies = (t1033.replies || []).filter(r => r.category === 'client');
    const t1033VendorReplies = (t1033.replies || []).filter(r => r.category?.startsWith('vendor'));

    console.log(`#V1031: ${v1031ClientReplies.length} client replies, ${v1031VendorReplies.length} vendor replies.`);
    console.log(`#1033: ${t1033ClientReplies.length} client replies, ${t1033VendorReplies.length} vendor replies.`);

    if (v1031ClientReplies.length === 0 && v1031VendorReplies.length === 3 && t1033ClientReplies.length === 7 && t1033VendorReplies.length === 11) {
        console.log('✅ PASSED: Database state is 100% clean and accurately partitioned.\n');
        passed++;
    } else {
        console.error('❌ FAILED: Unexpected reply counts.\n');
        failed++;
    }

    console.log(`Summary: ${passed} PASSED, ${failed} FAILED.`);
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test execution error:', err);
    process.exit(1);
});
