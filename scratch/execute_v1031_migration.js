const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function executeMigration() {
  console.log('=== STARTING V1031 INCIDENT SEPARATION ===');

  const v1031 = await prisma.ticket.findFirst({
    where: { ticketId: '#V1031' },
    include: { replies: { orderBy: { createdAt: 'asc' } }, activityLogs: true, slaRecords: true }
  });

  if (!v1031) {
    console.log('Ticket #V1031 not found.');
    return;
  }

  console.log(`Found #V1031 with ${v1031.replies.length} replies.`);

  const neutralityClientId = 'bfd3a6ff-be9d-478a-96ba-357f56a880e5'; // Neutrality One
  const viVendorId = '4faa6038-924e-496d-b1c8-3d3e23e72957'; // Vodafone Idea Limited
  const circuitId = 'N1/SG1-MUM/ESPL-007';

  // 1. Check if #1033 already exists or find next ticket ID
  let newTicket = await prisma.ticket.findFirst({
    where: { ticketId: '#1033' }
  });

  if (!newTicket) {
    newTicket = await prisma.ticket.create({
      data: {
        ticketId: '#1033',
        header: 'Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request',
        email: 'noc@neutrality.one',
        status: 'In Progress',
        priority: 'High',
        circuitId: circuitId,
        date: '27 Oct 2026',
        receivedAt: new Date('2026-10-27T08:30:00.000Z'),
        receivedTime: '08:30',
        clientId: neutralityClientId,
        vendorId: viVendorId,
        ticketType: 'Client',
        isSlaActive: true,
        isMaintenance: false,
        cc: ['noc@neutrality.one', 'support@edgestone.in']
      }
    });
    console.log(`Created new Incident Ticket: ${newTicket.ticketId} (ID: ${newTicket.id})`);
  } else {
    console.log(`Ticket #1033 already exists (ID: ${newTicket.id}), updating...`);
    await prisma.ticket.update({
      where: { id: newTicket.id },
      data: {
        header: 'Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request',
        email: 'noc@neutrality.one',
        clientId: neutralityClientId,
        vendorId: viVendorId,
        circuitId: circuitId,
        ticketType: 'Client',
        isMaintenance: false,
        status: 'In Progress'
      }
    });
  }

  // 2. Classify and migrate replies
  let migratedClient = 0;
  let migratedVendor = 0;
  let keptAirtel = 0;

  for (const r of v1031.replies) {
    const isAirtel = r.subject?.includes('CRQ') || r.to?.some(e => e.includes('airtel.com')) || r.author?.toLowerCase().includes('changemgmt');
    const isClient = !isAirtel && (r.subject?.includes('Neutrality') || r.to?.some(e => e.includes('neutrality.one')) || r.author?.toLowerCase().includes('neutrality'));
    const isVendor = !isAirtel && !isClient && (r.subject?.includes('EN_IM_') || r.subject?.includes('CAR12') || r.to?.some(e => e.includes('vodafoneidea')) || r.author?.toLowerCase().includes('vodafone') || r.author?.toLowerCase().includes('flsupport'));

    if (isAirtel) {
      keptAirtel++;
      // Ensure kept replies stay clean under Airtel vendor category
      await prisma.reply.update({
        where: { id: r.id },
        data: {
          category: 'vendor_118f7c54-f9c8-4463-a009-6e69b4b4ffd8'
        }
      });
      console.log(`Kept in #V1031: [${r.id}] ${r.subject?.substring(0, 50)}`);
    } else if (isClient) {
      migratedClient++;
      const isClientAuthor = r.author?.toLowerCase().includes('neutrality') || r.to?.some(e => e.includes('support@edgestone.in'));
      const authorType = isClientAuthor && !r.author?.toLowerCase().includes('edgestone') ? 'client' : 'agent';

      await prisma.reply.update({
        where: { id: r.id },
        data: {
          ticketId: newTicket.id,
          category: 'client',
          type: authorType
        }
      });
      console.log(`Migrated to #1033 CLIENT tab: [${r.id}] (${r.author}, type: ${authorType}) -> ${r.subject?.substring(0, 50)}`);
    } else if (isVendor) {
      migratedVendor++;
      const isViAuthor = r.author?.toLowerCase().includes('vodafone') || r.author?.toLowerCase().includes('flsupport') || r.author?.toLowerCase().includes('vi');
      const authorType = isViAuthor ? 'vendor' : 'agent';

      await prisma.reply.update({
        where: { id: r.id },
        data: {
          ticketId: newTicket.id,
          category: `vendor_${viVendorId}`,
          type: authorType
        }
      });
      console.log(`Migrated to #1033 VENDOR tab: [${r.id}] (${r.author}, type: ${authorType}) -> ${r.subject?.substring(0, 50)}`);
    }
  }

  // 3. Migrate relevant activity logs
  for (const al of v1031.activityLogs) {
    if (al.description?.includes('Neutrality') || al.description?.includes('Vodafone') || al.description?.includes('flsupport') || al.description?.includes('EN_IM_')) {
      await prisma.activityLog.update({
        where: { id: al.id },
        data: { ticketId: newTicket.id }
      });
    }
  }

  // 4. Create initial activity log for #1033 if none
  const logCount = await prisma.activityLog.count({ where: { ticketId: newTicket.id } });
  if (logCount === 0) {
    await prisma.activityLog.create({
      data: {
        ticketId: newTicket.id,
        action: 'created',
        description: 'Ticket created for Neutrality One incident on Circuit N1/SG1-MUM/ESPL-007',
        time: '08:30',
        date: '27 Oct 2026',
        author: 'Neutrality NOC'
      }
    });
  }

  // 5. Ensure SLA record exists for #1033
  const existingSla = await prisma.sLARecord.findFirst({ where: { ticketId: newTicket.id } });
  if (!existingSla) {
    await prisma.sLARecord.create({
      data: {
        ticketId: newTicket.id,
        startDate: '27 Oct 2026',
        startTime: '08:30',
        status: 'Safe',
        timeZone: 'UTC',
        type: 'CLIENT'
      }
    });
    console.log('Created SLA record for #1033');
  }

  console.log('\n=== MIGRATION SUMMARY ===');
  console.log(`Ticket #V1031 Airtel Maintenance replies kept: ${keptAirtel}`);
  console.log(`Ticket #1033 Client replies moved to Client tab: ${migratedClient}`);
  console.log(`Ticket #1033 Vendor replies moved to Vendor tab: ${migratedVendor}`);
  console.log('Incident successfully separated into #1033 and #V1031 restored!');
}

executeMigration().catch(console.error).finally(() => prisma.$disconnect());
