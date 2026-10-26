const prisma = require('../models/index');

async function main() {
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { ticketId: { contains: '1033' } },
        { header: { contains: '14867801' } },
        { header: { contains: '41506808' } },
        { header: { contains: 'BGP' } }
      ]
    },
    include: {
      replies: {
        orderBy: { createdAt: 'asc' }
      },
      client: true,
      vendor: true
    },
    orderBy: { createdAt: 'desc' }
  });

  console.log(`Found ${tickets.length} matching tickets:`);
  for (const t of tickets) {
    console.log('\n======================================================');
    console.log(`Ticket DB ID: ${t.id}`);
    console.log(`Ticket Display ID: ${t.ticketId}`);
    console.log(`Ticket Type: ${t.ticketType}`);
    console.log(`Client: ${t.client?.name} | Vendor: ${t.vendor?.name}`);
    console.log(`Status: ${t.status}`);
    console.log(`Header: ${t.header}`);
    console.log(`Email (requestor): ${t.email}`);
    console.log(`Circuit ID: ${t.circuitId}`);
    console.log(`Ticket MessageId: ${t.messageId}`);
    console.log(`CreatedAt: ${t.createdAt}`);
    console.log(`Replies count: ${t.replies.length}`);
    for (const r of t.replies) {
      console.log(`  ----------------------------------------`);
      console.log(`  Reply ID: ${r.id}`);
      console.log(`  Author: ${r.author} | Type: ${r.type} | Category: ${r.category}`);
      console.log(`  To: ${JSON.stringify(r.to)}`);
      console.log(`  Cc: ${JSON.stringify(r.cc)}`);
      console.log(`  Subject: ${r.subject}`);
      console.log(`  MessageId: ${r.messageId}`);
      console.log(`  CreatedAt: ${r.createdAt}`);
      console.log(`  Text snippet: ${(r.text || '').substring(0, 150).replace(/\n/g, ' ')}`);
    }
  }
}

main().catch(console.error).finally(() => process.exit(0));
