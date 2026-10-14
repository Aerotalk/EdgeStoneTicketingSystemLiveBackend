const fs = require('fs');
const path = require('path');
const backendDir = 'D:/Project/EdgeSotneTicketingFinal(HarHarMahadev)/EdgeStoneNewTicketinngSystemLiveBackend';
const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'));
require(path.join(backendDir, 'node_modules/dotenv')).config({
  path: path.join(backendDir, '.env')
});

const prisma = new PrismaClient();

async function deleteMaintenanceTickets() {
  console.log('🔍 Locating all flagged maintenance tickets...');

  // Find all tickets with isMaintenance: true OR status: 'Maintenance'
  const targetTickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { isMaintenance: true },
        { status: 'Maintenance' }
      ]
    },
    include: {
      replies: true,
      notes: true,
      workNotes: true,
      slaRecords: true,
      activityLogs: true
    },
    orderBy: { createdAt: 'desc' }
  });

  console.log(`📋 Found ${targetTickets.length} maintenance ticket(s) to delete:`);
  targetTickets.forEach(t => {
    console.log(`   - [${t.ticketId}] (${t.id}) | Status: ${t.status} | isMaintenance: ${t.isMaintenance} | Subject: "${t.header}"`);
  });

  if (targetTickets.length === 0) {
    console.log('✅ No maintenance tickets found. Nothing to delete.');
    return;
  }

  // Step 1: Backup
  const backupDir = path.join(backendDir, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFilePath = path.join(backupDir, `maintenance_tickets_backup_${timestamp}.json`);

  fs.writeFileSync(backupFilePath, JSON.stringify(targetTickets, null, 2), 'utf-8');
  console.log(`\n💾 Backup successfully created: ${backupFilePath} (${targetTickets.length} tickets recorded)`);

  // Step 2: Delete associated records and tickets
  const targetIds = targetTickets.map(t => t.id);
  const targetTicketFriendlyIds = targetTickets.map(t => t.ticketId).filter(Boolean);

  console.log('\n🗑️ Commencing cascading deletion in a database transaction...');

  const result = await prisma.$transaction(async (tx) => {
    // 1. Delete replies
    const deletedReplies = await tx.reply.deleteMany({
      where: { ticketId: { in: targetIds } }
    });

    // 2. Delete notes
    const deletedNotes = await tx.note.deleteMany({
      where: { ticketId: { in: targetIds } }
    });

    // 3. Delete work notes
    const deletedWorkNotes = await tx.workNote.deleteMany({
      where: { ticketId: { in: targetIds } }
    });

    // 4. Delete SLA records
    const deletedSlaRecords = await tx.sLARecord.deleteMany({
      where: { ticketId: { in: targetIds } }
    });

    // 5. Delete activity logs
    const deletedActivityLogs = await tx.activityLog.deleteMany({
      where: { ticketId: { in: targetIds } }
    });

    // 6. Delete notifications referencing these tickets
    const deletedNotifications = await tx.notification.deleteMany({
      where: {
        OR: [
          { ticketId: { in: targetIds } },
          { ticketId: { in: targetTicketFriendlyIds } }
        ]
      }
    });

    // 7. Delete the tickets
    const deletedTickets = await tx.ticket.deleteMany({
      where: { id: { in: targetIds } }
    });

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

  // Step 3: Verification
  const remainingMaintenanceTickets = await prisma.ticket.count({
    where: {
      OR: [
        { isMaintenance: true },
        { status: 'Maintenance' }
      ]
    }
  });

  const totalRemainingTickets = await prisma.ticket.count();

  console.log('\n🔍 Verification:');
  console.log(`   - Remaining maintenance tickets: ${remainingMaintenanceTickets}`);
  console.log(`   - Total tickets in system now:   ${totalRemainingTickets}`);

  if (remainingMaintenanceTickets === 0) {
    console.log('\n✅ All flagged maintenance tickets have been deleted successfully!');
  } else {
    console.warn(`\n⚠️ Warning: ${remainingMaintenanceTickets} maintenance tickets still remain!`);
  }
}

deleteMaintenanceTickets()
  .catch((err) => {
    console.error('❌ Error during maintenance ticket deletion:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
