const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const ticket = await prisma.ticket.findFirst({
    where: { ticketId: { contains: '1031' } },
    include: { replies: { orderBy: { createdAt: 'asc' } } }
  });
  
  for (let i = 0; i < ticket.replies.length; i++) {
    const r = ticket.replies[i];
    console.log(`[${i+1}] ID: ${r.id} | CreatedAt: ${r.createdAt.toISOString()} | Date: ${r.date} ${r.time}`);
    console.log(`     Author: ${r.author} (${r.type}, ${r.category})`);
    console.log(`     Subject: ${r.subject}`);
    console.log(`     Has Docket?: ${r.subject?.includes('EN_IM_') || r.text?.includes('EN_IM_')}`);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
