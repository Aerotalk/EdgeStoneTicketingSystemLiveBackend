const fs = require('fs');
const path = require('path');
const backendDir = 'D:/Project/EdgeSotneTicketingFinal(HarHarMahadev)/EdgeStoneNewTicketinngSystemLiveBackend';
const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'));
require(path.join(backendDir, 'node_modules/dotenv')).config({
  path: path.join(backendDir, '.env')
});

const prisma = new PrismaClient();

async function deleteAllTestTickets() {
  console.log('🔍 Locating all remaining active/test tickets in the system...');

  const allTickets = await prisma.ticket.findMany({
    include: {
      replies: true,
      notes: true,
      workNotes: true,
      slaRecords: true,
      activityLogs: true
    },
    orderBy: { createdAt: 'desc' }
  });

  console.log(`📋 Found ${allTickets.length} active ticket(s) to delete.`);
  allTickets.forEach(t => {
    console.log(`   - [${t.ticketId}] (${t.id}) | Status: ${t.status} | Type: ${t.ticketType} | Subject: "${t.header}"`);
  });

  const allNotifications = await prisma.notification.findMany();
  console.log(`🔔 Found ${allNotifications.length} notification(s) associated with test tickets.`);

  // Step 1: Create Complete Backup
  const backupDir = path.join(backendDir, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFilePath = path.join(backupDir, `all_test_tickets_backup_${timestamp}.json`);

  const fullBackupPayload = {
    metadata: {
      exportedAt: new Date().toISOString(),
      ticketCount: allTickets.length,
      notificationCount: allNotifications.length,
      reason: 'Purging test tickets prior to production go-live'
    },
    tickets: allTickets,
    notifications: allNotifications
  };

  fs.writeFileSync(backupFilePath, JSON.stringify(fullBackupPayload, null, 2), 'utf-8');
  console.log(`\n💾 Full backup successfully saved: ${backupFilePath}`);

  // Step 2: Cascading Deletion inside a database transaction
  console.log('\n🗑️ Commencing full cascading deletion in a database transaction...');

  const result = await prisma.$transaction(async (tx) => {
    const deletedReplies = await tx.reply.deleteMany({});
    const deletedNotes = await tx.note.deleteMany({});
    const deletedWorkNotes = await tx.workNote.deleteMany({});
    const deletedSlaRecords = await tx.sLARecord.deleteMany({});
    const deletedActivityLogs = await tx.activityLog.deleteMany({});
    const deletedNotifications = await tx.notification.deleteMany({});
    const deletedTickets = await tx.ticket.deleteMany({});

    return {
      deletedTicketsCount: deletedTickets.count,
      deletedRepliesCount: deletedReplies.count,
      deletedNotesCount: deletedNotes.count,
      deletedWorkNotesCount: deletedWorkNotes.count,
      deletedSlaRecordsCount: deletedSlaRecords.count,
      deletedActivityLogsCount: deletedActivityLogs.count,
      deletedNotificationsCount: deletedNotifications.count
    };
  });

  console.log('\n📊 Deletion summary:');
  console.log(`   - Tickets deleted:        ${result.deletedTicketsCount}`);
  console.log(`   - Replies deleted:        ${result.deletedRepliesCount}`);
  console.log(`   - Notes deleted:          ${result.deletedNotesCount}`);
  console.log(`   - Work Notes deleted:     ${result.deletedWorkNotesCount}`);
  console.log(`   - SLA Records deleted:    ${result.deletedSlaRecordsCount}`);
  console.log(`   - Activity Logs deleted:  ${result.deletedActivityLogsCount}`);
  console.log(`   - Notifications deleted:  ${result.deletedNotificationsCount}`);

  // Step 3: Verify system state
  const remainingTickets = await prisma.ticket.count();
  const remainingReplies = await prisma.reply.count();
  const remainingNotifications = await prisma.notification.count();
  const clientCount = await prisma.client.count();
  const vendorCount = await prisma.vendor.count();
  const circuitCount = await prisma.circuit.count();
  const userCount = await prisma.user.count();

  console.log('\n🔍 Post-Deletion System State:');
  console.log(`   - Tickets:       ${remainingTickets} (clean slate)`);
  console.log(`   - Replies:       ${remainingReplies}`);
  console.log(`   - Notifications: ${remainingNotifications}`);
  console.log('\n🛡️ Configuration & Master Data Preserved:');
  console.log(`   - Clients:       ${clientCount}`);
  console.log(`   - Vendors:       ${vendorCount}`);
  console.log(`   - Circuits:      ${circuitCount}`);
  console.log(`   - Users/Agents:  ${userCount}`);

  if (remainingTickets === 0) {
    console.log('\n🚀 ALL TEST TICKETS SUCCESSFULLY PURGED! The system is clean and ready for go-live!');
  } else {
    console.warn(`\n⚠️ Warning: ${remainingTickets} tickets remain!`);
  }
}

deleteAllTestTickets()
  .catch((err) => {
    console.error('❌ Error during test ticket purging:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
