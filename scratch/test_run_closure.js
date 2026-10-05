const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const slaRecordService = require('../services/slaRecordService');

async function test() {
  const ticket = await prisma.ticket.findFirst({
    where: { ticketId: '#1063' },
    include: { slaRecords: true }
  });
  console.log('Ticket #1063:', ticket.id, ticket.ticketId, ticket.circuitId);

  const clientRecord = ticket.slaRecords.find(r => r.type === 'CLIENT');
  console.log('Before updateSLAClosure:', clientRecord);

  try {
    const res = await slaRecordService.updateSLAClosure(
      ticket.id,
      clientRecord.closeDate,
      clientRecord.closedTime
    );
    console.log('updateSLAClosure returned:', res);
  } catch (err) {
    console.error('updateSLAClosure error:', err);
  }

  const after = await prisma.sLARecord.findMany({ where: { ticketId: ticket.id } });
  console.log('After updateSLAClosure:', after);
}

test().catch(console.error).finally(() => prisma.$disconnect());
