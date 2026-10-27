const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const ticket = await prisma.ticket.findFirst({
    where: { ticketId: { contains: '1031' } },
    include: { replies: { orderBy: { createdAt: 'asc' }, take: 6 } }
  });
  console.log('Ticket ID:', ticket.ticketId);
  console.log('Subject:', ticket.subject);
  console.log('Category:', ticket.category);
  console.log('Circuit ID:', ticket.circuitId);
  console.log('Vendor:', ticket.vendor);
  console.log('Client:', ticket.client);
  console.log('Company:', ticket.company);
  ticket.replies.forEach((r, i) => {
    console.log(`\n--- Reply [${i + 1}] ID: ${r.id} ---`);
    console.log(`Author: ${r.author} | Type: ${r.type} | Date: ${r.date} ${r.time} | CreatedAt: ${r.createdAt}`);
    console.log(`Subject: ${r.subject}`);
    console.log(`To: ${JSON.stringify(r.to)}`);
    console.log(`Cc: ${JSON.stringify(r.cc)}`);
    console.log(`MessageId: ${r.messageId}`);
    console.log(`InReplyTo: ${r.inReplyTo}`);
    console.log(`References: ${r.references}`);
    console.log(`Snippet: ${r.text ? r.text.substring(0, 150).replace(/\n/g, ' ') : ''}`);
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
