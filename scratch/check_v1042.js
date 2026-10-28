const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        const t = await prisma.ticket.findUnique({
            where: { ticketId: '#V1042' },
            include: { replies: true }
        });
        if (!t) {
            console.log('Ticket #V1042 does not exist in DB!');
            const allTickets = await prisma.ticket.findMany({
                where: { ticketId: { startsWith: '#V' } },
                select: { ticketId: true, header: true, createdAt: true, status: true },
                orderBy: { ticketId: 'asc' }
            });
            console.log('All current Vendor tickets in DB:', allTickets);
        } else {
            console.log(`Ticket #V1042 found:`);
            console.log('Header:', t.header);
            console.log('CreatedAt:', t.createdAt);
            console.log('Replies:', t.replies.map(r => ({ author: r.author, subject: r.subject, createdAt: r.createdAt })));
        }
    } finally {
        await prisma.$disconnect();
    }
}
check();
