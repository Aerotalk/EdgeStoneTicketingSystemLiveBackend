const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const slaRecordService = require('../services/slaRecordService');

async function recalculateAllClosed() {
  console.log('--- Recalculating All Closed Tickets with Valid Start/Close Times ---');
  const records = await prisma.sLARecord.findMany({
    where: {
      closedTime: { not: null },
      closeDate: { not: null }
    },
    include: {
      ticket: {
        select: { ticketId: true, circuitId: true }
      }
    }
  });

  console.log(`Found ${records.length} closed SLA records to evaluate.`);

  for (const r of records) {
    if (r.closeDate && r.closeDate !== '-' && r.closedTime && r.closedTime !== '-') {
      try {
        console.log(`Evaluating Ticket ${r.ticket?.ticketId} (${r.type}) on Circuit ${r.ticket?.circuitId}...`);
        const res = await slaRecordService.updateSLAClosure(r.id, r.closeDate, r.closedTime);
        console.log(`  -> Status: ${res?.status}, Comp: ${res?.compensation}, Reason: ${res?.statusReason}`);
      } catch (err) {
        console.error(`  -> Failed for ${r.id}: ${err.message}`);
      }
    }
  }

  console.log('Recalculation complete.');
}

recalculateAllClosed().catch(console.error).finally(() => prisma.$disconnect());
