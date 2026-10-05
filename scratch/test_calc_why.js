const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const slaRecordService = require('../services/slaRecordService');

async function test() {
  const tickets = await prisma.ticket.findMany({
    where: {
      ticketId: { in: ['#1063', '#1065', '#1066', '#1074'] }
    },
    include: { slaRecords: true }
  });

  for (const t of tickets) {
    console.log(`\n=== Checking Ticket ${t.ticketId} ===`);
    console.log(`Circuit ID: ${t.circuitId}`);
    console.log(`Status: ${t.status}`);
    
    // Check circuit in DB
    const circuit = await prisma.circuit.findFirst({
      where: {
        OR: [
          { customerCircuitId: t.circuitId },
          { supplierCircuitId: t.circuitId },
          { id: t.circuitId }
        ]
      },
      include: {
        slas: {
          include: { rules: true }
        }
      }
    });

    console.log(`Circuit found? ${!!circuit} (ID: ${circuit?.id})`);
    if (circuit) {
      console.log(`Circuit Customer MRC: ${circuit.mrc}, Supplier MRC: ${circuit.supplierMrc}`);
      console.log(`SLA definitions on circuit: ${circuit.slas.length}`);
      for (const s of circuit.slas) {
        console.log(`  SLA ${s.id} appliesTo=${s.appliesTo}, rules count=${s.rules.length}`);
        for (const r of s.rules) {
          console.log(`    Rule: ${r.lowerLimit}% - ${r.upperLimit}% => ${r.compensationPercentage}%`);
        }
      }
    }

    console.log(`Current SLA Records for ${t.ticketId}:`);
    for (const r of t.slaRecords) {
      console.log(`  Record ID: ${r.id}, type: ${r.type}, start: ${r.startDate} ${r.startTime}, close: ${r.closeDate} ${r.closedTime}`);
      console.log(`  status: "${r.status}", compensation: "${r.compensation}", reason: "${r.statusReason}"`);
    }
  }
}

test().catch(console.error).finally(() => prisma.$disconnect());
