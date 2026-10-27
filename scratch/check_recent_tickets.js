const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('--- ALL TICKETS CREATED IN LAST 2 DAYS ---');
  const recentTickets = await prisma.ticket.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 48 * 3600 * 1000) }
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, ticketId: true, header: true, status: true, circuitId: true, email: true, createdAt: true }
  });
  console.log(recentTickets);
}
main().catch(console.error).finally(() => prisma.$disconnect());
