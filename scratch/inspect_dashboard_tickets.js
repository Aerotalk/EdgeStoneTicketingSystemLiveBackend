const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspectCurrentTickets() {
    try {
        const ticketIds = ['#V1042', '#V1041', '#V1038', '#V1037', '#V1034'];
        const tickets = await prisma.ticket.findMany({
            where: { ticketId: { in: ticketIds } },
            include: { replies: { orderBy: { createdAt: 'asc' } } },
            orderBy: { createdAt: 'desc' }
        });

        for (const t of tickets) {
            console.log(`\n======================================================`);
            console.log(`TICKET: ${t.ticketId} | Status: ${t.status} | CreatedAt: ${t.createdAt.toISOString()}`);
            console.log(`Header: ${t.header}`);
            console.log(`Total Replies: ${t.replies.length}`);
            for (let i = 0; i < t.replies.length; i++) {
                const r = t.replies[i];
                console.log(`\n  --- Reply #${i + 1} [${r.createdAt.toISOString()}] ---`);
                console.log(`  Author: ${r.author} (${r.type}/${r.category})`);
                console.log(`  Subject: ${r.subject}`);
                console.log(`  MessageId: ${r.messageId}`);
                console.log(`  InReplyTo: ${r.inReplyTo}`);
                const cleanBody = (r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 350);
                console.log(`  Body: ${cleanBody}...`);
            }
        }
    } finally {
        await prisma.$disconnect();
    }
}
inspectCurrentTickets();
