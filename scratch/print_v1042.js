const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const t = await prisma.ticket.findUnique({
        where: { ticketId: '#V1042' },
        include: { replies: true }
    });
    console.log('Ticket #V1042:');
    console.log('Header:', t.header);
    console.log('Replies:', t.replies.map(r => ({
        author: r.author,
        subject: r.subject,
        createdAt: r.createdAt,
        text: (r.text || '').replace(/<[^>]+>/g, ' ').substring(0, 300)
    })));
    await prisma.$disconnect();
}
check();
