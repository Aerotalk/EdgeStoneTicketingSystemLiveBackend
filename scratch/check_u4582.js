const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        const matches = await prisma.ticket.findMany({
            where: {
                OR: [
                    { header: { contains: 'U4582' } },
                    { header: { contains: 'U4584' } },
                    { header: { contains: '11680667' } },
                    { header: { contains: '11680956' } }
                ]
            }
        });
        console.log('Matches:', matches.map(t => ({ id: t.ticketId, header: t.header, createdAt: t.createdAt })));
    } finally {
        await prisma.$disconnect();
    }
}
check();
