'use strict';

/**
 * ============================================================================
 * SAFE HISTORICAL DATA REMEDIATION SCRIPT
 * ============================================================================
 * Remediates:
 *   1. #1047 & #V1048 (Circuit BA/SG1-DX1-FR5/ESPL-013):
 *      - Restores #1047 status="In Progress", isMaintenance=false, isSlaActive=true
 *      - Moves all CTG replies from #V1048 into #1047 under vendor_af1ead6f-a9a3-40f3-9207-fd279643f10a
 *      - Removes misrouted SLA Rebate reply (d0018a6e-9301-4b5a-8c40-1b9178a74f24) from #1047
 *      - Re-parents #V1048 activityLogs to #1047 and deletes duplicate #V1048 ticket
 *   2. #1039 (Circuit ZL/SG3-MRS2/ESPL-012):
 *      - Removes misrouted SLA Rebate reply (bc3da359-4fc3-46f7-9ac5-87907002e6d7)
 *   3. #V1045 (Circuit CUAU/SG1-MRS1/ESPL-015 | 04/11/2026 Maintenance):
 *      - Removes misrouted SLA Rebate reply (089cf5ab-e5d0-4b19-a7f8-66b0b74693d3)
 *   4. #1032 & #V1046 (Circuit N1/LON-MUM/ESPL-006 | CRQ 1100497033 31-OCT-2026):
 *      - Populates circuitId="N1/LON-MUM/ESPL-006" and clientId on #V1046
 *      - Moves the 31-OCT-2026 CRQ 1100497033 maintenance replies out of incident #1032 into #V1046
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../models/index');

const CTG_VENDOR_ID = 'af1ead6f-a9a3-40f3-9207-fd279643f10a';

async function main() {
    const args = process.argv.slice(2);
    const isExecute = args.includes('--execute');

    const targetTicketNumbers = ['#1047', '#V1048', '#1039', '#V1045', '#1032', '#V1046'];
    const tickets = await prisma.ticket.findMany({
        where: { ticketId: { in: targetTicketNumbers } },
        include: {
            replies: { orderBy: { createdAt: 'asc' } },
            activityLogs: { orderBy: { createdAt: 'asc' } },
            slaRecords: true,
            notes: true,
            workNotes: true
        }
    });

    const byNum = Object.fromEntries(tickets.map(t => [t.ticketId, t]));
    const ticket1047 = byNum['#1047'];
    const ticketV1048 = byNum['#V1048'];
    const ticket1039 = byNum['#1039'];
    const ticketV1045 = byNum['#V1045'];
    const ticket1032 = byNum['#1032'];
    const ticketV1046 = byNum['#V1046'];

    if (!ticket1047) {
        console.error('Could not locate #1047 in the database.');
        process.exit(1);
    }

    // 1. Always write a full pre-remediation backup snapshot
    const backupPath = path.join(__dirname, `backup_historical_remediation_${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
        exportedAt: new Date().toISOString(),
        tickets: byNum
    }, null, 2), 'utf8');
    console.log(`📦 [BACKUP] Full JSON snapshot saved to: ${backupPath}`);

    const ctgRepliesToMove = ticketV1048 ? ticketV1048.replies : [];

    // Identify all misrouted SLA rebate replies across #1047, #1039, #V1045
    const slaRebateReplies = [];
    for (const t of [ticket1047, ticket1039, ticketV1045].filter(Boolean)) {
        for (const r of t.replies) {
            if (/sla\s*rebate\s*request/i.test(r.subject || '')) {
                slaRebateReplies.push({ ticketNum: t.ticketId, reply: r });
            }
        }
    }

    // Identify 31-OCT-2026 CRQ 1100497033 maintenance replies misrouted onto incident #1032
    const crq31OctRepliesToMove = ticket1032
        ? ticket1032.replies.filter(r =>
            /31-OCT-2026/i.test(r.subject || '')
        )
        : [];

    console.log('\n=============================================================');
    console.log(`REMEDIATION PLAN (${isExecute ? 'LIVE EXECUTION' : 'DRY-RUN MODE — NO DB WRITES'})`);
    console.log('=============================================================');
    console.log(`1. Ticket #1047 (${ticket1047.id}):`);
    console.log(`   - Current: status="${ticket1047.status}", isMaintenance=${ticket1047.isMaintenance}, isSlaActive=${ticket1047.isSlaActive}`);
    console.log(`   - Target : status="In Progress", isMaintenance=false, isSlaActive=true`);
    if (ticketV1048) {
        console.log(`2. Consolidate #V1048 (${ticketV1048.id}) into #1047 (${ticket1047.id}):`);
        console.log(`   - Move ${ctgRepliesToMove.length} CTG replies to #1047 under "vendor_${CTG_VENDOR_ID}"`);
        console.log(`   - Move ${ticketV1048.activityLogs.length} activity logs to #1047 and delete duplicate ticket #V1048`);
    }
    console.log(`3. Remove Misrouted SLA Rebate Replies (${slaRebateReplies.length}):`);
    for (const item of slaRebateReplies) {
        console.log(`   - On ${item.ticketNum}: reply ${item.reply.id} | "${item.reply.subject}"`);
    }
    if (ticket1032 && ticketV1046) {
        console.log(`4. Fix #V1046 & #1032 (31-OCT-2026 CRQ 1100497033 Maintenance):`);
        console.log(`   - Set #V1046 circuitId="N1/LON-MUM/ESPL-006", clientId="${ticket1032.clientId}"`);
        console.log(`   - Move ${crq31OctRepliesToMove.length} 31-OCT-2026 maintenance replies from #1032 to #V1046`);
    }

    if (!isExecute) {
        console.log('\nℹ️  Dry-run complete. Run with --execute to apply changes.');
        return;
    }

    await prisma.$transaction(async (tx) => {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

        // Step 1: Fix #1047 flags
        await tx.ticket.update({
            where: { id: ticket1047.id },
            data: {
                status: 'In Progress',
                isMaintenance: false,
                isSlaActive: true
            }
        });

        // Step 2: Consolidate #V1048 into #1047 and remove duplicate #V1048
        if (ticketV1048) {
            for (const r of ctgRepliesToMove) {
                const isVendorAuthor = /chinatelecomglobal\.com/i.test(r.author || '');
                await tx.reply.update({
                    where: { id: r.id },
                    data: {
                        ticketId: ticket1047.id,
                        category: `vendor_${CTG_VENDOR_ID}`,
                        type: isVendorAuthor ? 'vendor' : r.type
                    }
                });
            }

            // Re-parent activity logs from #V1048 to #1047
            await tx.activityLog.updateMany({
                where: { ticketId: ticketV1048.id },
                data: { ticketId: ticket1047.id }
            });

            // Clean up any dependent records on #V1048 before deleting duplicate ticket
            await tx.sLARecord.deleteMany({ where: { ticketId: ticketV1048.id } });
            await tx.note.deleteMany({ where: { ticketId: ticketV1048.id } });
            await tx.workNote.deleteMany({ where: { ticketId: ticketV1048.id } });
            await tx.reply.deleteMany({ where: { ticketId: ticketV1048.id } });

            await tx.ticket.delete({
                where: { id: ticketV1048.id }
            });
        }

        // Step 3: Delete misrouted SLA Rebate replies from #1047, #1039, #V1045
        for (const item of slaRebateReplies) {
            await tx.reply.delete({
                where: { id: item.reply.id }
            });
        }

        // Step 4: Fix #V1046 & move 31-OCT-2026 CRQ 1100497033 replies from #1032 to #V1046
        if (ticket1032 && ticketV1046) {
            await tx.ticket.update({
                where: { id: ticketV1046.id },
                data: {
                    circuitId: 'N1/LON-MUM/ESPL-006',
                    clientId: ticket1032.clientId
                }
            });

            for (const r of crq31OctRepliesToMove) {
                await tx.reply.update({
                    where: { id: r.id },
                    data: {
                        ticketId: ticketV1046.id
                    }
                });
            }
        }

        // Step 5: Audit log on #1047
        await tx.activityLog.create({
            data: {
                ticketId: ticket1047.id,
                action: 'remediated',
                description: `Consolidated ${ctgRepliesToMove.length} CTG vendor replies from #V1048 into vendor_${CTG_VENDOR_ID}; removed misrouted SLA rebate reply; restored status="In Progress", isMaintenance=false.`,
                time: timeStr,
                date: dateStr,
                author: 'System Remediation'
            }
        });
    });

    console.log('\n✅ [EXECUTED] Historical remediation transaction committed successfully.');
}

main()
    .catch(err => {
        console.error('Remediation script error:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
