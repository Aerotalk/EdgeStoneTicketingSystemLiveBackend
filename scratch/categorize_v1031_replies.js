const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function inspectReplies() {
  const t = await prisma.ticket.findFirst({
    where: { ticketId: '#V1031' },
    include: { replies: { orderBy: { createdAt: 'asc' } } }
  });

  console.log(`Ticket #V1031 has ${t.replies.length} replies.`);
  t.replies.forEach((r, idx) => {
    let belongsTo = 'UNKNOWN';
    if (r.subject?.includes('CRQ') || r.to?.some(e => e.includes('airtel'))) {
      belongsTo = 'AIRTEL_MAINTENANCE (V1031)';
    } else if (r.subject?.includes('Neutrality') || r.to?.some(e => e.includes('neutrality.one'))) {
      belongsTo = 'CLIENT_NEUTRALITY';
    } else if (r.subject?.includes('EN_IM_') || r.subject?.includes('CAR12') || r.to?.some(e => e.includes('vodafoneidea'))) {
      belongsTo = 'VENDOR_VODAFONE_IDEA';
    }
    console.log(`[${idx + 1}] ID: ${r.id} | Date: ${r.date} ${r.time} | BelongsTo: ${belongsTo}`);
    console.log(`     Subject: ${r.subject}`);
    console.log(`     Author: ${r.author} (${r.type}) | Category: ${r.category}`);
    console.log(`     To: ${JSON.stringify(r.to)}`);
  });
}

inspectReplies().catch(console.error).finally(() => prisma.$disconnect());
