import { describe, expect, it } from 'vitest';
import { describeSafety } from './safety.js';
import type { RiskSignal, RiskStatus, TokenRisk } from '../core/types.js';

const sig = (id: string, state: RiskSignal['state'], detail = 'detail'): RiskSignal => ({ id, label: id, state, detail, weight: 0 });
const risk = (status: RiskStatus, signals: RiskSignal[], unavailable: string[] = []): TokenRisk => ({ score: 10, status, signals, unavailable, assessedAt: 1 });

describe('describeSafety', () => {
  it('says plainly when no assessment exists, and does not call the token safe', () => {
    const v = describeSafety(null);
    expect(v.tone).toBe('info');
    expect(v.headline).toMatch(/No safety assessment/);
    expect(v.passed).toBe(0);
    expect(v.needsAcknowledgement).toBe(false);
  });

  it('lists serious findings first, in the engine\'s own words, and asks for an acknowledgement on high risk', () => {
    const v = describeSafety(risk('high', [sig('mint', 'warn', 'Mint authority is set'), sig('freeze', 'bad', 'Freeze authority is set: your tokens can be frozen'), sig('lp', 'ok')]));
    expect(v.concerns.map((c) => c.text)).toEqual(['freeze: Freeze authority is set: your tokens can be frozen', 'mint: Mint authority is set']);
    expect(v.concerns[0]!.severe).toBe(true);
    expect(v.concerns[1]!.severe).toBe(false);
    expect(v.passed).toBe(1);
    expect(v.tone).toBe('bad');
    expect(v.needsAcknowledgement).toBe(true);
  });

  it('a "bad" signal raises the tone even when the overall class is milder, and demands an acknowledgement', () => {
    const v = describeSafety(risk('elevated', [sig('honeypot', 'bad', 'Sells are blocked')]));
    expect(v.tone).toBe('bad');
    expect(v.needsAcknowledgement).toBe(true);
  });

  it('an established token with nothing found is ok and needs no acknowledgement', () => {
    const v = describeSafety(risk('established', [sig('a', 'ok'), sig('b', 'ok')]));
    expect(v).toMatchObject({ tone: 'ok', passed: 2, concerns: [], needsAcknowledgement: false });
  });

  it('never counts an unchecked signal as passed, and names it', () => {
    const v = describeSafety(risk('unknown', [sig('holders', 'unavailable'), sig('mint', 'ok')], ['contract source']));
    expect(v.passed).toBe(1);
    expect(v.unchecked.sort()).toEqual(['contract source', 'holders']);
    expect(v.tone).toBe('info');
  });

  it('a new token is a warning, not a pass', () => {
    expect(describeSafety(risk('new', [sig('a', 'ok')])).tone).toBe('warn');
  });
});
