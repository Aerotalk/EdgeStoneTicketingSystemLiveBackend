const { matchRuleForAvailability, ruleMatches } = require('../services/slaService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const slaRecordService = require('../services/slaRecordService');

async function testRules() {
    console.log('=== TEST 1: Rule Matching Engine ===');
    const prajwalRules = [
        { id: 'R1', upperLimit: 89.99, upperOperator: '>', lowerLimit: 0, lowerOperator: '>=', compensationPercentage: 20 },
        { id: 'R2', upperLimit: 97.99, upperOperator: '>', lowerLimit: 90, lowerOperator: '>=', compensationPercentage: 20 },
        { id: 'R3', upperLimit: 99.99, upperOperator: '>', lowerLimit: 98, lowerOperator: '>=', compensationPercentage: 10 },
        { id: 'R4', upperLimit: 100, upperOperator: '>', lowerLimit: 99.99, lowerOperator: '>=', compensationPercentage: 0 }
    ];

    const testUptimes = [100, 99.995, 98.5, 95, 89.995, 79, 75, 10, 0];
    for (const av of testUptimes) {
        const matched = matchRuleForAvailability(prajwalRules, av);
        console.log(`Uptime: ${av}% -> Matched: ${matched?.id} (${matched?.lowerLimit}% - ${matched?.upperLimit}%), Compensation: ${matched?.compensationPercentage}%`);
    }

    console.log('\n=== TEST 2: PrajwalRules without lowerLimit = 0 on lowest tier ===');
    const customRules = [
        { id: 'R1_open', upperLimit: 89.99, upperOperator: '>', lowerLimit: 80, lowerOperator: '>=', compensationPercentage: 20 },
        { id: 'R2', upperLimit: 97.99, upperOperator: '>', lowerLimit: 90, lowerOperator: '>=', compensationPercentage: 20 },
        { id: 'R3', upperLimit: 99.99, upperOperator: '>', lowerLimit: 98, lowerOperator: '>=', compensationPercentage: 10 },
        { id: 'R4', upperLimit: 100, upperOperator: '>', lowerLimit: 99.99, lowerOperator: '>=', compensationPercentage: 0 }
    ];
    for (const av of [79, 75, 10, 0]) {
        const matched = matchRuleForAvailability(customRules, av);
        console.log(`Uptime: ${av}% -> Matched: ${matched?.id} (Lowest Upper: ${matched?.upperLimit}%), Compensation: ${matched?.compensationPercentage}%`);
    }

    console.log('\n=== TEST 3: Recalculate SLA for ticket on PrajwalVendor circuit (VENDOR) ===');
    const rec = await prisma.sLARecord.findFirst({
        where: { ticket: { circuitId: 'P1/LON/2025' }, type: 'VENDOR' },
        include: { ticket: true }
    });
    if (rec) {
        console.log(`Found VENDOR record for ticket ${rec.ticket?.ticketId} (status: ${rec.ticket?.status}):`);
        console.log(`Before: compensation="${rec.compensation}", status="${rec.status}", reason="${rec.statusReason}"`);
        
        // Simulate updateSLAClosure
        await slaRecordService.updateSLAClosure(rec.id, rec.closeDate || '2 Oct 2026', rec.closedTime || '09:05 hrs');
        const after = await prisma.sLARecord.findUnique({ where: { id: rec.id } });
        console.log(`After: compensation="${after.compensation}", status="${after.status}", reason="${after.statusReason}"`);
    }

    await prisma.$disconnect();
}

testRules().catch(err => {
    console.error('Error during test:', err);
    process.exit(1);
});
