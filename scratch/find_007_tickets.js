const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { circuitId: { contains: '007', mode: 'insensitive' } },
        { circuitId: { contains: 'CAR12', mode: 'insensitive' } },
        { header: { contains: '007', mode: 'insensitive' } },
        { header: { contains: 'CAR12', mode: 'insensitive' } },
        { header: { contains: '603516', mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      ticketId: true,
      header: true,
      status: true,
      circuitId: true,
      ticketType: true,
      isMaintenance: true,
      createdAt: true
    }
  });
  console.log('Tickets matching 007 / CAR12 / 603516:', tickets);
}
main().catch(console.error).finally(() => prisma.$disconnect());
