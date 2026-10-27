const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const circuits = await prisma.circuit.findMany({
    where: {
      OR: [
        { customerCircuitId: { contains: '007', mode: 'insensitive' } },
        { supplierCircuitId: { contains: '007', mode: 'insensitive' } },
        { customerCircuitId: { contains: 'CAR12', mode: 'insensitive' } },
        { supplierCircuitId: { contains: 'CAR12', mode: 'insensitive' } }
      ]
    },
    include: { client: true, vendor: true, vendorCircuits: true }
  });
  console.log('Circuits found:', circuits.length);
  circuits.forEach(c => {
    console.log({
      id: c.id,
      customerCircuitId: c.customerCircuitId,
      supplierCircuitId: c.supplierCircuitId,
      client: c.client?.name,
      clientEmails: c.client?.emails,
      vendor: c.vendor?.name,
      vendorEmails: c.vendor?.emails,
      vendorCircuits: c.vendorCircuits
    });
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
