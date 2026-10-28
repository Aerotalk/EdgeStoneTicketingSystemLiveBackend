const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        const tickets = await prisma.ticket.findMany({
            where: {
                ticketId: { in: ['#V1030', '#V1031', '#V1034', '#V1037', '#V1038', '#V1041'] }
            },
            include: { replies: true },
            orderBy: { ticketId: 'asc' }
        });
        for (const t of tickets) {
            console.log(`========================================`);
            console.log(`Ticket: ${t.ticketId} | Status: ${t.status} | CreatedAt: ${t.createdAt.toISOString()}`);
            console.log(`Header: ${t.header}`);
            console.log(`VendorId: ${t.vendorId} | CircuitId: ${t.circuitId} | isMaintenance: ${t.isMaintenance}`);
            console.log(`Replies (${t.replies.length}):`);
            for (const r of t.replies) {
                console.log(`  - [${r.createdAt.toISOString()}] ${r.author} (${r.type}/${r.category}): ${r.subject}`);
                console.log(`    MessageId: ${r.messageId} | InReplyTo: ${r.inReplyTo}`);
            }
        }
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}
check();
