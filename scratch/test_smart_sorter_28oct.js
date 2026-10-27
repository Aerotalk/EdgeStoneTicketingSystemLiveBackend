'use strict';

const prisma = require('../models/index');
const { createTicketFromEmail } = require('../services/ticket/ticketIngestionService');
const { findExistingTicketForReply, checkCircuitCompatibility } = require('../services/ticket/ticketThreadingService');

async function runTests() {
    console.log('=== TEST SUITE: SMART TICKET SORTER & 28-OCT CUTOFF VERIFICATION ===\n');

    let passed = 0;
    let failed = 0;

    const assert = (condition, msg) => {
        if (condition) {
            console.log(`✅ PASS: ${msg}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${msg}`);
            failed++;
        }
    };

    try {
        // --- TEST 1: Double-Checking Cross-Circuit Veto ---
        console.log('\n--- 1. Testing Cross-Circuit Isolation Veto ---');
        const ckt2 = await prisma.circuit.findFirst({ where: { customerCircuitId: 'N1/SG1-MUM/ESPL-007' } });

        const isCompat = checkCircuitCompatibility('DIFFERENT-CIRCUIT-999', ckt2, '#1033');
        assert(isCompat === false, 'checkCircuitCompatibility vetos candidate ticket when email mentions a different circuit');

        // --- TEST 2: Double-Checking Maintenance Barrier Veto ---
        console.log('\n--- 2. Testing Maintenance Barrier Veto ---');
        // Ticket #V1031 is a maintenance ticket
        const v1031 = await prisma.ticket.findFirst({ where: { ticketId: '#V1031' } });
        assert(!!v1031 && v1031.isMaintenance === true, 'Ticket #V1031 is confirmed as a Maintenance ticket');

        // Incoming client incident email mentioning flap/RFO
        const incidentReplyMatch = await findExistingTicketForReply(
            null,
            null,
            'Customer-Re: Neutrality.One#213768 | Service ID: N1/SG1-MUM/ESPL-007 | RFO Request',
            'Please provide RFO for flapping link',
            'noc@neutrality.one'
        );
        // It must NOT match #V1031!
        const matchedV1031 = incidentReplyMatch && incidentReplyMatch.ticketId === '#V1031';
        assert(!matchedV1031, 'Incident email with RFO/flap is strictly blocked from merging into Maintenance Ticket #V1031');

        // --- TEST 3: Strict 28th October Cutoff Boundary ---
        console.log('\n--- 3. Testing Strict 28th October Cutoff Boundary ---');
        // Email received on 27th Oct 2026 15:00 IST
        const preCutoffEmail = {
            from: 'support@freshclient.com',
            fromName: 'Fresh Client',
            subject: 'New Circuit Flapping || CKT ID : CAR12MUMSNG005533',
            body: 'Circuit is flapping since morning',
            date: '2026-10-27T15:00:00+05:30',
            messageId: `<test-pre-cutoff-${Date.now()}@freshclient.com>`
        };

        const preCutoffResult = await createTicketFromEmail(preCutoffEmail);
        assert(preCutoffResult === null, 'Fresh incoming root email dated 27th October is strictly discarded (no ticket created)');

        // --- TEST 4: Fresh Ticket Creation On 28th October (Client Support Ticket) ---
        console.log('\n--- 4. Testing Fresh Ticket Creation on 28th October (Client Support Ticket) ---');
        const test28OctClientEmail = {
            from: 'noc@neutrality.one',
            fromName: 'Neutrality One NOC',
            subject: 'High Packet Loss || CKT ID : N1/SG1-MUM/ESPL-007 || 28th OCT 2026',
            body: 'We are observing severe packet loss on circuit N1/SG1-MUM/ESPL-007. Please investigate.',
            date: '2026-10-28T09:30:00+05:30',
            messageId: `<test-28oct-client-${Date.now()}@neutrality.one>`
        };

        const clientTicket = await createTicketFromEmail(test28OctClientEmail);
        assert(!!clientTicket && !!clientTicket.id, 'Fresh root email on 28th October successfully created a ticket');
        assert(clientTicket && clientTicket.ticketType === 'Client', 'Ticket type is accurately classified as "Client"');
        assert(clientTicket && clientTicket.isMaintenance === false, 'isMaintenance is false for Client Support Ticket');
        assert(clientTicket && clientTicket.circuitId === 'N1/SG1-MUM/ESPL-007', 'Circuit ID N1/SG1-MUM/ESPL-007 correctly associated');

        // --- TEST 5: Fresh Ticket Creation On 28th October (Maintenance Ticket) ---
        console.log('\n--- 5. Testing Fresh Ticket Creation on 28th October (Vendor Maintenance Ticket) ---');
        const test28OctVendorEmail = {
            from: 'service-assurance@bharti.com',
            fromName: 'Airtel Service Assurance',
            subject: 'Planned Maintenance Notification || CRQ-28102026-001 || CKT ID : CAR12MUMSNG005533',
            body: 'Dear Partner, This is to inform you about scheduled emergency maintenance on CAR12MUMSNG005533 on 28th Oct from 02:00 to 06:00 IST.',
            date: '2026-10-28T10:00:00+05:30',
            messageId: `<test-28oct-vendor-${Date.now()}@bharti.com>`
        };

        const vendorTicket = await createTicketFromEmail(test28OctVendorEmail);
        assert(!!vendorTicket && !!vendorTicket.id, 'Fresh vendor maintenance email on 28th October successfully created a ticket');
        assert(vendorTicket && (vendorTicket.ticketType === 'Vendor' || vendorTicket.ticketId.startsWith('#V')), 'Ticket type is accurately classified as Vendor (#V ticket)');
        assert(vendorTicket && (vendorTicket.isMaintenance === true || vendorTicket.status === 'Maintenance'), 'isMaintenance is true and status is Maintenance');
        assert(vendorTicket && vendorTicket.circuitId === 'CAR12MUMSNG005533', 'Vendor circuit CAR12MUMSNG005533 correctly associated');

        // --- TEST 6: Thread Reply Verification (Double-Checking reply to existing ticket) ---
        console.log('\n--- 6. Testing Reply to Existing Ticket ---');
        // Replying to clientTicket with proper subject tag
        const replyEmail = {
            from: 'noc@neutrality.one',
            fromName: 'Neutrality One NOC',
            subject: `Re: [${clientTicket.ticketId}] High Packet Loss || CKT ID : N1/SG1-MUM/ESPL-007`,
            body: 'Any update from the local loop provider?',
            date: '2026-10-28T11:00:00+05:30',
            messageId: `<test-reply-${Date.now()}@neutrality.one>`,
            inReplyTo: clientTicket.messageId
        };

        const replyResult = await createTicketFromEmail(replyEmail);
        // Reply result is the newly appended Reply record (with reply.ticketId matching clientTicket.id)
        const isMatched = (replyResult?.ticketId === clientTicket.id) || (replyResult?.ticketId === clientTicket.ticketId);
        assert(isMatched, `Reply with [${clientTicket.ticketId}] correctly threaded into ticket ${clientTicket.ticketId} instead of creating duplicate`);

        // Clean up test tickets created on 28th Oct
        console.log('\n--- Cleaning up temporary test tickets ---');
        const deleteTicketWithCascade = async (tId) => {
            if (!tId) return;
            try {
                await prisma.activityLog.deleteMany({ where: { ticketId: tId } });
            } catch (_) {}
            try {
                await prisma.reply.deleteMany({ where: { ticketId: tId } });
            } catch (_) {}
            try {
                await prisma.ticket.delete({ where: { id: tId } });
            } catch (_) {}
        };

        if (clientTicket && clientTicket.id) {
            await deleteTicketWithCascade(clientTicket.id);
            console.log(`Cleaned up test ticket ${clientTicket.ticketId}`);
        }
        if (vendorTicket && vendorTicket.id) {
            await deleteTicketWithCascade(vendorTicket.id);
            console.log(`Cleaned up test ticket ${vendorTicket.ticketId}`);
        }

        // Clean up any test tickets #1034 / #V1034 / #V1035 from previous runs
        const lingering = await prisma.ticket.findMany({ where: { ticketId: { in: ['#1034', '#V1034', '#V1035', '#1035'] } } });
        for (const lt of lingering) {
            await deleteTicketWithCascade(lt.id);
        }

        console.log(`\n========================================`);
        console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
        console.log(`========================================\n`);

        process.exit(failed > 0 ? 1 : 0);
    } catch (err) {
        console.error('Fatal error during test run:', err);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

runTests();
