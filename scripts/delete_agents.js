const fs = require('fs');
const path = require('path');
const backendDir = 'D:/Project/EdgeSotneTicketingFinal(HarHarMahadev)/EdgeStoneNewTicketinngSystemLiveBackend';
const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'));
require(path.join(backendDir, 'node_modules/dotenv')).config({
  path: path.join(backendDir, '.env')
});

const prisma = new PrismaClient();

async function deleteTargetAgents() {
  console.log('🔍 Finding target agents to delete...');

  const targetEmails = ['akash@edgestone.in', 'temp@gmail.com'];

  const agentsToDelete = await prisma.agent.findMany({
    where: {
      email: { in: targetEmails }
    }
  });

  console.log(`📋 Found ${agentsToDelete.length} agent(s) matching [${targetEmails.join(', ')}]:`);
  agentsToDelete.forEach(a => {
    console.log(`   - ID: ${a.id} | Name: "${a.name}" | Email: ${a.email} | Role: ${a.role} | Status: ${a.status} | CreatedOn: ${a.createdOn}`);
  });

  if (agentsToDelete.length === 0) {
    console.log('⚠️ No matching agents found in the DB.');
    return;
  }

  // Step 1: Backup
  const backupDir = path.join(backendDir, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFilePath = path.join(backupDir, `deleted_agents_backup_${timestamp}.json`);

  fs.writeFileSync(backupFilePath, JSON.stringify(agentsToDelete, null, 2), 'utf-8');
  console.log(`\n💾 Backup saved to: ${backupFilePath}`);

  const targetAgentIds = agentsToDelete.map(a => a.id);

  // Step 2: Delete / unreference in transaction
  console.log('\n🗑️ Commencing deletion in a database transaction...');

  const result = await prisma.$transaction(async (tx) => {
    // 1. Delete any signatures associated with these agents (if any)
    const deletedSignatures = await tx.signature.deleteMany({
      where: { agentId: { in: targetAgentIds } }
    });

    // 2. Unlink any ShiftHandovers referencing these agents
    const unlinkedOutgoingHandovers = await tx.shiftHandover.updateMany({
      where: { outgoingAgentId: { in: targetAgentIds } },
      data: { outgoingAgentId: null }
    });

    const unlinkedIncomingHandovers = await tx.shiftHandover.updateMany({
      where: { incomingAgentId: { in: targetAgentIds } },
      data: { incomingAgentId: null }
    });

    // 3. Delete the agents from the Agent table
    const deletedAgents = await tx.agent.deleteMany({
      where: { id: { in: targetAgentIds } }
    });

    return {
      deletedAgentsCount: deletedAgents.count,
      deletedSignaturesCount: deletedSignatures.count,
      unlinkedOutgoingHandoversCount: unlinkedOutgoingHandovers.count,
      unlinkedIncomingHandoversCount: unlinkedIncomingHandovers.count
    };
  });

  console.log('\n📊 Deletion summary:');
  console.log(`   - Agents deleted:             ${result.deletedAgentsCount}`);
  console.log(`   - Signatures deleted:         ${result.deletedSignaturesCount}`);
  console.log(`   - ShiftHandovers unlinked:    ${result.unlinkedOutgoingHandoversCount + result.unlinkedIncomingHandoversCount}`);

  // Step 3: Verify remaining agents
  const remainingAgents = await prisma.agent.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true
    },
    orderBy: { name: 'asc' }
  });

  console.log(`\n🔍 Verification - Remaining Agents in DB (${remainingAgents.length} total):`);
  remainingAgents.forEach(a => {
    console.log(`   - [${a.name}] <${a.email}> | Role: ${a.role} | Status: ${a.status}`);
  });

  const checkDeleted = await prisma.agent.count({
    where: { email: { in: targetEmails } }
  });

  if (checkDeleted === 0) {
    console.log('\n✅ Both agents have been COMPLETELY deleted from the database!');
  } else {
    console.warn(`\n⚠️ Warning: ${checkDeleted} target agents still found!`);
  }
}

deleteTargetAgents()
  .catch((err) => {
    console.error('❌ Error deleting agents:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
