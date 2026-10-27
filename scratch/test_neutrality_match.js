const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();
const { findExistingTicketForReply } = require('../services/ticket/ticketThreadingService');

async function testNeutrality() {
  const reply14 = await prisma.reply.findUnique({
    where: { id: '38489231-35dd-4975-8609-8909f2fa08d3' }
  });
  console.log('Reply 14 in DB:', reply14);

  const matched = await findExistingTicketForReply(
    reply14.inReplyTo,
    reply14.references,
    reply14.subject,
    reply14.text,
    'noc@neutrality.one'
  );
  console.log('findExistingTicketForReply result for Neutrality reply:');
  console.log(matched ? `${matched.ticketId} - ${matched.header}` : 'null');
}

testNeutrality().catch(console.error).finally(() => prisma.$disconnect());
