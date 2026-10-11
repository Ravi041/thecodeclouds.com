// Dependency gate: fails on high or critical npm advisories, except reviewed and unexpired
// entries in audit-exceptions.json. Usage: npm run audit:deps
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { auditResult } from '../lib/audit.js';

let raw;
try {
  raw = execSync('npm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
} catch (error) {
  raw = error.stdout; // npm audit exits non-zero whenever it finds anything
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('Could not read the npm audit report.');
  process.exit(1);
}
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary || JSON.stringify(report.error)}`);
  process.exit(1);
}

const exceptions = JSON.parse(await readFile(new URL('../audit-exceptions.json', import.meta.url), 'utf8'));
const { blocking, accepted, expired, unused } = auditResult(report, exceptions);

for (const advisory of accepted) {
  const exception = exceptions.find(item => item.id === advisory.id && item.package === advisory.package);
  console.log(`ACCEPTED ${advisory.severity} ${advisory.package} ${advisory.id} until ${exception.expiresAt}: ${exception.reason}`);
}
for (const exception of expired) console.log(`EXPIRED  exception ${exception.id} (${exception.package}) on ${exception.expiresAt}; review it again.`);
for (const exception of unused) console.log(`UNUSED   exception ${exception.id} (${exception.package}) no longer matches an advisory; remove it.`);
for (const advisory of blocking) console.error(`BLOCKING ${advisory.severity} ${advisory.package} ${advisory.id} ${advisory.title || ''} ${advisory.url || ''}`);

if (blocking.length) {
  console.error(`${blocking.length} high or critical advisories need a fix or a reviewed exception.`);
  process.exit(1);
}
console.log('No unreviewed high or critical advisories.');
