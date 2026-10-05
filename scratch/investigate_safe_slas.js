const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const records = await prisma.sLARecord.findMany({
    where: {
      OR: [
        { startDate: { contains: '25 Sept' } },
        { startDate: { contains: '26 Sept' } },
        { startDate: { contains: '27 Sept' } },
        { startDate: { contains: '3 Oct' } },
        { startDate: { contains: '28 Sept' } }
      ]
    },
    include: {
      ticket: {
        select: {
          id: true,
          ticketId: true,
          circuitId: true,
          clientId: true,
          vendorId: true,
          client: { select: { name: true } },
          vendor: { select: { name: true } }
        }
      }
    }
  });

  console.log(`Found ${records.length} matching SLA records.`);

  for (const r of records) {
    const circuit = r.ticket?.circuitId ? await prisma.circuit.findFirst({
      where: {
        OR: [
          { customerCircuitId: r.ticket.circuitId },
          { supplierCircuitId: r.ticket.circuitId },
          { id: r.ticket.circuitId }
        ]
      },
      include: {
        slas: {
          include: { rules: true }
        }
      }
    }) : null;

    console.log(JSON.stringify({
      id: r.id,
      ticketId: r.ticket?.ticketId,
      circuitId: r.ticket?.circuitId,
      client: r.ticket?.client?.name,
      vendor: r.ticket?.vendor?.name,
      type: r.type,
      startDate: r.startDate,
      startTime: r.startTime,
      closeDate: r.closeDate,
      closedTime: r.closedTime,
      status: r.status,
      compensation: r.compensation,
      statusReason: r.statusReason,
      circuitFound: !!circuit,
      circuitSlasCount: circuit?.slas?.length,
      slas: circuit?.slas?.map(s => ({
        id: s.id,
        appliesTo: s.appliesTo,
        rulesCount: s.rules?.length,
        rules: s.rules
      }))
    }, null, 2));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
