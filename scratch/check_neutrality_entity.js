const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const v = await prisma.vendor.findUnique({
    where: { id: 'aebceb7c-4316-4a6c-935a-fc5faaef6728' }
  });
  console.log('Vendor:', v);
  const c = await prisma.client.findFirst({
    where: { name: { contains: 'Neutrality', mode: 'insensitive' } }
  });
  console.log('Client:', c);
}
main().catch(console.error).finally(() => prisma.$disconnect());
