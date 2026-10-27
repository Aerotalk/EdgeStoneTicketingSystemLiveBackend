const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const maintTickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { isMaintenance: true },
        { status: 'Maintenance' }
      ]
    },
    select: {
      id: true,
      ticketId: true,
      header: true,
      status: true,
      circuitId: true,
      createdAt: true
    }
  });
  console.log('Maintenance tickets:', maintTickets);
}
main().catch(console.error).finally(() => prisma.$disconnect());
