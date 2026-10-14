const path = require('path');
const backendDir = 'D:/Project/EdgeSotneTicketingFinal(HarHarMahadev)/EdgeStoneNewTicketinngSystemLiveBackend';
const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'));
require(path.join(backendDir, 'node_modules/dotenv')).config({
  path: path.join(backendDir, '.env')
});

const prisma = new PrismaClient();

async function inspectAgents() {
  console.log('=== ALL AGENTS IN DB ===');
  const agents = await prisma.agent.findMany();
  agents.forEach(a => {
    console.log(`Agent ID: ${a.id} | Name: ${a.name} | Email: ${a.email} | Role: ${a.role} | Status: ${a.status} | CreatedOn: ${a.createdOn}`);
  });

  console.log('\n=== ALL USERS IN DB ===');
  const users = await prisma.user.findMany();
  users.forEach(u => {
    console.log(`User ID: ${u.id} | Name: ${u.name} | Email: ${u.email} | Role: ${u.role} | Status: ${u.status}`);
  });

  console.log('\n=== MATCHING AGENTS ===');
  const matchedAgents = await prisma.agent.findMany({
    where: {
      OR: [
        { email: 'akash@edgestone.in' },
        { email: 'temp@gmail.com' },
        { name: { contains: 'Akash', mode: 'insensitive' } }
      ]
    }
  });
  console.log('Matched Agents:', JSON.stringify(matchedAgents, null, 2));

  console.log('\n=== MATCHING USERS ===');
  const matchedUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: 'akash@edgestone.in' },
        { email: 'temp@gmail.com' },
        { name: { contains: 'Akash', mode: 'insensitive' } }
      ]
    }
  });
  console.log('Matched Users:', JSON.stringify(matchedUsers, null, 2));

  for (const agent of matchedAgents) {
    const sigs = await prisma.signature.findMany({ where: { agentId: agent.id } });
    console.log(`Signatures for Agent ${agent.name} (${agent.id}):`, sigs.length);
  }
}

inspectAgents()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
