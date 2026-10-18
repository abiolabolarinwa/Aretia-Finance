import { it, expect } from 'vitest';
import { assessSolanaToken } from '../../../../../website/src/swings/tokens/risk';
import { parseMintFacts } from '../../../../../website/src/swings/tokens/enrich';
it('permanent delegate honeypot rated yellow', () => {
  const d = new Uint8Array(166 + 36); d[45] = 1; d[165] = 1; d[166] = 12; d[168] = 32;
  const f = parseMintFacts('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', d)!;
  const r = assessSolanaToken({ ...f, top10Pct: 30, top10Basis: 'wallets', liquidityUsd: 60000, volume24hUsd: 20000, poolCount: 1, ageHours: 100 });
  console.log(r.status, r.score);
  expect(r.status).toBe('unverified');
});
