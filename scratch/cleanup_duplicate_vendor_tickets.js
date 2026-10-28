const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MERGE_MAP = [
    { fromId: '#V1035', toId: '#V1031', reason: 'Airtel CRQ 1100494638 duplicate' },
    { fromId: '#V1036', toId: '#V1030', reason: 'Airtel CRQ 1100488280 duplicate' },
    { fromId: '#V1040', toId: '#V1034', reason: 'PCCW SR247976 duplicate' },
    { fromId: '#V1042', toId: '#V1041', reason: 'PCCW R7023 Outage duplicate' },
    { fromId: '#V1043', toId: '#V1041', reason: 'PCCW R7023 Outage duplicate' },
];

async function mergeDuplicateTickets() {
    console.log('--- Starting Merge of Duplicate Vendor Tickets ---');
    try {
        for (const { fromId, toId, reason } of MERGE_MAP) {
            const sourceTicket = await prisma.ticket.findUnique({
                where: { ticketId: fromId },
                include: { replies: true }
            });
            const targetTicket = await prisma.ticket.findUnique({
                where: { ticketId: toId }
            });

            if (!sourceTicket) {
                console.log(`Source ticket ${fromId} not found, skipping.`);
                continue;
            }
            if (!targetTicket) {
                console.log(`Target ticket ${toId} not found, skipping.`);
                continue;
            }

            console.log(`Merging ${fromId} into ${toId} (${reason})...`);

            // 1. Move replies to target ticket
            for (const r of sourceTicket.replies) {
                // Check if reply with same messageId already exists on target ticket
                const exists = await prisma.reply.findFirst({
                    where: { ticketId: targetTicket.id, messageId: r.messageId }
                });
                if (exists) {
                    console.log(`  Deleting duplicate reply ${r.id} (messageId: ${r.messageId})`);
                    await prisma.reply.delete({ where: { id: r.id } });
                } else {
                    console.log(`  Reassigning reply ${r.id} to ${toId}`);
                    await prisma.reply.update({
                        where: { id: r.id },
                        data: { ticketId: targetTicket.id }
                    });
                }
            }

            // 2. Move activity logs
            await prisma.activityLog.updateMany({
                where: { ticketId: sourceTicket.id },
                data: { ticketId: targetTicket.id }
            });

            // 3. Move tasks if any
            try {
                await prisma.task.updateMany({
                    where: { ticketId: sourceTicket.id },
                    data: { ticketId: targetTicket.id }
                });
            } catch (_) {}

            // 4. Delete the empty duplicate source ticket
            await prisma.ticket.delete({
                where: { id: sourceTicket.id }
            });
            console.log(`✅ Successfully merged and deleted ${fromId} -> ${toId}`);
        }
        console.log('--- Merge Complete ---');
    } catch (e) {
        console.error('Merge error:', e);
    } finally {
        await prisma.$disconnect();
    }
}

mergeDuplicateTickets();
