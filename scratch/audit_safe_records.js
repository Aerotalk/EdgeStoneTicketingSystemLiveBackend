const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkSafeRecords() {
  const records = await prisma.sLARecord.findMany({
    include: {
      ticket: {
        select: {
          ticketId: true,
          circuitId: true,
          status: true,
          client: { select: { name: true } },
          vendor: { select: { name: true } }
        }
      }
    }
  });

  const circuits = await prisma.circuit.findMany({
    include: {
      slas: {
        include: { rules: true }
      }
    }
  });

  const circuitMap = {};
  for (const c of circuits) {
    if (c.customerCircuitId) circuitMap[c.customerCircuitId] = c;
    if (c.supplierCircuitId) circuitMap[c.supplierCircuitId] = c;
    circuitMap[c.id] = c;
  }

  console.log(`Total SLA Records: ${records.length}`);
  const analysis = [];

  for (const r of records) {
    let downtime = 0;
    if (r.startDate && r.startTime && r.closeDate && r.closeDate !== '-' && r.closedTime && r.closedTime !== '-') {
      const cleanStart = (r.startTime || '').replace(/hrs/i, '').trim().replace(/^24:/, '00:');
      const cleanClosed = (r.closedTime || '').replace(/hrs/i, '').trim().replace(/^24:/, '00:');
      const s = new Date(`${r.startDate} ${cleanStart}`);
      const e = new Date(`${r.closeDate} ${cleanClosed}`);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
        downtime = Math.round((e.getTime() - s.getTime()) / 60000);
        if (downtime < 0) downtime = 0;
      }
    }

    const ckt = r.ticket?.circuitId ? circuitMap[r.ticket.circuitId] : null;
    const applicableSla = ckt?.slas?.find(s => s.appliesTo === (r.type === 'VENDOR' ? 'VENDOR' : 'CUSTOMER'));
    const rulesCount = applicableSla?.rules?.length || 0;

    analysis.push({
      ticketId: r.ticket?.ticketId,
      circuitId: r.ticket?.circuitId,
      type: r.type,
      downtimeMins: downtime,
      status: r.status,
      compensation: r.compensation,
      statusReason: r.statusReason,
      circuitExists: !!ckt,
      rulesCount: rulesCount
    });
  }

  console.log(JSON.stringify(analysis, null, 2));
}

checkSafeRecords().catch(console.error).finally(() => prisma.$disconnect());
