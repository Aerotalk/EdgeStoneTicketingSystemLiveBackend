'use strict';

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { isAutoReplyEnabled } = require('../services/ticket/ticketIngestionService');
const emailSender = require('../services/email/emailSender');
const ticketService = require('../services/ticketService');
const TicketModel = require('../models/ticket');
const prisma = require('../models/index');

async function testAutoReplyEnvEvaluation() {
    console.log('\n--- 1. Testing isAutoReplyEnabled() evaluation ---');
    
    // Explicit false and spaces
    process.env.AUTOREPLY = 'false';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='false' should evaluate to false");

    process.env.AUTOREPLY = ' false';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY=' false' should evaluate to false");

    process.env.AUTOREPLY = 'false ';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='false ' should evaluate to false");

    process.env.AUTOREPLY = ' false ';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY=' false ' should evaluate to false");
    
    process.env.AUTOREPLY = '0';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='0' should evaluate to false");

    process.env.AUTOREPLY = 'off';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='off' should evaluate to false");

    process.env.AUTOREPLY = 'no';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='no' should evaluate to false");

    process.env.AUTOREPLY = 'disabled';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='disabled' should evaluate to false");

    process.env.AUTOREPLY = '"false"';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='\"false\"' should evaluate to false");

    process.env.AUTOREPLY = ' "false" ';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY=' \"false\" ' should evaluate to false");

    process.env.AUTOREPLY = "'false'";
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY=\"'false'\" should evaluate to false");

    process.env.AUTOREPLY = " 'false' ";
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY=\" 'false' \" should evaluate to false");

    process.env.AUTOREPLY = 'False';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='False' should evaluate to false");

    process.env.AUTOREPLY = 'FALSE';
    assert.strictEqual(isAutoReplyEnabled(), false, "AUTOREPLY='FALSE' should evaluate to false");

    // Explicit true
    process.env.AUTOREPLY = 'true';
    assert.strictEqual(isAutoReplyEnabled(), true, "AUTOREPLY='true' should evaluate to true");

    process.env.AUTOREPLY = ' true ';
    assert.strictEqual(isAutoReplyEnabled(), true, "AUTOREPLY=' true ' should evaluate to true");

    process.env.AUTOREPLY = '1';
    assert.strictEqual(isAutoReplyEnabled(), true, "AUTOREPLY='1' should evaluate to true");

    // Unset fallback
    delete process.env.AUTOREPLY;
    delete process.env.AUTO_REPLY;
    delete process.env.ENABLE_AUTO_REPLY;
    delete process.env.AUTO_REPLY_ENABLED;
    assert.strictEqual(isAutoReplyEnabled(), true, "Unset AUTOREPLY should default to true");

    console.log('✅ isAutoReplyEnabled() behaves correctly for all values (including spaces and quotes)');
}

async function testEmailSenderAutoReplyGuard() {
    console.log('\n--- 1b. Testing emailSender.sendAutoReplyEmail built-in guard ---');
    
    // When AUTOREPLY='false'
    process.env.AUTOREPLY = 'false';
    const resultDisabled = await emailSender.sendAutoReplyEmail({
        to: ['client@example.com'],
        subject: 'Auto-Reply Test',
        text: 'Hello'
    });
    assert.strictEqual(resultDisabled.skipped, true, 'sendAutoReplyEmail must return skipped: true when AUTOREPLY=false');
    console.log('✅ emailSender.sendAutoReplyEmail natively blocks transmission when AUTOREPLY=false');

    // When AUTOREPLY=' false' (with leading space)
    process.env.AUTOREPLY = ' false';
    const resultDisabledSpace = await emailSender.sendAutoReplyEmail({
        to: ['client@example.com'],
        subject: 'Auto-Reply Test Space',
        text: 'Hello'
    });
    assert.strictEqual(resultDisabledSpace.skipped, true, 'sendAutoReplyEmail must return skipped: true when AUTOREPLY= false');
    console.log('✅ emailSender.sendAutoReplyEmail natively blocks transmission when AUTOREPLY= false (leading space)');
}

