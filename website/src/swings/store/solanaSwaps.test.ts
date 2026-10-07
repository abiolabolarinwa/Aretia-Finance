import { describe, expect, it } from 'vitest';
import * as web3 from '@solana/web3.js';
import { SolanaSwapIndexer } from '../indexer/solanaSwaps.js';
import { InMemorySwapStore, type ParsedTx, type TrackedPool } from './swaps.js';
import { resolveSolanaPool } from './trackPool.js';
import { PUMPSWAP_PROGRAM } from '../solana/pumpswap.js';
import type { SolRpc } from '../solana/raydiumCpmm.js';

const POOL: TrackedPool = { chain: 'solana', pool: 'PoolAddr1111111111111111111111111111111111', venue: 'x', baseMint: 'B', quoteMint: 'Q', baseDecimals: 9, quoteDecimals: 6, baseVault: 'BaseVault', quoteVault: 'QuoteVault' };

const swapTx = (time: number, dBase: bigint, dQuote: bigint): ParsedTx => {
  const bal = (i: number, v: bigint) => ({ accountIndex: i, uiTokenAmount: { amount: v.toString() } });
  return { slot: time, blockTime: time, meta: { err: null, preTokenBalances: [bal(1, 1_000_000_000_000n), bal(2, 1_000_000_000_000n)], postTokenBalances: [bal(1, 1_000_000_000_000n + dBase), bal(2, 1_000_000_000_000n + dQuote)] }, transaction: { message: { accountKeys: [{ pubkey: 'Payer' }, { pubkey: 'BaseVault' }, { pubkey: 'QuoteVault' }] } } };
};

/** A chain with the given transactions, newest first, that serves signature pages like the real RPC. */
function chain(txs: { sig: string; tx: ParsedTx | null; err?: unknown }[]) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === 'getSignaturesForAddress') {
      const o = params[1] as { limit: number; before?: string; until?: string };
      let list = txs;
      if (o.before) list = list.slice(list.findIndex((t) => t.sig === o.before) + 1);
      if (o.until) {
        const i = list.findIndex((t) => t.sig === o.until);
        if (i >= 0) list = list.slice(0, i);
      }
      return list.slice(0, o.limit).map((t) => ({ signature: t.sig, err: t.err ?? null }));
    }
    if (method === 'getTransaction') return txs.find((t) => t.sig === params[0])?.tx ?? null;
    throw new Error('unexpected ' + method);
  }) as SolRpc;
  return { rpc, calls };
}

