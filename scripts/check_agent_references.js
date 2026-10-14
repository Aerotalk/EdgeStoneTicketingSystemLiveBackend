const path = require('path');
const backendDir = 'D:/Project/EdgeSotneTicketingFinal(HarHarMahadev)/EdgeStoneNewTicketinngSystemLiveBackend';
const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'));
require(path.join(backendDir, 'node_modules/dotenv')).config({
  path: path.join(backendDir, '.env')
});

const prisma = new PrismaClient();

async function checkReferences() {
  const agentIds = [
    '539190e1-faef-4329-977e-8c1f446356ef',
    '62d12a61-0705-4c42-b226-8197c9ae2e06'
  ];

  const shiftHandovers = await prisma.shiftHandover.findMany({
    where: {
      OR: [
        { outgoingAgentId: { in: agentIds } },
        { incomingAgentId: { in: agentIds } }
      ]
    }
  });

  console.log('ShiftHandovers referencing these agents:', shiftHandovers.length);

  const signatures = await prisma.signature.findMany({
    where: {
      agentId: { in: agentIds }
    }
  });

  console.log('Signatures referencing these agents:', signatures.length);
}

checkReferences()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
