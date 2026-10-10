import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, render, type Attestations, type StatusFacts } from './readiness.js';

const good: StatusFacts = { reachable: true, evmChains: ['base'], canaryActive: true, aggregatorsOn: false, protectedSubmit: false };
const file = JSON.parse(readFileSync(join(process.cwd(), 'docs/aretia-swings/readiness-attestations.json'), 'utf8')) as Attestations;
const allDone: Attestations = Object.fromEntries(Object.keys(file).map((k) => [k, { done: true, date: '2026-10-08' }]));

describe('readiness', () => {
  it('is NOT ready by default: the shipped attestation file marks only what has real evidence, and every entry that is done has a date and a note', () => {
    // Done so far (10 October 2026): one real EVM swap, on BNB Chain. Its fee was seen at the old 0.29% rate, so the fee gate stays open until the 0.58% rate is seen on chain.
    expect(Object.entries(file).filter(([, a]) => a?.done).map(([id]) => id).sort()).toEqual(['real-swap-evm']);
    for (const a of Object.values(file)) if (a?.done) expect(a.date && a.note).toBeTruthy();
    const r = evaluate(good, file);
    expect(r.canary.ready).toBe(false);
    expect(r.public.ready).toBe(false);
  });

  it('is ready for a first group only when the live settings are right and the first-use tests are attested', () => {
    const canaryDone: Attestations = { ...file, 'real-swap-solana': { done: true, date: '2026-10-08' }, 'real-swap-evm': { done: true, date: '2026-10-08' }, 'real-cctp-move': { done: true, date: '2026-10-08' }, 'real-cctp-solana': { done: true, date: '2026-10-08' }, 'moonpay-sandbox-buy': { done: true, date: '2026-10-08' }, 'db-migrations': { done: true, date: '2026-10-08' }, 'aretia-fee-evm': { done: true, date: '2026-10-08' }, 'aretia-fee-solana': { done: true, date: '2026-10-08' } };
    const r = evaluate(good, canaryDone);
    expect(r.canary.ready).toBe(true);
    expect(r.public.ready).toBe(false);
    expect(r.public.blockers.map((g) => g.id)).toContain('external-audit');
  });

  it('is ready for the public only when everything is done', () => {
    expect(evaluate(good, allDone).public.ready).toBe(true);
  });

  it('fails the live settings when no rollout list is set or too many networks are on', () => {
    for (const bad of [{ canaryActive: false }, { evmChains: ['ethereum', 'base', 'polygon'] }]) {
      expect(evaluate({ ...good, ...bad }, allDone).canary.ready, JSON.stringify(bad)).toBe(false);
    }
  });

  it('cannot confirm anything when the status endpoint is unreachable', () => {
    const r = evaluate({ ...good, reachable: false }, allDone);
    expect(r.canary.ready).toBe(false);
    expect(r.gates.filter((g) => g.state === 'unknown').length).toBeGreaterThan(0);
  });

  it('does not accept "done" without a valid date', () => {
    const r = evaluate(good, { ...allDone, 'external-audit': { done: true } });
    expect(r.gates.find((g) => g.id === 'external-audit')!.state).toBe('unknown');
    expect(r.public.ready).toBe(false);
  });

  it('prints a plain verdict', () => {
    const text = render(evaluate(good, file));
    expect(text).toMatch(/Ready for a named first group: NO/);
    expect(text).toMatch(/Ready for the public:\s+NO/);
  });
});
