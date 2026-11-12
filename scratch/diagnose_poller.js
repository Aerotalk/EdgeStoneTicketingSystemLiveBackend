'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// Point to the live support mailbox and ensure auto-reply is suppressed during catch-up
process.env.SENDER_EMAIL = 'support@edgestone.in';
process.env.MAIL_USER = 'support@edgestone.in';
process.env.AUTOREPLY = 'false';

const prisma = require('../models/index');
const { fetchNewGraphEmails, getPollerStatus } = require('../services/email/emailPoller');

async function main() {
    // 1. Clean up bogus Microsoft 365 Message Recall Report ticket #V1122 if present
    const recallTicket = await prisma.ticket.findFirst({
        where: { ticketId: '#V1122', email: 'Office365Reports@microsoft.com' }
    });
    if (recallTicket) {
        await prisma.sLARecord.deleteMany({ where: { ticketId: recallTicket.id } });
        await prisma.activityLog.deleteMany({ where: { ticketId: recallTicket.id } });
        await prisma.reply.deleteMany({ where: { ticketId: recallTicket.id } });
        await prisma.ticket.delete({ where: { id: recallTicket.id } });
        console.log('🗑️ Removed Microsoft 365 Message Recall Report (#V1122).');
    }

    console.log('🚀 Running fetchNewGraphEmails() catch-up for support@edgestone.in...');
    await fetchNewGraphEmails();
    console.log('Poller Status after catch-up:', getPollerStatus());

    console.log('\n=== Tickets Created/Updated Since 2026-11-10T19:00:00Z ===');
    const recentTickets = await prisma.ticket.findMany({
        where: { createdAt: { gte: new Date('2026-11-10T19:00:00Z') } },
        include: {
            client: { select: { name: true } },
            vendor: { select: { name: true } },
            replies: { orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true, type: true, category: true, author: true, subject: true } }
        },
        orderBy: { createdAt: 'asc' }
    });

    for (const t of recentTickets) {
        console.log(`\n${t.ticketId} | created=${t.createdAt.toISOString()} | type=${t.ticketType} | status=${t.status} | isMaint=${t.isMaintenance} | ckt=${t.circuitId} | client=${t.client?.name || 'null'} | vendor=${t.vendor?.name || 'null'}`);
        console.log(`  Header: "${t.header}"`);
        console.log(`  Replies (${t.replies.length}):`);
        t.replies.forEach((r, idx) => {
            console.log(`    [${idx + 1}] ${r.createdAt.toISOString()} | type=${r.type} | cat=${r.category} | author="${r.author}" | sub="${r.subject}"`);
        });
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
