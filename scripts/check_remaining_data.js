const fs = require('fs');
const path = require('path');
const backendDir = 'D:/Project/EdgeSotneTicketingFinal(HarHarMahadev)/EdgeStoneNewTicketinngSystemLiveBackend';
const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'));
require(path.join(backendDir, 'node_modules/dotenv')).config({
  path: path.join(backendDir, '.env')
});

const prisma = new PrismaClient();

async function checkRemaining() {
  const ticketCount = await prisma.ticket.count();
  const replyCount = await prisma.reply.count();
  const noteCount = await prisma.note.count();
  const workNoteCount = await prisma.workNote.count();
  const slaRecordCount = await prisma.sLARecord.count();
  const activityLogCount = await prisma.activityLog.count();
  const notificationCount = await prisma.notification.count();

  console.log('=== REMAINING TEST DATA IN DATABASE ===');
  console.log('Tickets:', ticketCount);
  console.log('Replies:', replyCount);
  console.log('Notes:', noteCount);
  console.log('WorkNotes:', workNoteCount);
  console.log('SLARecords:', slaRecordCount);
  console.log('ActivityLogs:', activityLogCount);
  console.log('Notifications:', notificationCount);

  const sampleNotifications = await prisma.notification.findMany({ take: 3 });
  console.log('Sample notifications:', JSON.stringify(sampleNotifications, null, 2));

  const nullTicketIdNotifs = await prisma.notification.count({ where: { ticketId: null } });
  console.log('Notifications with null ticketId:', nullTicketIdNotifs);
}

checkRemaining()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