async function testManualAutoReplyGuard() {
    console.log('\n--- 1c. Testing sendManualAutoReply guard ---');
    
    process.env.AUTOREPLY = 'false';
    let threw = false;
    try {
        await ticketService.sendManualAutoReply('fake-id', ['client@example.com']);
    } catch (err) {
        threw = true;
        assert(err.message.includes('AUTOREPLY=false'), 'Error message mentions AUTOREPLY=false');
    }
    assert.strictEqual(threw, true, 'sendManualAutoReply must reject when AUTOREPLY=false');
    console.log('✅ sendManualAutoReply correctly rejected when AUTOREPLY=false');
}

async function testTicketGenerationAutoReplySuppression() {
    console.log('\n--- 2. Testing Ticket Ingestion Auto-Reply Suppression vs Enabled ---');

    let sentAutoReplies = [];
    const origSendAutoReplyEmail = emailSender.sendAutoReplyEmail;
    const origSendEmail = emailSender.sendEmail;

    emailSender.sendAutoReplyEmail = async (opts) => {
        sentAutoReplies.push(opts);
        return { messageId: '<test-auto-reply@edgestone.in>' };
    };
    emailSender.sendEmail = async (opts) => {
        sentAutoReplies.push(opts);
        return { messageId: '<test-auto-reply@edgestone.in>' };
    };

    // Mock prisma queries and TicketModel.createTicket so test runs standalone
    const origFindFirst = prisma.ticket.findFirst;
    const origFindManyCircuit = prisma.circuit.findMany;
    const origCreateTicket = TicketModel.createTicket;
    const ClientModel = require('../models/client');
    const VendorModel = require('../models/vendor');
    const origFindAllClients = ClientModel.findAllClients;
    const origFindAllVendors = VendorModel.findAllVendors;

    ClientModel.findAllClients = async () => [
        {
            id: 'client-uuid-1',
            companyName: 'Tata Communications',
            domain: 'tatacommunications.com',
            emails: ['noc@tatacommunications.com']
        }
    ];
    VendorModel.findAllVendors = async () => [];

    prisma.ticket.findFirst = async () => null; // No duplicate
    prisma.circuit.findMany = async () => [
        {
            id: 'ckt-uuid-test',
            circuitId: 'EDG-TEST-001',
            customerCircuitId: 'CUST-CKT-001',
            clientId: 'client-uuid-1',
            vendorId: null,
            client: { id: 'client-uuid-1', companyName: 'Tata Communications', domain: 'tatacommunications.com' }
        }
    ];

    let ticketCounter = 1000;
    TicketModel.createTicket = async (data) => {
        ticketCounter++;
        return {
            id: `ticket-uuid-${ticketCounter}`,
            ticketId: `#${ticketCounter}`,
            header: data.header,
            receivedTime: data.receivedTime,
            ticketType: data.ticketType,
            status: data.status,
            messageId: data.messageId,
            circuitId: data.circuitId,
            clientId: data.clientId,
            replies: []
        };
    };

    try {
        // Test case A: AUTOREPLY='false' -> Suppressed on ticket generation
        process.env.AUTOREPLY = 'false';
        sentAutoReplies = [];

        const mockEmail = {
            messageId: `<test-client-${Date.now()}@tatacommunications.com>`,
            from: 'noc@tatacommunications.com',
            fromName: 'Tata NOC',
            to: ['support@edgestone.in'],
            subject: `Issue on circuit CUST-CKT-001`,
            body: 'Please investigate packet loss on circuit CUST-CKT-001',
            date: new Date().toISOString()
        };

        const ticket = await ticketService.createTicketFromEmail(mockEmail);
        console.log(`Created ticket: ${ticket.ticketId}`);
        assert.strictEqual(sentAutoReplies.length, 0, `Auto-reply must NOT be sent when AUTOREPLY=false (count: ${sentAutoReplies.length})`);
        console.log('✅ Auto-reply correctly SUPPRESSED when AUTOREPLY=false');

        // Test case B: AUTOREPLY='true' -> Sent on ticket generation
        process.env.AUTOREPLY = 'true';
        sentAutoReplies = [];

        const mockEmail2 = {
            messageId: `<test-client-2-${Date.now()}@tatacommunications.com>`,
            from: 'noc@tatacommunications.com',
            fromName: 'Tata NOC',
            to: ['support@edgestone.in'],
            subject: `Issue 2 on circuit CUST-CKT-001`,
            body: 'Second issue report',
            date: new Date().toISOString()
        };

        const ticket2 = await ticketService.createTicketFromEmail(mockEmail2);
        console.log(`Created ticket 2: ${ticket2.ticketId}`);
        assert.strictEqual(sentAutoReplies.length, 1, `Auto-reply MUST be sent when AUTOREPLY=true (count: ${sentAutoReplies.length})`);
        assert.strictEqual(sentAutoReplies[0].to[0], 'noc@tatacommunications.com', 'Auto-reply recipient must be sender');
        console.log('✅ Auto-reply correctly SENT when AUTOREPLY=true');
    } finally {
        emailSender.sendAutoReplyEmail = origSendAutoReplyEmail;
        emailSender.sendEmail = origSendEmail;
        prisma.ticket.findFirst = origFindFirst;
        prisma.circuit.findMany = origFindManyCircuit;
        TicketModel.createTicket = origCreateTicket;
    }
}

