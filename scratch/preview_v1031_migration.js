const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function previewMigration() {
  const v1031 = await prisma.ticket.findFirst({
    where: { ticketId: '#V1031' },
    include: { replies: { orderBy: { createdAt: 'asc' } } }
  });

  if (!v1031) {
    console.log('Ticket #V1031 not found.');
    return;
  }

  const clientReplies = [];
  const vendorReplies = [];
  const keepReplies = [];

  for (const r of v1031.replies) {
    if (r.subject?.includes('CRQ') || r.to?.some(e => e.includes('airtel.com'))) {
      keepReplies.push(r);
    } else if (r.subject?.includes('Neutrality') || r.to?.some(e => e.includes('neutrality.one'))) {
      clientReplies.push(r);
    } else if (r.subject?.includes('EN_IM_') || r.subject?.includes('CAR12') || r.to?.some(e => e.includes('vodafoneidea'))) {
      vendorReplies.push(r);
    } else {
      console.log('UNCLASSIFIED:', r);
    }
  }

  console.log(`Keep in #V1031: ${keepReplies.length} replies`);
  console.log(`Move to New Ticket Client Tab: ${clientReplies.length} replies`);
  console.log(`Move to New Ticket Vendor Tab: ${vendorReplies.length} replies`);
  console.log(`Total: ${keepReplies.length + clientReplies.length + vendorReplies.length} / ${v1031.replies.length}`);
}

previewMigration().catch(console.error).finally(() => prisma.$disconnect());
