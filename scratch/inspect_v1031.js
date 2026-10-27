const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const ticket = await prisma.ticket.findFirst({
    where: { ticketId: { contains: '1031' } },
    include: { client: true, vendor: true }
  });
  console.log(ticket);
}
main().catch(console.error).finally(() => prisma.$disconnect());
