const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function clean() {
  const t = await prisma.ticket.findFirst({
    where: { ticketId: '#1033' },
    include: { replies: true, activityLogs: true, slaRecords: true }
  });
  if (t) {
    await prisma.reply.deleteMany({ where: { ticketId: t.id } });
    await prisma.activityLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.sLARecord.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } });
    console.log('Cleaned simulation ticket #1033');
  }
}
clean().catch(console.error).finally(() => prisma.$disconnect());
