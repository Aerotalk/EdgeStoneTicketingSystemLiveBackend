const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const allClients = await prisma.client.findMany();
  console.log('--- ALL CLIENTS ---');
  allClients.forEach(c => {
    console.log(c.id, c.name, c.emails);
  });
  console.log('--- ALL VENDORS ---');
  const allVendors = await prisma.vendor.findMany();
  allVendors.forEach(v => {
    console.log(v.id, v.name, v.emails);
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
