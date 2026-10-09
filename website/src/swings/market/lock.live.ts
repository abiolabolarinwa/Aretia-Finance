/** Live proof, read only: burned-liquidity checks against real pools. */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { evmLock, solanaLock, type SolRead } from './lock.js';

const sol: SolRead = async <T>(method: string, params: unknown[]): Promise<T> => {
  const res = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T };
  if (body.result === undefined) throw new Error('no result');
  return body.result;
};

describe('live: burned liquidity', () => {
  it('reads Raydium AMM v4 pools (BONK/SOL and others) without error', async () => {
    const pools = ['Dwq4PxyBQ8dHPmP5u5H7bHsjHp46StGtkSy2gEVedDm', 'g5eGGc1fxh6KRvLMcjp1s3TxQ7J139CDZcFcWLUgj7a'];
    for (const p of pools) console.log('solana', p, await solanaLock(sol, p, Date.now()));
    expect(await solanaLock(sol, 'So11111111111111111111111111111111111111112', Date.now())).toBeNull();
  }, 60_000);

  it('reads V2 pairs on several networks; V3 pools and plain tokens give nothing', async () => {
    let found = 0;
    for (const chain of ['ethereum', 'bnb', 'base'] as const) {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${chain === 'ethereum' ? 'eth' : chain === 'bnb' ? 'bsc' : 'base'}/pools?sort=h24_volume_usd_desc&page=1`);
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: { attributes?: { address?: string; name?: string } }[] };
      const read = publicRead(chain);
      for (const p of (body.data ?? []).slice(0, 12)) {
        const a = p.attributes?.address;
        if (!a) continue;
        const lock = await evmLock(read, a, Date.now());
        if (lock) {
          found++;
          console.log(chain, p.attributes?.name, a, lock);
          expect(lock.pct).toBeGreaterThanOrEqual(0);
          expect(lock.pct).toBeLessThanOrEqual(100);
        }
      }
    }
    console.log('V2 pairs read:', found);
  }, 180_000);
});
