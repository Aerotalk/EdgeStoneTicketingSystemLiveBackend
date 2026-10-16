const ticketService = require('../services/ticketService');
const prisma = require('../models/index');

async function testMatching() {
    console.log('--- TEST 1: Airtel Link Flapping with "TT for" ---');
    const airtelMatch = await ticketService.findExistingTicketForReply(
        null,
        null,
        'Circuit id BA/SNG-CHK/ESPL-002 || 41445467 || RFO ||',
        'Dear @EdgeStone Support,\nKindly raise the TT for Link Flapping and share the observation.\nCircuit id : BA/SNG-CHK/ESPL-002',
        'Cfm.L2@airtel.com'
    );
    console.log('Airtel Match Result:', airtelMatch ? airtelMatch.ticketId : 'NULL (Correct! Will create new ticket for ESPL-002)');

    console.log('\n--- TEST 2: China Unicom Full-Width Colon RE：(CU#2610160336) ---');
    const cuMatch = await ticketService.findExistingTicketForReply(
        null,
        null,
        'RE：(CU#2610160336)Open a ticket circuit ID#CUAU/SG1-MRS1/ESPL 015-1 DOWN',
        'Dear customer, we are working on it.',
        'customer_service@chinaunicom.cn'
    );
    console.log('CU Match Result (should be #1021):', cuMatch ? cuMatch.ticketId : 'NULL');

    console.log('\n--- TEST 3: China Unicom CU#2608150173 on NP001 vs Ticket #1018 ---');
    const cuMatch2 = await ticketService.findExistingTicketForReply(
        null,
        null,
        'RE：Link Flappping || Ckt id : SNG/CU-CHK/CU NP001|| 16/10/2026(CU#2608150173)',
        'Dear customer,\nPlease kindly noted we have already open ticket for this circuit. 2608150173.\nCircuit id : SNG/CU-CHK/CU NP001',
        'customer_service@chinaunicom.cn'
    );
    console.log('CU Match 2 Result (should NOT be #1018):', cuMatch2 ? cuMatch2.ticketId : 'NULL (Correct! Isolated from #1018)');
}

testMatching().finally(() => process.exit(0));
