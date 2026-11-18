'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const prisma = require('../models/index');

async function main() {
    const targetNums = ['#1134', '#1138', '#1140', '#V1141', '#V1151'];
    const tickets = await prisma.ticket.findMany({
        where: { ticketId: { in: targetNums } },
        include: {
            replies: { orderBy: { createdAt: 'asc' } },
            activityLogs: { orderBy: { createdAt: 'asc' } },
            slaRecords: true,
            notes: true,
            workNotes: true
        }
    });

    const byNum = Object.fromEntries(tickets.map(t => [t.ticketId, t]));
    const t1134 = byNum['#1134'];
    const t1138 = byNum['#1138'];
    const t1140 = byNum['#1140'];
    const tV1141 = byNum['#V1141'];
    const tV1151 = byNum['#V1151'];

    // 1. Save full JSON backup before modifying any records
    const backupPath = path.join(__dirname, `backup_1140_1151_${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
        exportedAt: new Date().toISOString(),
        tickets: byNum
    }, null, 2), 'utf8');
    console.log(`📦 [BACKUP] Saved snapshot to: ${backupPath}`);

    await prisma.$transaction(async (tx) => {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

        // Consolidate #V1141 (EN_IM_17112026_596442 post-closure updates/resolution) into #1140
        if (tV1141 && t1140) {
            for (const r of tV1141.replies) {
                await tx.reply.update({
                    where: { id: r.id },
                    data: { ticketId: t1140.id }
                });
            }
            await tx.activityLog.updateMany({ where: { ticketId: tV1141.id }, data: { ticketId: t1140.id } });
            await tx.sLARecord.deleteMany({ where: { ticketId: tV1141.id } });
            await tx.note.deleteMany({ where: { ticketId: tV1141.id } });
            await tx.workNote.deleteMany({ where: { ticketId: tV1141.id } });
            await tx.ticket.delete({ where: { id: tV1141.id } });

            await tx.activityLog.create({
                data: {
                    ticketId: t1140.id,
                    action: 'remediated',
                    description: `Consolidated ${tV1141.replies.length} post-closure vendor resolution/update replies (EN_IM_17112026_596442) from duplicate Ticket #V1141 into #1140.`,
                    time: timeStr,
                    date: dateStr,
                    author: 'System Remediation'
                }
            });
            console.log(`✅ Consolidated ${tV1141.replies.length} replies from #V1141 into #1140 and removed duplicate #V1141.`);
        }

        // Consolidate #V1151 ("Issue Resolved" notifications for EN_IM_14112026_504699 and EN_IM_16112026_373273)
        if (tV1151) {
            for (const r of tV1151.replies) {
                const sub = String(r.subject || '');
                let destTicket = t1140;
                if (/EN_IM_14112026_504699/i.test(sub) && t1134) {
                    destTicket = t1134;
                } else if (/EN_IM_16112026_373273/i.test(sub) && t1138) {
                    destTicket = t1138;
                }
                if (destTicket) {
                    await tx.reply.update({
                        where: { id: r.id },
                        data: { ticketId: destTicket.id }
                    });
                    await tx.activityLog.create({
                        data: {
                            ticketId: destTicket.id,
                            action: 'remediated',
                            description: `Consolidated post-closure vendor resolution reply ("${sub}") from duplicate Ticket #V1151 into ${destTicket.ticketId}.`,
                            time: timeStr,
                            date: dateStr,
                            author: 'System Remediation'
                        }
                    });
                    console.log(`✅ Consolidated "${sub}" from #V1151 into ${destTicket.ticketId}.`);
                }
            }
            await tx.activityLog.deleteMany({ where: { ticketId: tV1151.id } });
            await tx.sLARecord.deleteMany({ where: { ticketId: tV1151.id } });
            await tx.note.deleteMany({ where: { ticketId: tV1151.id } });
            await tx.workNote.deleteMany({ where: { ticketId: tV1151.id } });
            await tx.reply.deleteMany({ where: { ticketId: tV1151.id } });
            await tx.ticket.delete({ where: { id: tV1151.id } });
            console.log(`✅ Removed duplicate Ticket #V1151.`);
        }
    });
}

main().catch(console.error).finally(() => prisma.$disconnect());
