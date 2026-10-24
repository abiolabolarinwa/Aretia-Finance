// Fails when `npm audit --omit=dev` reports a high or critical advisory that audit-allowlist.json does not accept.
// Usage (in website/): node scripts/audit-gate.mjs
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gateProblems } from './auditGateCore.mjs';

let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 20_000_000 });
} catch (e) {
  // npm audit exits non-zero when it finds anything; the report is still on stdout.
  raw = e.stdout?.toString() ?? '';
}
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('audit-gate: npm audit gave no readable report (network or registry problem). Failing closed.');
  process.exit(2);
}
const allow = JSON.parse(readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8'));
const problems = gateProblems(report, allow);
if (problems.length > 0) {
  console.error('audit-gate: high or critical advisories not accepted:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('audit-gate: every high or critical advisory in production dependencies is on the accepted list.');
