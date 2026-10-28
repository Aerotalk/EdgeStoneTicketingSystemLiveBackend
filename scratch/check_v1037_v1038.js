const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        const t = await prisma.ticket.findMany({
            where: { ticketId: { in: ['#V1037', '#V1038'] } },
            include: { replies: true }
        });
        for (const item of t) {
            console.log(`=== ${item.ticketId} ===`);
            console.log('Subject:', item.header);
            for (const r of item.replies) {
                console.log('Reply from:', r.author);
                console.log('Reply body snippet:\n', r.text.substring(0, 500));
            }
        }
    } finally {
        await prisma.$disconnect();
    }
}
check();
