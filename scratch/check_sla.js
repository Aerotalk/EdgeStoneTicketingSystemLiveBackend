const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDb() {
  const sla = await prisma.sla.findMany({
    include: { rules: true, circuit: true, vendor: true, customer: true }
  });
  console.log(JSON.stringify(sla.map(s => ({
    id: s.id,
    appliesTo: s.appliesTo,
    circuit: s.circuit?.customerCircuitId || s.circuit?.supplierCircuitId,
    vendor: s.vendor?.name,
    customer: s.customer?.name,
    rules: s.rules
  })), null, 2));
}

checkDb().catch(console.error).finally(() => prisma.$disconnect());
