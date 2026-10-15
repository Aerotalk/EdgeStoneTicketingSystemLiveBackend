const prisma = require('./models/index');

async function testAirtelMatching() {
    const emailSubject = 'CRQ: "1100493081" Planned Maintenance activity, is scheduled on 31-OCT-2026 – Planned | Edgestone Singapore Pte Ltd';
    const emailBody = `With respect to the Planned Maintenance activity, please find the details below-
Details of Maintenance : -
Change ID 1100493081
Scheduled Date 31-OCT-2026 00:00:00 IST(GMT + 5:30)
Impacted LSI : Party Name
14867801: Edgestone Singapore Pte Ltd
14819758: Edgestone Singapore Pte Ltd`;

    const circuits = await prisma.circuit.findMany();
    console.log('Total circuits in DB:', circuits.length);

    const matchesCircuitCurrent = (text, targetId) => {
        if (!text || !targetId) return false;
        const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?:$|[^a-zA-Z0-9_-])`, 'i');
        return regex.test(text);
    };

    let matched = null;
    for (const c of circuits) {
        if (matchesCircuitCurrent(emailSubject, c.customerCircuitId) || matchesCircuitCurrent(emailBody, c.customerCircuitId)) {
            matched = { type: 'customer', id: c.customerCircuitId, circuit: c };
            break;
        }
        if (matchesCircuitCurrent(emailSubject, c.supplierCircuitId) || matchesCircuitCurrent(emailBody, c.supplierCircuitId)) {
            matched = { type: 'supplier', id: c.supplierCircuitId, circuit: c };
            break;
        }
    }

    console.log('Current matching result:', matched);

    // Let's test smart tokenization / clean identifier extraction:
    const cleanTokens = (id) => {
        if (!id) return [];
        const raw = String(id).trim();
        const tokens = [raw];
        // Strip common prefixes like "original ", "temp- ", "temp "
        const stripped = raw.replace(/^(original|temp|old|new)[\s-_:]+/i, '').trim();
        if (stripped && stripped !== raw) tokens.push(stripped);
        // Also if it has numbers >= 6 digits:
        const numMatch = raw.match(/\b\d{6,}\b/);
        if (numMatch && !tokens.includes(numMatch[0])) tokens.push(numMatch[0]);
        return tokens;
    };

    let smartMatched = null;
    for (const c of circuits) {
        const suppTokens = cleanTokens(c.supplierCircuitId);
        const custTokens = cleanTokens(c.customerCircuitId);
        for (const tok of suppTokens) {
            if (matchesCircuitCurrent(emailSubject, tok) || matchesCircuitCurrent(emailBody, tok)) {
                smartMatched = { type: 'supplier', matchedToken: tok, circuit: c };
                break;
            }
        }
        if (smartMatched) break;
    }

    console.log('Smart matching result:', smartMatched ? {
        circuitId: smartMatched.circuit.customerCircuitId,
        supplierCircuitId: smartMatched.circuit.supplierCircuitId,
        matchedToken: smartMatched.matchedToken
    } : 'Still null');
}

testAirtelMatching().finally(() => process.exit(0));
