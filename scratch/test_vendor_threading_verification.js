const ticketService = require('../services/ticketService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
    console.log('--- Testing Threading Fixes for Airtel and PCCW ---');
    try {
        // Test 1: Bharti Airtel CRQ 1100494638 update (should thread into #V1031)
        const airtel1Res = await ticketService.findExistingTicketForReply(
            null,
            null,
            'RE: CRQ: “1100494638” Planned Maintenance activity, is scheduled on 19-OCT-2026 – Planned | Edgestone Singapore Pte Ltd',
            'Dear Customer, maintenance update for CRQ 1100494638',
            'changemgmt@airtel.com'
        );
        console.log('Test 1 (Airtel CRQ 1100494638): Matched Ticket ->', airtel1Res?.ticketId, '(Expected: #V1031 or #V1035)');

        // Test 2: Bharti Airtel CRQ 1100488280 update (should thread into #V1030)
        const airtel2Res = await ticketService.findExistingTicketForReply(
            null,
            null,
            'RE: CRQ: “1100488280” Planned Maintenance activity, scheduled on 24-OCT-2026 – Rescheduled | Edgestone Singapore Pte Ltd',
            'Dear Customer, rescheduled maintenance CRQ 1100488280',
            'changemgmt@airtel.com'
        );
        console.log('Test 2 (Airtel CRQ 1100488280): Matched Ticket ->', airtel2Res?.ticketId, '(Expected: #V1030 or #V1036)');

        // Test 3: PCCW SR247976 INC000011690743 (should thread into #V1034)
        const pccw1Res = await ticketService.findExistingTicketForReply(
            null,
            null,
            'Re: SR247976: MSL(PCG)-SNG(PCG) EP8201 | S0049516 INC000011690743',
            'Dear Customer, update on SR247976 INC000011690743',
            'hkfmc@pccwglobal.com'
        );
        console.log('Test 3 (PCCW SR247976): Matched Ticket ->', pccw1Res?.ticketId, '(Expected: #V1034 or #V1040)');

        // Test 4: PCCW Planned Outage R7023\26E INC000011679206 (should thread into #V1041)
        const pccw2Res = await ticketService.findExistingTicketForReply(
            null,
            null,
            'RE: Planned Outage Notification of International Service -RPO Reference number R7023\\26E - INC000011679206',
            'Dear Customer, outage notification RPO Reference number R7023\\26E',
            'gsoc-planned-event@pccwglobal.com'
        );
        console.log('Test 4 (PCCW R7023 Planned Outage): Matched Ticket ->', pccw2Res?.ticketId, '(Expected: #V1041 or #V1042)');

        // Test 5: Orphan reply email with RE: that has no matching ticket in DB
        const orphanRes = await ticketService.createTicketFromEmail({
            from: 'gsoc-planned-event@pccwglobal.com',
            fromName: 'PCCW Global',
            subject: 'RE: Completely Unknown Old Maintenance Thread Reference 999999',
            body: 'Dear customer, old thread reply.',
            date: new Date()
        });
        console.log('Test 5 (Orphan RE: email without root ticket): Result ->', orphanRes ? orphanRes.ticketId : 'Blocked/Null', '(Expected: Blocked/Null)');

    } catch (e) {
        console.error('Test failed with error:', e);
    } finally {
        await prisma.$disconnect();
    }
}
test();
