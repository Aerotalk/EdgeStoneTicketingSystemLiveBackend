const fs = require('fs');

function inspectLog(filename) {
  if (!fs.existsSync(filename)) return;
  const content = fs.readFileSync(filename, 'utf8');
  const lines = content.split('\n');
  const matching = lines.filter(l => l.includes('27/10/2026') || l.includes('27 Oct 2026'));
  console.log(`=== ${filename} (Total matches: ${matching.length}) ===`);
  matching.slice(-40).forEach(l => console.log(l));
}

inspectLog('logs/error.log');
inspectLog('logs/info.log');
