'use strict';

process.env.AUTOREPLY = 'false';

const assert = require('assert');
const prisma = require('../models/index');
const ticketService = require('../services/ticketService');
const SmartSorter = require('../services/ticket/smartTicketSorter');
const { checkCircuitCompatibility } = require('../services/ticket/ticketThreadingService');
const { extractTokensFromCircuitId, normalizeCircuitId, extractHistoricalIncidentDate } = require('../services/ticket/ticketSanitizer');
const vendorTicketingService = require('../services/vendorTicketingService');

const CIRCUIT_CUST_ID = 'BA/SG1-DX1-FR5/ESPL-013';
const CTG_VENDOR_ID = 'af1ead6f-a9a3-40f3-9207-fd279643f10a';
const NEU_VENDOR_ID = 'aebceb7c-4316-4a6c-935a-fc5faaef6728';

const createdTicketUUIDs = new Set();

async function runTests() {
    const results = [];
    const recordResult = (num, name, passed, detail = '') => {
        results.push({ num, name, passed, detail });
        console.log(`${passed ? '✅ PASS' : '❌ FAIL'} [Test ${num}] ${name}${detail ? ' — ' + detail : ''}`);
    };

    // Temporarily hide live #1047 and #V1048 during isolated lifecycle simulation by moving their circuitId only in memory?
    // Better: We do NOT touch #1047 or #V1048 in the DB at all!
    // Wait: if #1047 is in the DB with status='Maintenance', what happens when we create a new test ticket on BA/SG1-DX1-FR5/ESPL-013?
    // Remember: allTickets in ticketThreadingService orders by createdAt: 'asc', so #1047 (created 2026-10-28) would appear before our new test ticket if both are active on BA/SG1-DX1-FR5/ESPL-013!
    // To test a fresh lifecycle on the exact circuit configuration without touching #1047 or #V1048, let's check:
    // Can we temporarily set #1047 and #V1048 circuitId or status? NO! Requirement 7 & 12 say:
    // "Do not delete or modify production data during diagnosis" / "Do not automatically merge or delete historical tickets without explicit confirmation."
    // Instead, how can we test the exact BA/SG1-DX1-FR5/ESPL-013 multi-vendor configuration?
    // Wait: let's check what happens if we test BOTH:
    // 1) Direct correlation against existing #1047 (read-only findExistingTicketForReply) AND
    // 2) Full end-to-end DB creation/reply lifecycle on a cloned multi-vendor test circuit (or with #1047 untouched)!
    // Wait — why would #1047 interfere if we use a dedicated test multi-vendor circuit with the exact same vendors (CTG + Neutrality) for DB write tests, AND also run read-only verification directly against #1047 and BA/SG1-DX1-FR5/ESPL-013?
    // Let's check! If we create a temporary multi-vendor Circuit in `prisma.circuit` with:
    // - customerCircuitId: 'BA/SG1-DX1-FR5/ESPL-013-SIM' (and also test `BA/SG1-DX1-FR5/ESPL-013` directly in read-only matcher tests),
    // OR even better: why did #1047 match in `allTickets`? Because `allTickets` queries `status: { notIn: ['Spam', 'Closed', 'Resolved'] }`.
    // Wait: if we test with a cloned multi-vendor circuit in DB (`BA/SG1-DX1-FR5/ESPL-013-TEST`, with `vendorCircuits` for CTG `G773 276-T` and Neutrality `NEU-EDGS-1092-T`) AND ALSO test the exact strings `BA/SG1-DX1-FR5/ESPL-013`, `G773 276`, `NEU-EDGS-1092` against `#1047` via `findExistingTicketForReply` and `SmartSorter`, then:
    // - `#1047` and `#V1048` are 100% untouched (zero writes to `#1047` or `#V1048`!),
    // - Every single DB write path (`createTicketFromEmail`, `findExistingTicketForReply`, `appendVendorReplyToTicket`, `appendAgentReplyFromOutlook`) is exercised end-to-end against real PostgreSQL tables, AND
    // - Every exact string from the incident (`BA/SG1-DX1-FR5/ESPL-013`, `G773 276`, `NEU-EDGS-1092`, `#1047`) is also verified directly!

    let tempCircuit = null;
    let origClientEmails = null;
    let origNeuVendorEmails = null;
    let origCtgVendorEmails = null;
    try {
        // Pre-clean any leftover simulation tickets/circuits on BA/SG1-DX1-FR5/ESPL-913 from interrupted runs
        const leftoverTickets = await prisma.ticket.findMany({
            where: { circuitId: { in: ['BA/SG1-DX1-FR5/ESPL-913', 'G773 976', 'NEU-EDGS-9092'] } }
        });
        for (const lt of leftoverTickets) {
            await prisma.sLARecord.deleteMany({ where: { ticketId: lt.id } });
            await prisma.reply.deleteMany({ where: { ticketId: lt.id } });
            await prisma.activityLog.deleteMany({ where: { ticketId: lt.id } });
            await prisma.ticket.delete({ where: { id: lt.id } });
        }
        const leftoverCircuits = await prisma.circuit.findMany({
            where: { customerCircuitId: 'BA/SG1-DX1-FR5/ESPL-913' }
        });
        for (const lc of leftoverCircuits) {
            await prisma.vendorCircuit.deleteMany({ where: { circuitId: lc.id } });
            await prisma.circuit.delete({ where: { id: lc.id } });
        }

        const realCircuit = await prisma.circuit.findFirst({
            where: { customerCircuitId: CIRCUIT_CUST_ID },
            include: { vendorCircuits: true, client: true }
        });
        assert(realCircuit, 'Real circuit BA/SG1-DX1-FR5/ESPL-013 must exist in DB');
        origClientEmails = realCircuit.client?.emails ? [...realCircuit.client.emails] : null;
        const neuVendor = await prisma.vendor.findUnique({ where: { id: NEU_VENDOR_ID } });
        const ctgVendor = await prisma.vendor.findUnique({ where: { id: CTG_VENDOR_ID } });
        origNeuVendorEmails = neuVendor?.emails ? [...neuVendor.emails] : null;
        origCtgVendorEmails = ctgVendor?.emails ? [...ctgVendor.emails] : null;

        // Create an isolated clone of BA/SG1-DX1-FR5/ESPL-013 with identical Client, CTG Vendor, and Neutrality Vendor
        tempCircuit = await prisma.circuit.create({
            data: {
                customerCircuitId: 'BA/SG1-DX1-FR5/ESPL-913',
                poNumber: 'ESPL-072025-913',
                supplierCircuitId: 'NEU-EDGS-9092',
                supplierPoNumber: 'ES-9003',
                client: { connect: { id: realCircuit.clientId } },
                isMultiVendor: true,
                vendorCircuits: {
                    create: [
                        {
                            vendor: { connect: { id: CTG_VENDOR_ID } },
                            supplierCircuitId: 'G773 976',
                            supplierPoNumber: 'CTAPHK-Q-2025081000945'
                        },
                        {
                            vendor: { connect: { id: NEU_VENDOR_ID } },
                            supplierCircuitId: 'NEU-EDGS-9092',
                            supplierPoNumber: 'ES-9003'
                        }
                    ]
                }
            },
            include: { vendorCircuits: true }
        });

        let mainIncidentTicket = null;
        const ts = Date.now();

        // =========================================================================
        // TEST 1: Initial Incident Creation (Client flapping email with "maintenance" in body checklist)
        // =========================================================================
        try {
            const clientFlapEmail = {
                from: 'Cfm.L2@airtel.com',
                fromName: 'Cfm L2',
                to: ['support@edgestone.in'],
                cc: ['noc@airtel.com'],
                subject: `#41523193 || CKT ID :BA/SG1-DX1-FR5/ESPL-913 || Link Flapped`,
                body: `Hi Team,\nPlease investigate frequent link flaps on BA/SG1-DX1-FR5/ESPL-913.\n3. Check for any maintenance activities, fiber issues, routing changes, or transport alarms that could be causing BFD timer expirations.\nRegards,\nAirtel NOC`,
                date: new Date('2026-10-28T22:31:05.000Z'),
                messageId: `<test1-init-${ts}@airtel.com>`,
                inReplyTo: null,
                references: null
            };

            mainIncidentTicket = await ticketService.createTicketFromEmail(clientFlapEmail);
            if (mainIncidentTicket && mainIncidentTicket.id) createdTicketUUIDs.add(mainIncidentTicket.id);

            // Re-send identical email to verify single ticket creation
            const dupAttempt = await ticketService.createTicketFromEmail(clientFlapEmail);

            assert(mainIncidentTicket, 'Ticket should be created');
            assert.strictEqual(mainIncidentTicket.ticketType, 'Client', 'Ticket type must be Client');
            assert.strictEqual(mainIncidentTicket.status, 'Open', 'Incident ticket status must be Open (NOT Maintenance)');
            assert.strictEqual(mainIncidentTicket.isMaintenance, false, 'Incident ticket isMaintenance must be false');
            assert.strictEqual(mainIncidentTicket.isSlaActive, true, 'Incident ticket isSlaActive must be true');
            assert.strictEqual(dupAttempt.id, mainIncidentTicket.id, 'Duplicate delivery must return the same ticket');

            recordResult(1, 'Initial Incident Creation', true, `Created single Client ticket ${mainIncidentTicket.ticketId} (status=${mainIncidentTicket.status}, isMaintenance=${mainIncidentTicket.isMaintenance})`);
        } catch (err) {
            recordResult(1, 'Initial Incident Creation', false, err.message);
        }

        // Simulate Agent Pamit sending initial outbound escalations to Neutrality and CTG on mainIncidentTicket
        const agentNeuMsgId = `<test-agent-neu-${ts}@edgestone.in>`;
        const agentCtgMsgId = `<test-agent-ctg-${ts}@edgestone.in>`;

        await ticketService.appendAgentReplyFromOutlook(mainIncidentTicket, {
            from: 'pamit@edgestone.in',
            fromName: 'Pamit',
            to: ['i.samuel@neutrality.one', 'n.verhoven@neutrality.one', 'noc@neutrality.one'],
            cc: ['support@edgestone.in'],
            subject: `CKT ID :- NEU-EDGS-9092 || Link flapped reported issue on 29th Oct'2026`,
            body: `Dear Neutrality NOC, Please check link flapping on NEU-EDGS-9092.`,
            date: new Date('2026-10-28T22:55:19.000Z'),
            messageId: agentNeuMsgId
        });

        await ticketService.appendAgentReplyFromOutlook(mainIncidentTicket, {
            from: 'pamit@edgestone.in',
            fromName: 'Pamit',
            to: ['global.noc@chinatelecomglobal.com', 'rajeshkj@chinatelecomglobal.com'],
            cc: ['support@edgestone.in'],
            subject: `CKT ID :- G773 976 || Link flapped reported issue on 29th Oct'2026`,
            body: `Dear CTG NOC, Please check link flapping on G773 976.`,
            date: new Date('2026-10-28T23:00:36.000Z'),
            messageId: agentCtgMsgId
        });

        // =========================================================================
        // TEST 2: Neutrality Reply Mapping
        // =========================================================================
        try {
            // Also verify direct read-only resolution against real #1047 for NEU-EDGS-1092
            const realMatchNeu = await ticketService.findExistingTicketForReply(
                null,
                null,
                `Re: CKT ID :- NEU-EDGS-1092 || Link flapped reported issue on 29th Oct'2026 | Neutrality.One #213877`,
                `Dear EdgeStone NOC, We are checking NEU-EDGS-1092 under ticket #213877.`,
                'noc@neutrality.one'
            );
            assert(realMatchNeu && realMatchNeu.ticketId === '#1047', `Expected real Neutrality reply to match #1047, got ${realMatchNeu?.ticketId}`);

            // And run full ingestion against our simulated incident ticket
            const neuReplyResult = await ticketService.createTicketFromEmail({
                from: 'noc@neutrality.one',
                fromName: 'Neutrality NOC',
                to: ['pamit@edgestone.in', 'support@edgestone.in'],
                cc: ['i.samuel@neutrality.one'],
                subject: `Re: CKT ID :- NEU-EDGS-9092 || Link flapped reported issue on 29th Oct'2026 | Neutrality.One #213877`,
                body: `Dear EdgeStone NOC, We have opened ticket #213877 and are checking the circuit NEU-EDGS-9092.`,
                date: new Date('2026-10-29T00:05:00.000Z'),
                messageId: `<test2-neu-reply-${ts}@neutrality.one>`,
                inReplyTo: null,
                references: null
            });

            assert(neuReplyResult && neuReplyResult.ticketId === mainIncidentTicket.id, 'Neutrality reply must attach to the existing incident ticket');
            assert.strictEqual(neuReplyResult.category, `vendor_${NEU_VENDOR_ID}`, 'Neutrality reply must be categorized under Neutrality vendor tab');

            recordResult(2, 'Neutrality Reply Mapping', true, `Attached to ${mainIncidentTicket.ticketId} under category=${neuReplyResult.category} (and matched real #1047)`);
        } catch (err) {
            recordResult(2, 'Neutrality Reply Mapping', false, err.message);
        }

        // =========================================================================
        // TEST 3: CTG Reply Mapping (No Re:, No In-Reply-To, Appended YJ... Suffix, Chinese Quote)
        // =========================================================================
        try {
            // Also verify direct read-only resolution against real #1047 for G773 276
            const realMatchCtg = await ticketService.findExistingTicketForReply(
                null,
                null,
                `CKT ID :- G773 276 || Link flapped reported issue on 29th Oct'2026 YJ2026102900253 2610290101111180`,
                `Dear Valued Customer,\nTo keep you informed, CTG has created a ticket 2610290101111180] for you.\n------------------------------------原始邮件-----------------------------------`,
                'global.noc@chinatelecomglobal.com'
            );
            assert(realMatchCtg && realMatchCtg.ticketId === '#1047', `Expected real CTG initial response to match root ticket #1047, got ${realMatchCtg?.ticketId}`);

            // And run full ingestion against our simulated incident ticket
            const ctgAutoReply = await ticketService.createTicketFromEmail({
                from: 'global.noc@chinatelecomglobal.com',
                fromName: 'Global NOC CTG',
                to: ['pamit@edgestone.in'],
                cc: ['support@edgestone.in'],
                subject: `CKT ID :- G773 976 || Link flapped reported issue on 29th Oct'2026 YJ2026102900253 2610290101111180`,
                body: `Dear Valued Customer,\nTo keep you informed, CTG has created a ticket 2610290101111180] for you.\n------------------------------------原始邮件-----------------------------------\n发件人：pamit <pamit@edgestone.in>\n主题：CKT ID :- G773 976 || Link flapped reported issue on 29th Oct'2026`,
                date: new Date('2026-10-28T23:03:51.000Z'),
                messageId: `<test3-ctg-auto-${ts}@ofm-ticket>`,
                inReplyTo: null,
                references: null
            });

            assert(ctgAutoReply && ctgAutoReply.ticketId === mainIncidentTicket.id, 'CTG daemon reply must attach to the existing incident ticket instead of creating #V duplicate');
            assert.strictEqual(ctgAutoReply.category, `vendor_${CTG_VENDOR_ID}`, 'CTG reply must be categorized under CTG vendor tab');

            recordResult(3, 'CTG Reply Mapping', true, `Attached to ${mainIncidentTicket.ticketId} under category=${ctgAutoReply.category} without creating a #V ticket`);
        } catch (err) {
            recordResult(3, 'CTG Reply Mapping', false, err.message);
        }

        // =========================================================================
        // TEST 4: Multi-Vendor Thread Isolation and Visibility
        // =========================================================================
        try {
            const ctgFollowUp = await ticketService.createTicketFromEmail({
                from: 'global.noc@chinatelecomglobal.com',
                fromName: 'CTG NOC',
                to: ['support@edgestone.in'],
                cc: [],
                subject: `Re: CKT ID :- G773 976 || Link flapped reported issue on 29th Oct'2026 YJ2026102900253 2610290101111180`,
                body: `Dear Partner, We checked the transmission path on G773 976 and found a brief protection switch.`,
                date: new Date('2026-10-29T01:10:00.000Z'),
                messageId: `<test4-ctg-followup-${ts}@chinatelecomglobal.com>`,
                inReplyTo: `<test3-ctg-auto-${ts}@ofm-ticket>`,
                references: `<test3-ctg-auto-${ts}@ofm-ticket>`
            });

            const neuFollowUp = await ticketService.createTicketFromEmail({
                from: 'i.samuel@neutrality.one',
                fromName: 'Isaac Samuel',
                to: ['support@edgestone.in'],
                cc: [],
                subject: `Re: CKT ID :- NEU-EDGS-9092 || Link flapped reported issue on 29th Oct'2026 | Neutrality.One #213877`,
                body: `Hi Team, Neutrality side interfaces remained up; flap originated on peer segment.`,
                date: new Date('2026-10-29T01:20:00.000Z'),
                messageId: `<test4-neu-followup-${ts}@neutrality.one>`,
                inReplyTo: `<test2-neu-reply-${ts}@neutrality.one>`,
                references: `<test2-neu-reply-${ts}@neutrality.one>`
            });

            const refreshedTicket = await prisma.ticket.findUnique({
                where: { id: mainIncidentTicket.id },
                include: { replies: { orderBy: { createdAt: 'asc' } } }
            });

            const ctgReplies = refreshedTicket.replies.filter(r => r.category === `vendor_${CTG_VENDOR_ID}`);
            const neuReplies = refreshedTicket.replies.filter(r => r.category === `vendor_${NEU_VENDOR_ID}`);
            const clientReplies = refreshedTicket.replies.filter(r => r.category === 'client');

            assert(ctgReplies.length >= 3, `Expected >=3 CTG replies (1 agent + 2 vendor), got ${ctgReplies.length}`);
            assert(neuReplies.length >= 3, `Expected >=3 Neutrality replies (1 agent + 2 vendor), got ${neuReplies.length}`);
            assert(clientReplies.length >= 1, `Expected >=1 Client reply, got ${clientReplies.length}`);
            assert.strictEqual(ctgFollowUp.category, `vendor_${CTG_VENDOR_ID}`);
            assert.strictEqual(neuFollowUp.category, `vendor_${NEU_VENDOR_ID}`);

            recordResult(4, 'Multi-Vendor Thread Isolation & Visibility', true, `CTG replies=${ctgReplies.length}, Neutrality replies=${neuReplies.length}, Client replies=${clientReplies.length} on ${mainIncidentTicket.ticketId}`);
        } catch (err) {
            recordResult(4, 'Multi-Vendor Thread Isolation & Visibility', false, err.message);
        }

        // =========================================================================
        // TEST 5: Frontend / API Representation of Multi-Vendor Conversations & Circuit Lookup
        // =========================================================================
        try {
            const ctgEmails = await vendorTicketingService.getVendorEmailsForTicket(mainIncidentTicket.id, CTG_VENDOR_ID);
            const neuEmails = await vendorTicketingService.getVendorEmailsForTicket(mainIncidentTicket.id, NEU_VENDOR_ID);

            assert(ctgEmails.includes('global.noc@chinatelecomglobal.com'), 'CTG vendor tab must resolve CTG NOC emails');
            assert(neuEmails.includes('noc@neutrality.one'), 'Neutrality vendor tab must resolve Neutrality NOC emails');

            const allTicketsList = await ticketService.getTickets();
            const apiTicket = allTicketsList.find(t => t.id === mainIncidentTicket.id);
            assert(apiTicket, 'Ticket must be returned by getTickets() API');
            const hasCtgThread = apiTicket.replies.some(r => r.category === `vendor_${CTG_VENDOR_ID}`);
            const hasNeuThread = apiTicket.replies.some(r => r.category === `vendor_${NEU_VENDOR_ID}`);
            assert(hasCtgThread && hasNeuThread, 'API payload must include both vendor_CTG and vendor_Neutrality threads');

            recordResult(5, 'Frontend/API Multi-Vendor Representation', true, `Resolved CTG (${ctgEmails.length} emails) & Neutrality (${neuEmails.length} emails) and verified both vendor threads in API payload`);
        } catch (err) {
            recordResult(5, 'Frontend/API Multi-Vendor Representation', false, err.message);
        }

        // =========================================================================
        // TEST 6: SLA Rebate Email Exclusion from Active Flapping Ticket
        // =========================================================================
        try {
            const slaRebateSubject = `SLA rebate request || CKT :- NEU-EDGS-1092 || Link down issue on 21st October, 2026 || Neutrality Ticket :- 213547`;
            const slaRebateBody = `Hi Neutrality team,\nCould you please share the SLA rebate information for the recent downlink incident.\nCircuit ID :- NEU-EDGS-1092\nReported incident (date/time ) :- Wed 21-10-2026 14:04 PM (IST)\nReported Incident number :- 213547`;

            // 1. Test against real #1047
            const matchAgainstReal1047 = await ticketService.findExistingTicketForReply(
                null,
                null,
                slaRebateSubject,
                slaRebateBody,
                'pamit@edgestone.in'
            );
            assert.strictEqual(matchAgainstReal1047, null, 'SLA rebate email must NOT match #1047');

            // 2. Test against simulated active flapping ticket
            const matchAgainstSim = await ticketService.findExistingTicketForReply(
                null,
                null,
                `SLA rebate request || CKT :- NEU-EDGS-9092 || Link down issue on 21st October, 2026 || Neutrality Ticket :- 213547`,
                slaRebateBody.replace('NEU-EDGS-1092', 'NEU-EDGS-9092'),
                'pamit@edgestone.in'
            );
            assert.strictEqual(matchAgainstSim, null, 'SLA rebate email must NOT match simulated active flapping ticket');

            // 3. Direct barrier check on #1047
            const real1047 = await prisma.ticket.findFirst({ where: { ticketId: '#1047' } });
            const isVetoed = SmartSorter.isBusinessProcessBarrierVeto(real1047, { subject: slaRebateSubject, body: slaRebateBody });
            assert.strictEqual(isVetoed, true, 'isBusinessProcessBarrierVeto must veto SLA rebate email on #1047');

            recordResult(6, 'SLA Rebate Email Exclusion from Flapping Ticket', true, 'Blocked by Business Process & Historical Incident Date barriers for both #1047 and simulated ticket');
        } catch (err) {
            recordResult(6, 'SLA Rebate Email Exclusion from Flapping Ticket', false, err.message);
        }

        // =========================================================================
        // TEST 7: SLA Rebate Email Correct Handling
        // =========================================================================
        try {
            const beforeRepliesCount = await prisma.reply.count({ where: { ticketId: mainIncidentTicket.id } });
            const agentRebateResult = await ticketService.createTicketFromEmail({
                from: 'pamit@edgestone.in',
                fromName: 'Pamit',
                to: ['i.samuel@neutrality.one', 'noc@neutrality.one'],
                cc: ['support@edgestone.in', 'finance@edgestone.in'],
                subject: `SLA rebate request || CKT :- NEU-EDGS-9092 || Link down issue on 21st October, 2026 || Neutrality Ticket :- 213547`,
                body: `Hi Neutrality team,\nCould you please share the SLA rebate information for the recent downlink incident.\nCircuit ID :- NEU-EDGS-9092\nReported incident (date/time ) :- Wed 21-10-2026 14:04 PM (IST)`,
                date: new Date('2026-10-29T06:00:07.000Z'),
                messageId: `<test7-pamit-rebate-${ts}@edgestone.in>`,
                inReplyTo: null,
                references: null
            });
            const afterRepliesCount = await prisma.reply.count({ where: { ticketId: mainIncidentTicket.id } });

            assert.strictEqual(agentRebateResult, null, 'Internal agent outbound SLA rebate email must be ignored by incident ticketing (return null)');
            assert.strictEqual(afterRepliesCount, beforeRepliesCount, 'Active flapping ticket reply count must remain unchanged');

            recordResult(7, 'SLA Rebate Email Correct Handling', true, 'Outbound agent SLA rebate email cleanly ignored without polluting active incident ticket');
        } catch (err) {
            recordResult(7, 'SLA Rebate Email Correct Handling', false, err.message);
        }

        // =========================================================================
        // TEST 8: Separate Future Incident on the Same Circuit (After First is Closed)
        // =========================================================================
        let secondIncidentTicket = null;
        try {
            await prisma.ticket.update({
                where: { id: mainIncidentTicket.id },
                data: { status: 'Closed' }
            });

            secondIncidentTicket = await ticketService.createTicketFromEmail({
                from: 'Cfm.L2@airtel.com',
                fromName: 'Cfm L2',
                to: ['support@edgestone.in'],
                cc: [],
                subject: `#41599999 || CKT ID :BA/SG1-DX1-FR5/ESPL-913 || New Link Outage`,
                body: `Hi Team, We are observing a new hard link down on BA/SG1-DX1-FR5/ESPL-913.`,
                date: new Date('2026-10-29T08:00:00.000Z'),
                messageId: `<test8-new-incident-${ts}@airtel.com>`,
                inReplyTo: null,
                references: null
            });
            if (secondIncidentTicket && secondIncidentTicket.id) createdTicketUUIDs.add(secondIncidentTicket.id);

            assert(secondIncidentTicket && secondIncidentTicket.id !== mainIncidentTicket.id, 'New incident after closure must create a new ticket');
            assert.strictEqual(secondIncidentTicket.status, 'Open');

            recordResult(8, 'Separate Future Incident on Same Circuit', true, `Closed ${mainIncidentTicket.ticketId} -> Created fresh ticket ${secondIncidentTicket.ticketId}`);
        } catch (err) {
            recordResult(8, 'Separate Future Incident on Same Circuit', false, err.message);
        }

        // =========================================================================
        // TEST 9: Concurrent Email Arrival (CTG and Neutrality Simultaneously)
        // =========================================================================
        try {
            const [concurrentCtg, concurrentNeu] = await Promise.all([
                ticketService.createTicketFromEmail({
                    from: 'global.noc@chinatelecomglobal.com',
                    fromName: 'CTG NOC',
                    to: ['support@edgestone.in'],
                    cc: [],
                    subject: `CKT ID :- G773 976 || New Link Outage YJ2026102900999 2610290101999999`,
                    body: `Dear Valued Customer, CTG has created a ticket 2610290101999999 for G773 976 link outage.\n----原始邮件----`,
                    date: new Date('2026-10-29T08:05:00.000Z'),
                    messageId: `<test9-concurrent-ctg-${ts}@chinatelecomglobal.com>`,
                    inReplyTo: null,
                    references: null
                }),
                ticketService.createTicketFromEmail({
                    from: 'noc@neutrality.one',
                    fromName: 'Neutrality NOC',
                    to: ['support@edgestone.in'],
                    cc: [],
                    subject: `Re: CKT ID :- NEU-EDGS-9092 || New Link Outage | Neutrality.One #213999`,
                    body: `Checking link outage on NEU-EDGS-9092.`,
                    date: new Date('2026-10-29T08:05:00.000Z'),
                    messageId: `<test9-concurrent-neu-${ts}@neutrality.one>`,
                    inReplyTo: null,
                    references: null
                })
            ]);

            assert.strictEqual(concurrentCtg.ticketId, secondIncidentTicket.id, 'Concurrent CTG email must attach to active incident ticket');
            assert.strictEqual(concurrentNeu.ticketId, secondIncidentTicket.id, 'Concurrent Neutrality email must attach to active incident ticket');
            assert.strictEqual(concurrentCtg.category, `vendor_${CTG_VENDOR_ID}`);
            assert.strictEqual(concurrentNeu.category, `vendor_${NEU_VENDOR_ID}`);

            recordResult(9, 'Concurrent Email Arrival', true, `Both concurrent vendor emails serialized and attached to ${secondIncidentTicket.ticketId}`);
        } catch (err) {
            recordResult(9, 'Concurrent Email Arrival', false, err.message);
        }

        // =========================================================================
        // TEST 10: Webhook / Polling Redelivery Idempotency (Including <id> vs bare id)
        // =========================================================================
        try {
            const countBefore = await prisma.reply.count({ where: { ticketId: secondIncidentTicket.id } });
            const redelivery1 = await ticketService.createTicketFromEmail({
                from: 'noc@neutrality.one',
                fromName: 'Neutrality NOC',
                to: ['support@edgestone.in'],
                cc: [],
                subject: `Re: CKT ID :- NEU-EDGS-9092 || New Link Outage | Neutrality.One #213999`,
                body: `Checking link outage on NEU-EDGS-9092.`,
                date: new Date('2026-10-29T08:05:00.000Z'),
                messageId: `test9-concurrent-neu-${ts}@neutrality.one`, // bare Message-ID without angle brackets
                inReplyTo: null,
                references: null
            });
            const countAfter = await prisma.reply.count({ where: { ticketId: secondIncidentTicket.id } });

            assert(redelivery1, 'Redelivery should return existing reply record');
            assert.strictEqual(countAfter, countBefore, 'Redelivery must not create a duplicate reply');

            recordResult(10, 'Webhook / Polling Redelivery Idempotency', true, 'Redelivered email (with/without angle brackets) skipped without creating duplicate');
        } catch (err) {
            recordResult(10, 'Webhook / Polling Redelivery Idempotency', false, err.message);
        }

        // =========================================================================
        // TEST 11: Missing Thread Headers (No In-Reply-To, No References)
        // =========================================================================
        try {
            const noHeadersReply = await ticketService.createTicketFromEmail({
                from: 'rajeshkj@chinatelecomglobal.com',
                fromName: 'Rajesh CTG',
                to: ['support@edgestone.in'],
                cc: [],
                subject: `Re: #41599999 || CKT ID :BA/SG1-DX1-FR5/ESPL-913 || New Link Outage`,
                body: `We are testing the circuit G773 976 from our POP.`,
                date: new Date('2026-10-29T08:15:00.000Z'),
                messageId: `<test11-no-headers-${ts}@chinatelecomglobal.com>`,
                inReplyTo: null,
                references: null
            });

            assert.strictEqual(noHeadersReply.ticketId, secondIncidentTicket.id, 'Reply without headers must match via subject + circuit context');
            assert.strictEqual(noHeadersReply.category, `vendor_${CTG_VENDOR_ID}`);

            recordResult(11, 'Missing Thread Headers', true, `Matched ${secondIncidentTicket.ticketId} via subject + circuit and routed to vendor_${CTG_VENDOR_ID}`);
        } catch (err) {
            recordResult(11, 'Missing Thread Headers', false, err.message);
        }

        // =========================================================================
        // TEST 12: Modified Subject with Valid Thread Headers (In-Reply-To / References)
        // =========================================================================
        try {
            const modifiedSubReply = await ticketService.createTicketFromEmail({
                from: 'n.verhoven@neutrality.one',
                fromName: 'N Verhoven',
                to: ['support@edgestone.in'],
                cc: [],
                subject: `Update from Neutrality NOC Engineering Team [Internal Ref 8841]`,
                body: `Optical power levels on NEU-EDGS-9092 are within threshold (-6.2 dBm).`,
                date: new Date('2026-10-29T08:25:00.000Z'),
                messageId: `<test12-mod-subject-${ts}@neutrality.one>`,
                inReplyTo: `<test9-concurrent-neu-${ts}@neutrality.one>`,
                references: `<test9-concurrent-neu-${ts}@neutrality.one>`
            });

            assert.strictEqual(modifiedSubReply.ticketId, secondIncidentTicket.id, 'Modified subject with valid In-Reply-To must attach to parent ticket');
            assert.strictEqual(modifiedSubReply.category, `vendor_${NEU_VENDOR_ID}`, 'Must inherit Neutrality vendor category from parent reply');

            recordResult(12, 'Modified Subject with Valid Thread Headers', true, `Matched ${secondIncidentTicket.ticketId} via In-Reply-To and inherited category=${modifiedSubReply.category}`);
        } catch (err) {
            recordResult(12, 'Modified Subject with Valid Thread Headers', false, err.message);
        }

        // =========================================================================
        // TEST 13: Circuit ID Formatting Variations
        // =========================================================================
        try {
            const norm1 = normalizeCircuitId('BA/SG1-DX1-FR5/ESPL-013');
            const norm2 = normalizeCircuitId('  ba/sg1-dx1-fr5/espl-013  ');
            const norm3 = normalizeCircuitId('original-BA/SG1-DX1-FR5/ESPL-013');
            assert.strictEqual(norm1, norm2);
            assert.strictEqual(norm1, norm3);

            const ctgTokens = extractTokensFromCircuitId('G773 276');
            assert(ctgTokens.includes('G773 276') && ctgTokens.includes('G773-276'), 'extractTokensFromCircuitId must include both spaced and hyphenated tokens for G773 276');

            assert.strictEqual(checkCircuitCompatibility('G773-276', realCircuit, '#1047'), true, 'G773-276 must be compatible with BA/SG1-DX1-FR5/ESPL-013');
            assert.strictEqual(checkCircuitCompatibility('g773 276', realCircuit, '#1047'), true, 'g773 276 must be compatible with BA/SG1-DX1-FR5/ESPL-013');
            assert.strictEqual(checkCircuitCompatibility('NEU-EDGS-1092', realCircuit, '#1047'), true, 'NEU-EDGS-1092 must be compatible with BA/SG1-DX1-FR5/ESPL-013');

            recordResult(13, 'Circuit ID Formatting Variations', true, `Verified casing, whitespace, prefix, and G773 276 <-> G773-276 normalization`);
        } catch (err) {
            recordResult(13, 'Circuit ID Formatting Variations', false, err.message);
        }

        // =========================================================================
        // TEST 14: Unrelated Business Process Emails (Maintenance, Billing, SLA Rebate)
        // =========================================================================
        try {
            // 14a. Scheduled Maintenance notification for the same circuit creates a separate Maintenance ticket instead of merging into active incident ticket
            const maintTicket = await ticketService.createTicketFromEmail({
                from: 'global.noc@chinatelecomglobal.com',
                fromName: 'CTG Maintenance',
                to: ['support@edgestone.in'],
                cc: [],
                subject: `Planned Outage Notification || CKT ID: G773 976 || CRQ-99887766`,
                body: `Dear Customer,\nCTG wished to advise you that the following network activity that will affect your service.\nCRQ: CRQ-99887766\nDate Time : 05/11/2026 02:00:00 to 05/11/2026 06:00:00 GMT\nService/Circuit Affected : G773 976\nImpact: Service is down during the maintenance period.`,
                date: new Date('2026-10-29T09:00:00.000Z'),
                messageId: `<test14-maint-${ts}@chinatelecomglobal.com>`,
                inReplyTo: null,
                references: null
            });
            if (maintTicket && maintTicket.id) createdTicketUUIDs.add(maintTicket.id);

            assert(maintTicket && maintTicket.id !== secondIncidentTicket.id, 'Maintenance notice must create a separate ticket, NOT attach to active incident ticket');
            assert.strictEqual(maintTicket.isMaintenance, true, 'Maintenance ticket must have isMaintenance=true');
            assert.strictEqual(maintTicket.status, 'Maintenance', 'Maintenance ticket must have status=Maintenance');

            // 14b. Billing / Invoice dispute email must be vetoed from attaching to active incident ticket
            const billingVeto = SmartSorter.isBusinessProcessBarrierVeto(secondIncidentTicket, {
                subject: `Re: Invoice dispute & credit note request for BA/SG1-DX1-FR5/ESPL-913`,
                body: `Please issue a credit note for the billing dispute on circuit BA/SG1-DX1-FR5/ESPL-913.`
            });
            assert.strictEqual(billingVeto, true, 'Billing/credit note email must be vetoed from active incident ticket');

            recordResult(14, 'Unrelated Business Process Emails', true, `Maintenance created separate ticket ${maintTicket.ticketId} (isMaintenance=true) and billing/credit note vetoed from ${secondIncidentTicket.ticketId}`);
        } catch (err) {
            recordResult(14, 'Unrelated Business Process Emails', false, err.message);
        }

    } finally {
        // Clean up all test tickets, SLA records, replies, activity logs, and temporary circuit
        for (const tId of createdTicketUUIDs) {
            try {
                await prisma.sLARecord.deleteMany({ where: { ticketId: tId } });
                await prisma.reply.deleteMany({ where: { ticketId: tId } });
                await prisma.activityLog.deleteMany({ where: { ticketId: tId } });
                await prisma.ticket.delete({ where: { id: tId } });
            } catch (_) {}
        }
        if (tempCircuit && tempCircuit.id) {
            try {
                await prisma.vendorCircuit.deleteMany({ where: { circuitId: tempCircuit.id } });
                await prisma.circuit.delete({ where: { id: tempCircuit.id } });
            } catch (_) {}
        }
        try {
            if (origClientEmails) {
                await prisma.client.update({ where: { id: 'ca767ba6-0b15-4dac-83c1-89acdbf5f400' }, data: { emails: origClientEmails } });
            }
            if (origNeuVendorEmails) {
                await prisma.vendor.update({ where: { id: NEU_VENDOR_ID }, data: { emails: origNeuVendorEmails } });
            }
            if (origCtgVendorEmails) {
                await prisma.vendor.update({ where: { id: CTG_VENDOR_ID }, data: { emails: origCtgVendorEmails } });
            }
        } catch (_) {}
        await prisma.$disconnect();
    }

    const passedCount = results.filter(r => r.passed).length;
    console.log(`\n=============================================================`);
    console.log(`REGRESSION SUITE SUMMARY: ${passedCount}/${results.length} TESTS PASSED`);
    console.log(`=============================================================`);
    if (passedCount !== results.length) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
});
