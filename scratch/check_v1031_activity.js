const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const ticket = await prisma.ticket.findFirst({
    where: { ticketId: { contains: '1031' } },
    include: { activityLogs: { orderBy: { createdAt: 'asc' } } }
  });
  console.log('Activity logs count:', ticket.activityLogs.length);
  ticket.activityLogs.forEach((a, i) => {
    console.log(`[${i+1}] ${a.date} ${a.time} | ${a.author} | ${a.action} | ${a.description}`);
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