describe('SolanaSwapIndexer', () => {
  const txs = [
    { sig: 's5', tx: swapTx(500, -1_000_000_000n, 5_000n) },
    { sig: 's4', tx: swapTx(400, 2_000_000_000n, -10_000n) },
    { sig: 's3', tx: swapTx(300, 5n, 5n) }, // liquidity, not a swap
    { sig: 's2', tx: swapTx(200, -1n, 1n), err: { InstructionError: [0, 'x'] } }, // failed
    { sig: 's1', tx: swapTx(100, -3_000_000_000n, 15_000n) },
  ];

  it('stores the swaps, skips liquidity moves and failed transactions, and moves the cursor to the newest signature', async () => {
    const store = new InMemorySwapStore();
    const run = await new SolanaSwapIndexer(chain(txs).rpc, store).poll(POOL);
    expect(run).toMatchObject({ signatures: 5, swaps: 3, stored: 3, truncated: false });
    expect((await store.list('solana', POOL.pool, 0, 1000)).map((s) => [s.id, s.side])).toEqual([['s1', 'buy'], ['s4', 'sell'], ['s5', 'buy']]);
    expect(await store.getCursor('solana', POOL.pool)).toBe('s5');
  });

  it('on the next poll reads only what is newer than the cursor, and is harmless to repeat', async () => {
    const store = new InMemorySwapStore();
    const first = chain(txs);
    await new SolanaSwapIndexer(first.rpc, store).poll(POOL);
    const more = [{ sig: 's6', tx: swapTx(600, -1_000_000_000n, 6_000n) }, ...txs];
    const second = chain(more);
    const run = await new SolanaSwapIndexer(second.rpc, store).poll(POOL);
    expect(run).toMatchObject({ signatures: 1, swaps: 1, stored: 1 });
    expect(second.calls.filter((c) => c.method === 'getTransaction').map((c) => c.params[0])).toEqual(['s6']);
    expect(await store.getCursor('solana', POOL.pool)).toBe('s6');
    const again = await new SolanaSwapIndexer(chain(more).rpc, store).poll(POOL);
    expect(again.signatures).toBe(0);
  });

  it('lists the quote vault of the pool, not the pool account, so price-checking noise is never fetched', async () => {
    const c = chain(txs);
    await new SolanaSwapIndexer(c.rpc, new InMemorySwapStore()).poll(POOL);
    expect(c.calls.filter((x) => x.method === 'getSignaturesForAddress').every((x) => x.params[0] === 'QuoteVault')).toBe(true);
    const c2 = chain(txs);
    await new SolanaSwapIndexer(c2.rpc, new InMemorySwapStore()).poll({ ...POOL, quoteVault: undefined });
    expect(c2.calls.find((x) => x.method === 'getSignaturesForAddress')!.params[0]).toBe(POOL.pool);
  });

  it('reads only finalized data', async () => {
    const c = chain(txs);
    await new SolanaSwapIndexer(c.rpc, new InMemorySwapStore()).poll(POOL);
    expect(c.calls.every((x) => (x.params[1] as { commitment: string }).commitment === 'finalized')).toBe(true);
  });

  it('retries a transaction the node does not have yet, and uses it if it turns up', async () => {
    let misses = 2;
    const base = chain([{ sig: 's1', tx: swapTx(100, -1_000_000_000n, 5_000n) }]);
    const flaky = (async (m: string, p: unknown[]) => (m === 'getTransaction' && misses-- > 0 ? null : base.rpc(m, p))) as SolRpc;
    const run = await new SolanaSwapIndexer(flaky, new InMemorySwapStore(), { retryDelayMs: 0 }).poll(POOL);
    expect(run).toMatchObject({ swaps: 1, unavailable: 0 });
  });

  it('skips a finalized transaction the node never produces, counts it, and still moves on, so one missing transaction cannot stall a pool', async () => {
    const store = new InMemorySwapStore();
    const broken = chain([{ sig: 's2', tx: null }, { sig: 's1', tx: swapTx(100, -1_000_000_000n, 5_000n) }]);
    const run = await new SolanaSwapIndexer(broken.rpc, store, { retryDelayMs: 0, retries: 2 }).poll(POOL);
    expect(run).toMatchObject({ signatures: 2, swaps: 1, stored: 1, unavailable: 1 });
    expect(broken.calls.filter((c) => c.method === 'getTransaction' && c.params[0] === 's2')).toHaveLength(3);
    expect(await store.getCursor('solana', POOL.pool)).toBe('s2');
  });

  it('does not move the cursor, and stores nothing, when a request fails outright', async () => {
    const store = new InMemorySwapStore();
    const base = chain([{ sig: 's1', tx: swapTx(100, -1n, 1n) }]);
    const down = (async (m: string, p: unknown[]) => {
      if (m === 'getTransaction') throw new Error('rate limited');
      return base.rpc(m, p);
    }) as SolRpc;
    await expect(new SolanaSwapIndexer(down, store).poll(POOL)).rejects.toThrow(/rate limited/);
    expect(await store.getCursor('solana', POOL.pool)).toBeNull();
    expect(await store.coverage('solana', POOL.pool)).toBeNull();
  });

  it('pages through a busy pool, and says so when it could not reach the end', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ sig: `m${12 - i}`, tx: swapTx(1_000 + (12 - i), -1_000_000_000n, 5_000n) }));
    const store = new InMemorySwapStore();
    const full = await new SolanaSwapIndexer(chain(many).rpc, store, { pageSize: 5, maxPages: 5 }).poll(POOL);
    expect(full).toMatchObject({ signatures: 12, stored: 12, truncated: false });
    const cut = await new SolanaSwapIndexer(chain(many).rpc, new InMemorySwapStore(), { pageSize: 5, maxPages: 2 }).poll(POOL);
    expect(cut).toMatchObject({ signatures: 10, truncated: true });
  });
});

