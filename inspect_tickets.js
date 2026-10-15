const prisma = require('./models/index');

async function main() {
    const tickets = await prisma.ticket.findMany({
        select: {
            id: true,
            ticketId: true,
            header: true,
            circuitId: true,
            email: true,
            status: true,
            ticketType: true,
            createdAt: true,
            replies: {
                select: {
                    id: true,
                    author: true,
                    subject: true,
                    createdAt: true,
                    text: true
                }
            }
        },
        orderBy: { createdAt: 'desc' }
    });

    console.log(`Found ${tickets.length} tickets:`);
    for (const t of tickets) {
        console.log(`[${t.ticketId}] (${t.ticketType}) ${t.status} | Circuit: ${t.circuitId} | Header: ${t.header}`);
        for (const r of t.replies) {
            console.log(`   Reply from ${r.from} at ${r.createdAt}: ${(r.subject || r.text || '').substring(0, 70).replace(/\n/g, ' ')}`);
        }
    }
}

main().catch(console.error).finally(() => process.exit(0));
