const { isInternalAgentEmail } = require('../services/ticket/ticketSanitizer');
const { createTicketFromEmail } = require('../services/ticket/ticketIngestionService');
const prisma = require('../models/index');

async function test() {
  console.log('--- 1. Testing isInternalAgentEmail ---');
  const testEmails = [
    { email: 'prajwal@edgestone.in', expected: true },
    { email: 'akash@edgestone.in', expected: true },
    { email: 'random.agent@edgestone.in', expected: true },
    { email: 'marketing@edgestone.in', expected: true },
    { email: 'customer_service@chinaunicom.cn', expected: false },
    { email: 'Cfm.L2@airtel.com', expected: false },
    { email: 'noc@neutrality.one', expected: false }
  ];

  for (const item of testEmails) {
    const res = await isInternalAgentEmail(item.email);
    console.log(`Email: ${item.email.padEnd(35)} -> isAgent: ${res} (Expected: ${item.expected}) [${res === item.expected ? 'PASS' : 'FAIL'}]`);
  }

  console.log('\n--- 2. Testing createTicketFromEmail with Agent Sender and Unmatched Subject ---');
  const initialTicketCount = await prisma.ticket.count();
  console.log(`Initial total ticket count: ${initialTicketCount}`);

  // Simulate an agent sending an ad-hoc email with no circuit match
  const unlinkedAgentEmail = {
    from: 'prajwal@edgestone.in',
    fromName: 'Prajwal V.',
    to: ['external.person@example.com'],
    cc: ['support@edgestone.in'],
    subject: 'Internal Note / Question regarding procedures',
    body: 'Can someone check the internal SOP for this link?',
    date: new Date(),
    messageId: `<agent-test-${Date.now()}@edgestone.in>`
  };

  const result = await createTicketFromEmail(unlinkedAgentEmail);
  console.log('Result from createTicketFromEmail for unlinked agent email:', result);

  const postTicketCount = await prisma.ticket.count();
  console.log(`Post ticket count: ${postTicketCount} (Should equal initial count ${initialTicketCount})`);
  console.log(`New ticket prevented? ${postTicketCount === initialTicketCount ? 'YES (PASS)' : 'NO (FAIL)'}`);
}

test().catch(console.error).finally(() => process.exit(0));
