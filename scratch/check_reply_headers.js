const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        const replies = await prisma.reply.findMany({
            where: {
                ticket: { ticketId: { in: ['#V1037', '#V1038', '#V1035', '#V1036', '#V1040', '#V1041', '#V1042'] } }
            },
            include: { ticket: true }
        });
        for (const r of replies) {
            console.log(`=== Ticket ${r.ticket.ticketId} ===`);
            console.log('Subject:', r.subject);
            console.log('Message-ID:', r.messageId);
            console.log('In-Reply-To:', r.inReplyTo);
            console.log('References:', r.references);
        }
    } finally {
        await prisma.$disconnect();
    }
}
check();
