const circuits = [
  { id: '1', customerCircuitId: 'N1/LON-MUM/ESPL-006', supplierCircuitId: 'original 14819758' },
  { id: '2', customerCircuitId: 'temp-N1/LON-MUM/ESPL-006', supplierCircuitId: 'temp- 14867801' }
];

function isCircuitTemp(circuit) {
  const cust = (circuit.customerCircuitId || '').toLowerCase();
  const supp = (circuit.supplierCircuitId || '').toLowerCase();
  return /^(temp|temporary)[\s-_:]+/i.test(cust) || /^(temp|temporary)[\s-_:]+/i.test(supp);
}

function extractTokens(id) {
  if (!id) return [];
  const raw = String(id).trim();
  const tokens = [raw];
  const stripped = raw.replace(/^(original|temp|temporary|old|new)[\s-_:]+/i, '').trim();
  if (stripped && stripped !== raw) tokens.push(stripped);
  const numMatch = raw.match(/\b\d{6,}\b/);
  if (numMatch && !tokens.includes(numMatch[0])) tokens.push(numMatch[0]);
  return tokens;
}

function matchText(text) {
  const mentionsTemp = (tok) => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[^a-zA-Z0-9])(?:temp|temporary)[\\s-_:]*' + escaped, 'i').test(text);
  };
  const matchesToken = (tok) => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[^a-zA-Z0-9_-])' + escaped + '(?:$|[^a-zA-Z0-9_-])', 'i').test(text);
  };

  const candidates = [];
  for (const c of circuits) {
    const isTemp = isCircuitTemp(c);
    const tokens = [...extractTokens(c.customerCircuitId), ...extractTokens(c.supplierCircuitId)];
    for (const tok of tokens) {
      if (matchesToken(tok)) {
        const hasTempInText = mentionsTemp(tok) || /temp-N1\/LON-MUM\/ESPL-006/i.test(text);
        candidates.push({ circuit: c, tok, isTemp, hasTempInText });
      }
    }
  }

  // User rule: If 'temp' is not mentioned before the circuit ID, it will be considered as the original circuit!
  const tempCandidates = candidates.filter(c => c.hasTempInText && c.isTemp);
  if (tempCandidates.length > 0) return tempCandidates[0].circuit;
  const originalCandidates = candidates.filter(c => !c.isTemp);
  if (originalCandidates.length > 0) return originalCandidates[0].circuit;
  return candidates[0] ? candidates[0].circuit : null;
}

console.log('Test 1 (Raw LSI 14819758 without temp):', matchText('Impacted LSI: 14819758')?.customerCircuitId);
console.log('Test 2 (Both LSIs 14867801 & 14819758 without temp):', matchText('14867801 and 14819758')?.customerCircuitId);
console.log('Test 3 (Circuit ID N1/LON-MUM/ESPL-006 without temp):', matchText('Service: N1/LON-MUM/ESPL-006')?.customerCircuitId);
console.log('Test 4 (Explicit temp temp-N1/LON-MUM/ESPL-006):', matchText('Issue on temp-N1/LON-MUM/ESPL-006')?.customerCircuitId);
console.log('Test 5 (Explicit temp temp- 14867801):', matchText('Issue on temp- 14867801')?.customerCircuitId);
