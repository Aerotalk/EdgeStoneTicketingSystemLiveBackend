const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function mergeV1042() {
    try {
        const source = await prisma.ticket.findUnique({
            where: { ticketId: '#V1042' },
            include: { replies: true }
        });
        const target = await prisma.ticket.findUnique({
            where: { ticketId: '#V1038' }
        });

        if (!source || !target) {
            console.log('Source or Target not found');
            return;
        }

        console.log(`Merging reply from #V1042 into #V1038...`);
        for (const r of source.replies) {
            await prisma.reply.update({
                where: { id: r.id },
                data: { ticketId: target.id }
            });
            console.log(`Reassigned reply ${r.id} from GSOC1 to #V1038`);
        }

        await prisma.activityLog.updateMany({
            where: { ticketId: source.id },
            data: { ticketId: target.id }
        });

        await prisma.ticket.delete({
            where: { id: source.id }
        });
        console.log(`✅ Successfully merged and deleted #V1042`);
    } finally {
        await prisma.$disconnect();
    }
}
mergeV1042();
