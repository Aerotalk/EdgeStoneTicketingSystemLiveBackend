const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();
const { createTicketFromEmail } = require('../services/ticket/ticketIngestionService');

async function testSimulate() {
  console.log('Simulating incoming email from Neutrality...');
  const emailData = {
    from: 'noc@neutrality.one',
    fromName: 'Neutrality NOC',
    to: ['support@edgestone.in'],
    subject: 'Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request',
    body: 'Dear EdgeStone Team,\n\nPlease investigate link flapping on Service ID: N1/SG1-MUM/ESPL-007.\n\nBest Regards,\nNeutrality NOC',
    date: new Date('2026-10-27T08:30:00+05:30'),
    messageId: '<TEST-SIMULATION-MSG-1@neutrality.one>'
  };

  // We test without inReplyTo
  const result = await createTicketFromEmail(emailData);
  console.log('Simulation result:');
  console.log(result ? `Ticket created/matched: ${result.ticketId} | Status: ${result.status} | Client: ${result.clientId} | Vendor: ${result.vendorId}` : 'DROPPED / NULL');
}

testSimulate().catch(console.error).finally(() => prisma.$disconnect());
