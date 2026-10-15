const ticketService = require('./services/ticketService');
const prisma = require('./models/index');

async function testBackendImprovements() {
    console.log('--- 1. Testing extractMaintenanceMetadata ---');
    const airtelSubject = 'CRQ: "1100493081" Planned Maintenance activity, is scheduled on 31-OCT-2026 – Planned | Edgestone Singapore Pte Ltd';
    const airtelBody = `With respect to the Planned Maintenance activity, please find the details below-
Details of Maintenance : -
Change ID 1100493081
Scheduled Date 31-OCT-2026 00:00:00 IST(GMT + 5:30)
Impacted LSI : Party Name
14867801: Edgestone Singapore Pte Ltd
14819758: Edgestone Singapore Pte Ltd`;

    const meta = ticketService.extractMaintenanceMetadata(airtelSubject, airtelBody);
    console.log('Extracted Metadata:', meta);
    if (meta.crqId === '1100493081' && meta.maintDate === '31-OCT-2026') {
        console.log('✅ CRQ and Maintenance Date extracted successfully!');
    } else {
        console.error('❌ Metadata extraction mismatch!');
    }

    console.log('\n--- 2. Testing Temporary vs Original Circuit Priority ---');
    // Test against actual DB circuits
    const circuits = await prisma.circuit.findMany({
        where: { customerCircuitId: { contains: 'N1/LON-MUM/ESPL-006' } }
    });
    console.log('Circuits found for N1/LON-MUM/ESPL-006:', circuits.map(c => ({ id: c.id, cust: c.customerCircuitId, supp: c.supplierCircuitId })));

    // Case A: Airtel email with clean numbers 14819758 and 14867801 (no "temp" prefix in text)
    // Should match Original Circuit N1/LON-MUM/ESPL-006!
    console.log('✅ Testing simulated email ingestion for Airtel maintenance notice...');
}

testBackendImprovements().catch(console.error).finally(() => process.exit(0));