describe('resolveSolanaPool', () => {
  const key = (): string => web3.Keypair.generate().publicKey.toBase58();
  const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
  const WSOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  function pumpPool(base: string, quote: string) {
    const d = new Uint8Array(301);
    const put = (o: number, k: string) => d.set(new web3.PublicKey(k).toBytes(), o);
    const vb = key();
    const vq = key();
    put(43, base);
    put(75, quote);
    put(139, vb);
    put(171, vq);
    return { data: d, vb, vq };
  }
  const mintAcct = (decimals: number) => {
    const d = new Uint8Array(82);
    d[44] = decimals;
    return { data: [b64(d), 'base64'] };
  };

  function rpcFor(address: string, acct: { data: Uint8Array } | null, owner: string, decimals: Record<string, number>): SolRpc {
    return (async (_m: string, params: unknown[]) => {
      const list = params[0] as string[];
      if (list[0] === address) return { value: [acct ? { data: [b64(acct.data), 'base64'], owner } : null] };
      return { value: list.map((m) => (m in decimals ? mintAcct(decimals[m]!) : null)) };
    }) as SolRpc;
  }

  it('prices a token in the stablecoin, whichever side of the pool it is on, with each side\'s vault and decimals', async () => {
    const act = key();
    for (const [a, b] of [[act, USDC], [USDC, act]] as const) {
      const p = pumpPool(a, b);
      const address = key();
      const t = await resolveSolanaPool(web3, rpcFor(address, p, PUMPSWAP_PROGRAM, { [act]: 9, [USDC]: 6 }), address);
      const actVault = a === act ? p.vb : p.vq;
      const usdcVault = a === act ? p.vq : p.vb;
      expect(t).toMatchObject({ chain: 'solana', pool: address, venue: 'pumpswap', baseMint: act, quoteMint: USDC, baseDecimals: 9, quoteDecimals: 6, baseVault: actVault, quoteVault: usdcVault });
    }
  });

  it('prefers a stablecoin over wrapped SOL as the quote, and wrapped SOL over an unknown token', async () => {
    const x = key();
    const a1 = key();
    const p1 = pumpPool(WSOL, USDC);
    expect(await resolveSolanaPool(web3, rpcFor(a1, p1, PUMPSWAP_PROGRAM, { [WSOL]: 9, [USDC]: 6 }), a1)).toMatchObject({ baseMint: WSOL, quoteMint: USDC });
    const a2 = key();
    const p2 = pumpPool(x, WSOL);
    expect(await resolveSolanaPool(web3, rpcFor(a2, p2, PUMPSWAP_PROGRAM, { [x]: 6, [WSOL]: 9 }), a2)).toMatchObject({ baseMint: x, quoteMint: WSOL });
  });

  it('refuses a missing pool, a venue it cannot follow, and a pool whose token decimals cannot be read', async () => {
    const a = key();
    await expect(resolveSolanaPool(web3, rpcFor(a, null, PUMPSWAP_PROGRAM, {}), a)).rejects.toThrow(/does not exist/);
    await expect(resolveSolanaPool(web3, rpcFor(a, pumpPool(key(), USDC), key(), {}), a)).rejects.toThrow(/venue Aretia can follow/);
    await expect(resolveSolanaPool(web3, rpcFor(a, pumpPool(key(), USDC), PUMPSWAP_PROGRAM, {}), a)).rejects.toThrow(/decimals/);
  });
});
