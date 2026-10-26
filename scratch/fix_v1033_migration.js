const prisma = require('../models/index');

async function main() {
  const vTicket = await prisma.ticket.findFirst({
    where: { ticketId: '#V1033' },
    include: { replies: true, activityLogs: true, slaRecords: true }
  });

  const parentTicket = await prisma.ticket.findFirst({
    where: { ticketId: '#1032' },
    include: { replies: true }
  });

  if (!vTicket) {
    console.log('Ticket #V1033 not found, may have already been resolved.');
    return;
  }

  if (!parentTicket) {
    console.log('Ticket #1032 not found!');
    return;
  }

  console.log(`Found #V1033 with ${vTicket.replies.length} replies.`);
  console.log(`Found #1032 with ${parentTicket.replies.length} replies.`);

  const airtelVendorId = '118f7c54-f9c8-4463-a009-6e69b4b4ffd8';

  // 1. Migrate replies from #V1033 to #1032 under Bharti Airtel's vendor category
  for (const r of vTicket.replies) {
    let newType = r.type;
    if (r.author?.toLowerCase().includes('prajwal') || (r.to && r.to.some(e => e.includes('airtel.com')) && !r.author?.includes('Airtel') && !r.author?.includes('Cfm'))) {
      newType = 'agent';
    }
    await prisma.reply.update({
      where: { id: r.id },
      data: {
        ticketId: parentTicket.id,
        category: `vendor_${airtelVendorId}`,
        type: newType
      }
    });
    console.log(`Migrated reply ${r.id} (${r.author}, type: ${newType}) -> Ticket #1032`);
  }

  // 2. Migrate or clean activity logs
  for (const al of vTicket.activityLogs) {
    await prisma.activityLog.update({
      where: { id: al.id },
      data: { ticketId: parentTicket.id }
    });
  }

  // 3. Delete any orphaned SLA records for #V1033
  if (vTicket.slaRecords.length > 0) {
    await prisma.sLARecord.deleteMany({
      where: { ticketId: vTicket.id }
    });
  }

  // 4. Delete #V1033
  await prisma.ticket.delete({
    where: { id: vTicket.id }
  });

  console.log('Successfully merged #V1033 replies into #1032 Vendor thread and deleted duplicate ticket #V1033.');
}

main().catch(console.error).finally(() => process.exit(0));