async function testAgentRepliesUninhibited() {
    console.log('\n--- 3. Testing that Agent Replies are NEVER affected by AUTOREPLY=false ---');

    process.env.AUTOREPLY = 'false'; // Auto-reply is explicitly OFF

    let agentRepliesSent = [];
    const origSendAgentReplyEmail = emailSender.sendAgentReplyEmail;
    emailSender.sendAgentReplyEmail = async (opts) => {
        agentRepliesSent.push(opts);
        return { messageId: '<test-agent-reply@edgestone.in>' };
    };

    const origFindUnique = prisma.ticket.findUnique;
    const origReplyCreate = prisma.reply.create;
    const origActivityLogCreate = prisma.activityLog.create;

    prisma.ticket.findUnique = async () => ({
        id: 'ticket-uuid-test',
        ticketId: '#1050',
        header: 'Test Issue',
        email: 'client@tatacommunications.com',
        client: { email: 'client@tatacommunications.com' }
    });
    prisma.reply.create = async (args) => args.data;
    prisma.activityLog.create = async (args) => args.data;

    try {
        const replyResult = await ticketService.replyToTicket(
            'ticket-uuid-test',
            'Hello, our engineer has reviewed the circuit and restored service.',
            'Agent John',
            'support@edgestone.in',
            null, // attachments
            ['client@tatacommunications.com'],
            [],
            [],
            '<p>Hello, our engineer has reviewed the circuit and restored service.</p>',
            `Update on Ticket [#1050]`
        );

        assert.strictEqual(agentRepliesSent.length, 1, `Agent reply MUST still be sent even if AUTOREPLY=false (count: ${agentRepliesSent.length})`);
        console.log('✅ Agent reply sent successfully even when AUTOREPLY=false');
    } finally {
        emailSender.sendAgentReplyEmail = origSendAgentReplyEmail;
        prisma.ticket.findUnique = origFindUnique;
        prisma.reply.create = origReplyCreate;
        prisma.activityLog.create = origActivityLogCreate;
        process.env.AUTOREPLY = 'true'; // Restore to true
    }
}

async function run() {
    try {
        await testAutoReplyEnvEvaluation();
        await testEmailSenderAutoReplyGuard();
        await testManualAutoReplyGuard();
        await testTicketGenerationAutoReplySuppression();
        await testAgentRepliesUninhibited();
        console.log('\n🎉 ALL TESTS PASSED: AUTOREPLY env variable toggle works perfectly across all layers and does not affect agent replies!');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ TEST FAILED:', err);
        process.exit(1);
    }
}

run();
