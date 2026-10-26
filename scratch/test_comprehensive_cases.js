const prisma = require('../models/index');
const { isInternalAgentEmail } = require('../services/ticket/ticketSanitizer');
const { createTicketFromEmail } = require('../services/ticket/ticketIngestionService');
const { appendAgentReplyFromOutlook } = require('../services/ticket/ticketReplyHandler');
const { findExistingTicketForReply } = require('../services/ticket/ticketThreadingService');

async function runAudit() {
  console.log('================================================================');
  console.log('       COMPREHENSIVE AUDIT: AGENT REPLIES & TICKET CREATION     ');
  console.log('================================================================\n');

  // 1. Verify agent recognition
  console.log('[TEST 1] Domain & Agent Verification:');
  const agentEmails = ['prajwal@edgestone.in', 'akash@edgestone.in', 'soumyajit@edgestone.in', 'it@edgestone.in'];
  for (const e of agentEmails) {
    const isAg = await isInternalAgentEmail(e);
    console.log(`  - ${e}: isAgent = ${isAg} [${isAg ? 'OK' : 'FAIL'}]`);
    if (!isAg) throw new Error(`Agent ${e} was not recognized!`);
  }

  // 2. Verify Client on Normal Ticket
  console.log('\n[TEST 2] Agent Reply to Client on Ticket #1032:');
  const ticket1032 = await prisma.ticket.findFirst({ where: { ticketId: '#1032' } });
  if (!ticket1032) throw new Error('Ticket #1032 not found');

  const clientReplyData = {
    from: 'prajwal@edgestone.in',
    fromName: 'Prajwal V.',
    to: ['noc@neutrality.one'],
    cc: ['support@edgestone.in'],
    subject: 'RE: Neutrality.One #213729 | Service ID: N1/LON-MUM/ESPL-006 | Down',
    body: 'Test reply to customer confirming circuit restoration.',
    date: new Date(),
    messageId: `<audit-test-client-${Date.now()}@edgestone.in>`
  };

  const savedClientReply = await appendAgentReplyFromOutlook(ticket1032, clientReplyData);
  console.log(`  - Saved Reply ID: ${savedClientReply.id}`);
  console.log(`  - Author: ${savedClientReply.author} | Type: ${savedClientReply.type} | Category: ${savedClientReply.category}`);
  if (savedClientReply.category !== 'client' || savedClientReply.type !== 'agent') {
    throw new Error(`Client reply categorization failed! Expected category=client, got ${savedClientReply.category}`);
  }
  console.log('  -> PASS: Correctly routed to Client thread as Agent reply.');

  // Clean test reply
  await prisma.reply.delete({ where: { id: savedClientReply.id } });

  // 3. Verify Vendor Reply on Normal Ticket
  console.log('\n[TEST 3] Agent Reply to Vendor on Ticket #1032:');
  const vendorReplyData = {
    from: 'prajwal@edgestone.in',
    fromName: 'Prajwal V.',
    to: ['Cfm.L2@airtel.com', 'servicedesk.data@airtel.com'],
    cc: ['support@edgestone.in'],
    subject: 'RE: Service ID: 14867801 - RFO Query',
    body: 'Please share the Root Cause Analysis for link flapping on 14867801.',
    date: new Date(),
    messageId: `<audit-test-vendor-${Date.now()}@edgestone.in>`
  };

  const savedVendorReply = await appendAgentReplyFromOutlook(ticket1032, vendorReplyData);
  console.log(`  - Saved Reply ID: ${savedVendorReply.id}`);
  console.log(`  - Author: ${savedVendorReply.author} | Type: ${savedVendorReply.type} | Category: ${savedVendorReply.category}`);
  if (!savedVendorReply.category.startsWith('vendor') || savedVendorReply.type !== 'agent') {
    throw new Error(`Vendor reply categorization failed! Expected vendor category, got ${savedVendorReply.category}`);
  }
  console.log('  -> PASS: Correctly routed to Vendor thread as Agent reply.');

  // Clean test reply
  await prisma.reply.delete({ where: { id: savedVendorReply.id } });

  // 4. Verify Reply on Maintenance Ticket
  console.log('\n[TEST 4] Agent Reply on Maintenance Ticket #1001:');
  const maintTicket = await prisma.ticket.findFirst({ where: { isMaintenance: true } });
  if (maintTicket) {
    const maintReplyData = {
      from: 'akash@edgestone.in',
      fromName: 'Akash Singh',
      to: ['noc@neutrality.one'],
      cc: ['support@edgestone.in'],
      subject: `RE: ${maintTicket.header}`,
      body: 'Maintenance activity has been completed successfully and link is normal.',
      date: new Date(),
      messageId: `<audit-test-maint-${Date.now()}@edgestone.in>`
    };
    const savedMaintReply = await appendAgentReplyFromOutlook(maintTicket, maintReplyData);
    console.log(`  - Maint Ticket ${maintTicket.ticketId} Reply ID: ${savedMaintReply.id}`);
    console.log(`  - Author: ${savedMaintReply.author} | Type: ${savedMaintReply.type} | Category: ${savedMaintReply.category}`);
    if (savedMaintReply.type !== 'agent') {
      throw new Error(`Maintenance reply failed! Expected agent, got ${savedMaintReply.type}`);
    }
    console.log('  -> PASS: Correctly recorded on Maintenance ticket as Agent reply.');
    await prisma.reply.delete({ where: { id: savedMaintReply.id } });
  } else {
    console.log('  - No maintenance ticket found, skipping test 4.');
  }

  // 5. Verify Unlinked Agent Email Blocked from Creating Tickets
  console.log('\n[TEST 5] Unlinked Agent Email Blocked from Ticket Creation:');
  const countBefore = await prisma.ticket.count();
  const unlinkedEmail = {
    from: 'soumyajit@edgestone.in',
    fromName: 'Soumyajit D.',
    to: ['colleague@edgestone.in'],
    subject: 'Internal discussion about team shift handover',
    body: 'Please review the shift handover notes.',
    date: new Date(),
    messageId: `<audit-unlinked-${Date.now()}@edgestone.in>`
  };
  const res = await createTicketFromEmail(unlinkedEmail);
  const countAfter = await prisma.ticket.count();
  console.log(`  - Ticket Creation Result: ${res}`);
  console.log(`  - Tickets Before: ${countBefore} | Tickets After: ${countAfter}`);
  if (countBefore !== countAfter) {
    throw new Error('Unlinked agent email created a ticket! BUG DETECTED!');
  }
  console.log('  -> PASS: New ticket creation strictly blocked for agent email.');

  console.log('\n================================================================');
  console.log('                 ALL AUDIT TESTS PASSED (100%)                  ');
  console.log('================================================================\n');
}

runAudit().catch(err => {
  console.error('\n❌ AUDIT FAILED:', err);
  process.exit(1);
}).finally(() => process.exit(0));
