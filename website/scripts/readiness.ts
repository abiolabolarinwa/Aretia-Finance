/**
 * Prints whether Aretia Swings is ready for a named first group, and for the public.
 *
 *   npm run readiness                      checks https://aretiafinance.org
 *   npm run readiness -- https://my-preview.vercel.app
 *
 * It reads the live /api/swings-status (yes/no and chain ids only) and the attestation file
 * docs/aretia-swings/readiness-attestations.json, where a person records the things only people can do (a real-money
 * test, an audit). A gate nobody has attested is "not done". Nothing is changed and nothing secret is read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, render, type Attestations, type StatusFacts } from '../src/swings/readiness.ts';

const base = (process.argv.slice(2).find((a) => a.startsWith('http')) ?? 'https://aretiafinance.org').replace(/\/$/, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function status(): Promise<StatusFacts> {
  try {
    const res = await fetch(`${base}/api/swings-status`, { headers: { origin: base } });
    if (!res.ok) throw new Error(String(res.status));
    const b = (await res.json()) as { evm?: { chains?: string[] }; canary?: unknown; aggregators?: boolean; protectedSubmit?: boolean };
    return { reachable: true, evmChains: b.evm?.chains ?? [], canaryActive: Array.isArray(b.canary) && b.canary.length > 0, aggregatorsOn: b.aggregators !== false, protectedSubmit: b.protectedSubmit === true };
  } catch {
    return { reachable: false, evmChains: [], canaryActive: false, aggregatorsOn: true, protectedSubmit: false };
  }
}

let attestations: Attestations = {};
try {
  attestations = JSON.parse(readFileSync(join(root, 'docs', 'aretia-swings', 'readiness-attestations.json'), 'utf8')) as Attestations;
} catch {
  console.error('No attestation file found: every manual gate counts as not done.');
}
const result = evaluate(await status(), attestations);
console.log(`Checked ${base}\n`);
console.log(render(result));
process.exitCode = result.canary.ready ? 0 : 1;
