const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        const t = await prisma.ticket.findUnique({
            where: { ticketId: '#V1043' },
            include: { replies: true }
        });
        console.log('Ticket #V1043 header:', t?.header);
        console.log('Replies count:', t?.replies?.length);
        if (t?.replies[0]) {
            console.log('Reply text includes 247976?', t.replies[0].text.includes('247976'));
            console.log('Reply subject includes 247976?', t.replies[0].subject.includes('247976'));
            console.log('Reply text includes R7023?', t.replies[0].text.includes('R7023'));
            console.log('Snippet of reply text:\n', t.replies[0].text.substring(0, 400));
        }
    } finally {
        await prisma.$disconnect();
    }
}
check();
