'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const prisma = require('../models/index');

async function main() {
    const ticket1134 = await prisma.ticket.findFirst({
        where: { ticketId: '#1134' },
        include: {
            replies: { orderBy: { createdAt: 'asc' } },
            activityLogs: { orderBy: { createdAt: 'asc' } }
        }
    });

    const ticket1138 = await prisma.ticket.findFirst({
        where: { ticketId: '#1138' },
        include: {
            replies: { orderBy: { createdAt: 'asc' } },
            activityLogs: { orderBy: { createdAt: 'asc' } }
        }
    });

    if (!ticket1134 || !ticket1138) {
        console.error('Could not find #1134 or #1138 in database.');
        process.exit(1);
    }

    // 1. Save full JSON backup before modifying any records
    const backupPath = path.join(__dirname, `backup_1134_1138_${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
        exportedAt: new Date().toISOString(),
        ticket1134,
        ticket1138
    }, null, 2), 'utf8');
    console.log(`📦 [BACKUP] Saved snapshot of #1134 and #1138 to: ${backupPath}`);

    // 2. Identify all replies on #1134 that belong to #1138 (16-Nov-2026 incident: Neutrality.One #214664 / EN_IM_16112026_373273 / 16- Nov-2026)
    const repliesToMoveTo1138 = ticket1134.replies.filter(r => {
        const sub = String(r.subject || '');
        const txt = String(r.text || '');
        // Explicitly keep any #1134 / #214619 / EN_IM_14112026_* replies on #1134
        if (/\[#1134(?:-V)?\]/i.test(sub) || /#214619\b/i.test(sub) || /EN_IM_14112026_/i.test(sub)) {
            return false;
        }
        // Move replies belonging to #1138's 16-Nov-2026 incident:
        return (
            /EN_IM_16112026_373273/i.test(sub) ||
            /EN_IM_16112026_373273/i.test(txt) ||
            /16-\s*Nov-2026/i.test(sub) ||
            /#214664\b/i.test(sub)
        );
    });

    const vendorRepliesMoved = repliesToMoveTo1138.filter(r => r.category && r.category.startsWith('vendor'));
    const clientRepliesMoved = repliesToMoveTo1138.filter(r => r.category === 'client');

    console.log(`\nFound ${repliesToMoveTo1138.length} misrouted replies on #1134 belonging to #1138:`);
    console.log(`  - Vendor replies (EN_IM_16112026_373273 / 16-Nov-2026): ${vendorRepliesMoved.length}`);
    console.log(`  - Client replies (Neutrality.One #214664):              ${clientRepliesMoved.length}`);
    for (const r of repliesToMoveTo1138) {
        console.log(`    • ${r.createdAt.toISOString()} | type=${r.type} | cat=${r.category} | author="${r.author}" | sub="${r.subject}"`);
    }

    await prisma.$transaction(async (tx) => {
        for (const r of repliesToMoveTo1138) {
            await tx.reply.update({
                where: { id: r.id },
                data: {
                    ticketId: ticket1138.id
                }
            });
        }

        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

        await tx.activityLog.create({
            data: {
                ticketId: ticket1138.id,
                action: 'remediated',
                description: `Mapped ${vendorRepliesMoved.length} vendor replies (EN_IM_16112026_373273 / 16-Nov-2026) and ${clientRepliesMoved.length} client replies (#214664) from #1134 to #1138.`,
                time: timeStr,
                date: dateStr,
                author: 'System Remediation'
            }
        });

        await tx.activityLog.create({
            data: {
                ticketId: ticket1134.id,
                action: 'remediated',
                description: `Moved ${repliesToMoveTo1138.length} replies belonging to 16-Nov-2026 incident (#214664 / EN_IM_16112026_373273) from #1134 to #1138.`,
                time: timeStr,
                date: dateStr,
                author: 'System Remediation'
            }
        });
    });

    console.log('\n✅ [EXECUTED] Successfully mapped all #1138 replies from #1134 to #1138.');

    // 3. Verify final state of #1134 and #1138
    for (const num of ['#1134', '#1138']) {
        const updated = await prisma.ticket.findFirst({
            where: { ticketId: num },
            include: {
                replies: { orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true, type: true, category: true, author: true, subject: true } }
            }
        });
        const byCat = {};
        for (const r of updated.replies) {
            byCat[r.category] = (byCat[r.category] || 0) + 1;
        }
        console.log(`\n=== Final State of ${updated.ticketId} (${updated.header}) ===`);
        console.log(`Total Replies: ${updated.replies.length} | Breakdown: ${JSON.stringify(byCat)}`);
        if (num === '#1138') {
            updated.replies.forEach((r, idx) => {
                console.log(`  [${idx + 1}] ${r.createdAt.toISOString()} | type=${r.type} | cat=${r.category} | author="${r.author}" | sub="${r.subject}"`);
            });
        }
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
