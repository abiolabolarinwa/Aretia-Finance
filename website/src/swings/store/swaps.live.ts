/**
 * Live proof of Aretia's own swap store: swaps are read from real finalized mainnet transactions, decoded from the
 * pool vaults' balance changes, turned into candles, and compared with an independent source (GeckoTerminal's OHLCV
 * for the same pool). Read-only: nothing is signed or sent, and the store is in memory.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { SolanaSwapIndexer } from '../indexer/solanaSwaps.js';
import type { SolRpc } from '../solana/raydiumCpmm.js';
import { buildCandles, InMemorySwapStore } from './swaps.js';
import { resolveSolanaPool } from './trackPool.js';

const rpc: SolRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined) throw new Error(`rpc ${method}: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }
  throw new Error(`rpc ${method}: rate limited`);
};

type GeckoRow = number[];
async function geckoHourly(pool: string, side: 'base' | 'quote' = 'base'): Promise<Map<number, GeckoRow>> {
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=168&currency=token&token=${side}`);
  const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: GeckoRow[] } } };
  return new Map((body.data?.attributes?.ohlcv_list ?? []).map((r) => [r[0]!, r]));
}

describe('live: Aretia swap store against real pools', () => {
  it('ACT/USDC (Meteora DAMM v2): decoded swaps give the same hourly candles as GeckoTerminal', async () => {
    const pool = '6n8Mvd7xmZs66E5VLGQGvtE31gbKMcTL4S97W4oV6ivX';
    const tracked = await resolveSolanaPool(web3, rpc, pool);
    console.log('tracked', tracked.venue, tracked.baseMint.slice(0, 6), '/', tracked.quoteMint.slice(0, 6), 'decimals', tracked.baseDecimals, tracked.quoteDecimals);
    expect(tracked).toMatchObject({ venue: 'meteora-damm-v2', baseMint: '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG', baseDecimals: 9, quoteDecimals: 6 });
    const store = new InMemorySwapStore();
    const run = await new SolanaSwapIndexer(rpc, store, { pageSize: 100, maxPages: 3 }).poll(tracked);
    console.log('indexed', run);
    expect(run.swaps).toBeGreaterThan(0);
    const swaps = await store.list('solana', pool, 0, 2_000_000_000);
    const ours = buildCandles(swaps, 3600);
    const theirs = await geckoHourly(pool, 'base');
    let compared = 0;
    const diffs: string[] = [];
    for (const c of ours) {
      const g = theirs.get(c.time);
      if (!g) continue;
      compared++;
      // Same pool, same hour: the close should agree to within a fraction of a percent (the pool's price is 0.005 USDC).
      const rel = Math.abs(c.close - g[4]!) / g[4]!;
      diffs.push(`${new Date(c.time * 1000).toISOString().slice(5, 16)} ours ${c.close.toFixed(6)} theirs ${g[4]!.toFixed(6)} (${(rel * 100).toFixed(3)}%)`);
      expect(rel).toBeLessThan(0.01);
    }
    console.log('hourly candles compared', compared, 'of', ours.length, '\n' + diffs.slice(-6).join('\n'));
    expect(compared).toBeGreaterThan(0);
  }, 240_000);

  it('Orca SOL/USDC (a busy pool, a different venue): the same decoder gives the real SOL price', async () => {
    // The deepest Orca SOL/USDC whirlpool, found by derivation rather than trusted from a list.
    const { OrcaWhirlpoolAdapter } = await import('../solana/orcaWhirlpool.js');
    const adapter = new OrcaWhirlpoolAdapter(web3, rpc);
    const pools = await adapter.getPools({ chain: 'solana', address: 'So11111111111111111111111111111111111111112' }, { chain: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    const best = [...pools].sort((a, b) => (BigInt(b.extra!.liquidity!) > BigInt(a.extra!.liquidity!) ? 1 : -1))[0]!;
    const tracked = await resolveSolanaPool(web3, rpc, best.ref.address);
    expect(tracked).toMatchObject({ venue: 'orca-whirlpool', baseDecimals: 9, quoteDecimals: 6 });
    const store = new InMemorySwapStore();
    const run = await new SolanaSwapIndexer(rpc, store, { pageSize: 100, maxPages: 1 }).poll(tracked);
    const swaps = await store.list('solana', best.ref.address, 0, 2_000_000_000);
    console.log('orca swaps decoded', swaps.length, 'of', run.signatures, 'signatures; sides', swaps.filter((s) => s.side === 'buy').length, 'buys', swaps.filter((s) => s.side === 'sell').length, 'sells');
    expect(swaps.length).toBeGreaterThan(10);
    const last = swaps[swaps.length - 1]!;
    const gecko = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${best.ref.address}`)).json() as { data?: { attributes?: { base_token_price_usd?: string } } };
    const reference = Number(gecko.data?.attributes?.base_token_price_usd);
    console.log('last decoded SOL price', last.price, 'GeckoTerminal says', reference);
    expect(Math.abs(last.price - reference) / reference).toBeLessThan(0.01);
  }, 240_000);
});
