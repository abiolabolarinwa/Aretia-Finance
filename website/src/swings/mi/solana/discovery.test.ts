import { beforeEach, describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { solanaSpecById } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { RpcError, type Read } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { decodeBase58, encodeBase58 } from './accounts.js';
import { discoverVenue, discoveryAdapters, resetDiscoveryMemory, slicesFor, VENUE_LAYOUTS, type DiscoveryDeps } from './discovery.js';
import { refreshSolanaReserves } from './refresher.js';
import { refreshSupplies } from '../supply.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const cpmm = solanaSpecById('raydium-cpmm-solana')!;
const orca = solanaSpecById('orca-whirlpool-solana')!;
const NOW = 1_800_000_000_000;

/** A deterministic, valid-looking 32-byte address. */
const addr = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : i === 0 ? 7 : 0)));
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const putKey = (buf: Uint8Array, at: number, a: string): void => buf.set(decodeBase58(a)!, at);
const putU64 = (buf: Uint8Array, at: number, v: bigint): void => new DataView(buf.buffer).setBigUint64(at, v, true);

function mintAccount(decimals: number): Uint8Array {
  const m = new Uint8Array(82);
  m[44] = decimals;
  m[45] = 1;
  return m;
}
function tokenAccount(amount: bigint): Uint8Array {
  const t = new Uint8Array(165);
  putU64(t, 64, amount);
  return t;
}
/** A Raydium CPMM pool account: vaults at 72 and 104, mints at 168 and 200, 637 bytes. */
function cpmmPool(mintA: string, mintB: string, vaultA: string, vaultB: string): Uint8Array {
  const p = new Uint8Array(637);
  putKey(p, 72, vaultA);
  putKey(p, 104, vaultB);
  putKey(p, 168, mintA);
  putKey(p, 200, mintB);
  return p;
}

interface Acc {
  owner: string;
  data: Uint8Array;
}

/** A tiny Solana node: getProgramAccounts (size and memcmp filters, pubkeys only), getMultipleAccounts and getAccountInfo. */
function node(accs: Map<string, Acc>, opts: { refuseProgramAccounts?: string } = {}) {
  const calls: string[] = [];
  const read: Read = async (method, params) => {
    calls.push(method);
    if (method === 'getProgramAccounts') {
      if (opts.refuseProgramAccounts) throw new RpcError(opts.refuseProgramAccounts, 'node-error');
      const [program, cfg] = params as [string, { filters?: { dataSize?: number; memcmp?: { offset: number; bytes: string } }[]; dataSlice?: { length: number } }];
      expect(cfg.dataSlice?.length).toBe(0); // only pubkeys are asked for
      const out: { pubkey: string; account: { data: [string, string] } }[] = [];
      for (const [pubkey, a] of accs) {
        if (a.owner !== program) continue;
        const ok = (cfg.filters ?? []).every((f) => {
          if (f.dataSize !== undefined) return a.data.length === f.dataSize;
          if (f.memcmp) {
            const want = decodeBase58(f.memcmp.bytes)!;
            return want.every((x, i) => a.data[f.memcmp!.offset + i] === x);
          }
          return true;
        });
        if (ok) out.push({ pubkey, account: { data: ['', 'base64'] } });
      }
      return out;
    }
    if (method === 'getMultipleAccounts') {
      const list = params[0] as string[];
      expect(list.length).toBeLessThanOrEqual(100);
      return { value: list.map((a) => (accs.has(a) ? { data: [b64(accs.get(a)!.data), 'base64'] } : null)) };
    }
    throw new RpcError(`unexpected ${method}`, 'node-error');
  };
  return { read, calls };
}

/** A world of Raydium CPMM pools: [name, quote mint, base amount, quote amount]. */
function world(pools: [number, string, bigint, bigint][]) {
  const accs = new Map<string, Acc>();
  accs.set(WSOL, { owner: 'tok', data: mintAccount(9) });
  accs.set(USDC, { owner: 'tok', data: mintAccount(6) });
  for (const [n, quote, base, quoteAmt] of pools) {
    const token = addr(100 + n);
    const [pool, vb, vq] = [addr(10 + n), addr(50 + n), addr(150 + n)];
    accs.set(token, { owner: 'tok', data: mintAccount(6) });
    // the quote is the second mint for even numbers and the first for odd ones, so both orders are met
    const quoteFirst = n % 2 === 1;
    accs.set(pool, { owner: cpmm.program, data: quoteFirst ? cpmmPool(quote, token, vq, vb) : cpmmPool(token, quote, vb, vq) });
    accs.set(vb, { owner: 'tok', data: tokenAccount(base) });
    accs.set(vq, { owner: 'tok', data: tokenAccount(quoteAmt) });
  }
  return accs;
}

const deps = (read: Read, store: InMemoryMiStore, over: Partial<DiscoveryDeps> = {}): DiscoveryDeps => ({ chain: chainConfig('solana'), rpc: read, store, rules: DEFAULT_RULES, now: () => NOW, nativeUsd: async () => 150, ...over });

beforeEach(() => resetDiscoveryMemory());

describe('Solana pool discovery', () => {
  it('lists the venue by size and quote mint, and registers only pools holding real liquidity, from either mint order', async () => {
    const accs = world([
      [1, WSOL, 5_000_000_000n, 50_000_000_000n], // 50 SOL x 2 x $150 = $15,000
      [2, USDC, 9_000_000n, 40_000_000n], // $80
      [3, WSOL, 1_000n, 100_000_000n], // 0.1 SOL: $30, dust
      [4, USDC, 1_000_000n, 20_000_000_000n], // $40,000
    ]);
    const { read, calls } = node(accs);
    const store = new InMemoryMiStore();
    const r = await discoverVenue(deps(read, store), cpmm.id, 60_000);
    expect(r).toMatchObject({ ok: true, complete: true, registered: 2, refused: null });
    expect(r.belowFloor).toBe(2);
    expect(r.unparsed).toBe(0);
    expect([...store.pools.keys()].sort()).toEqual([`solana:${addr(11)}`, `solana:${addr(14)}`].sort());
    const p1 = store.pools.get(`solana:${addr(11)}`)!;
    expect(p1).toMatchObject({ adapterId: cpmm.id, base: addr(101), quote: WSOL, createdAt: 0, createdTx: 'discovered', baseVault: addr(51), quoteVault: addr(151), state: 'active' });
    // quote first in the account: the base is still the other token
    const p4 = store.pools.get(`solana:${addr(14)}`)!;
    expect(p4).toMatchObject({ base: addr(104), quote: USDC, baseVault: addr(54), quoteVault: addr(154) });
    // six listings (3 quote mints x 2 mint positions), each asked for pubkeys only
    expect(calls.filter((c) => c === 'getProgramAccounts')).toHaveLength(6);
  });

  it('keeps a cursor per slice: a restart continues after the last pool processed and does not list again within the period', async () => {
    const accs = world([
      [1, WSOL, 5_000_000_000n, 50_000_000_000n],
      [2, WSOL, 5_000_000_000n, 50_000_000_000n],
      [3, WSOL, 5_000_000_000n, 50_000_000_000n],
    ]);
    const { read, calls } = node(accs);
    const store = new InMemoryMiStore();
    const slice = slicesFor(cpmm.id, [WSOL, USDC]).find((s) => s.id.includes(`:168:${WSOL.slice(0, 6)}`) || s.id.includes(`:200:${WSOL.slice(0, 6)}`))!;
    void slice;
    // pretend a previous run got through the lowest-sorted pool of the slice that holds pool 11 and pool 13 (quote first, offset 168)
    const sorted = [addr(11), addr(13)].sort();
    await store.setCheckpoint({ adapterId: `${cpmm.id}:discover:168:${WSOL.slice(0, 6)}`, block: 1, blockHash: sorted[0]!, updatedAt: NOW });
    const first = await discoverVenue(deps(read, store), cpmm.id, 60_000);
    expect(first.ok).toBe(true);
    expect(store.pools.has(`solana:${sorted[0]!}`)).toBe(false); // behind the cursor: left for the pass that already read it
    expect(store.pools.has(`solana:${sorted[1]!}`)).toBe(true);
    expect(store.pools.has(`solana:${addr(12)}`)).toBe(true); // the other slice holds pool 12
    const listed = calls.filter((c) => c === 'getProgramAccounts').length;
    await discoverVenue(deps(read, store), cpmm.id, 60_000);
    expect(calls.filter((c) => c === 'getProgramAccounts').length).toBe(listed); // every slice is done: no listing until the period is over
    resetDiscoveryMemory();
    const later = await discoverVenue(deps(read, store, { now: () => NOW + 25 * 3_600_000 }), cpmm.id, 60_000);
    expect(later.ok).toBe(true);
    expect(calls.filter((c) => c === 'getProgramAccounts').length).toBeGreaterThan(listed); // a new pass picks up pools created since
  });

  it('stops with the node’s own words when it refuses the listing, and does not ask again for a while', async () => {
    const accs = world([[1, WSOL, 5_000_000_000n, 50_000_000_000n]]);
    const { read, calls } = node(accs, { refuseProgramAccounts: 'Too many accounts requested; this method is unavailable for this key' });
    const store = new InMemoryMiStore();
    const r = await discoverVenue(deps(read, store), cpmm.id, 60_000);
    expect(r.ok).toBe(false);
    expect(r.refused).toContain('Too many accounts');
    expect(r.error).toMatch(/^refused:/);
    expect(store.pools.size).toBe(0);
    expect(calls.filter((c) => c === 'getProgramAccounts')).toHaveLength(1); // the first refusal ends the run
    const again = await discoverVenue(deps(read, store, { now: () => NOW + 3_600_000 }), cpmm.id, 60_000);
    expect(again.ok).toBe(true);
    expect(again.refused).toMatch(/earlier/);
    expect(calls.filter((c) => c === 'getProgramAccounts')).toHaveLength(1);
    const later = await discoverVenue(deps(read, store, { now: () => NOW + 7 * 3_600_000 }), cpmm.id, 60_000);
    expect(later.refused).toContain('Too many accounts'); // asked again after the retry period
  });

  it('skips pools already known, pool accounts with an unexpected layout, and pools quoted in an unknown token', async () => {
    const accs = world([
      [1, WSOL, 5_000_000_000n, 50_000_000_000n],
      [2, WSOL, 5_000_000_000n, 50_000_000_000n],
    ]);
    // a pool whose other token is not a recognised quote: not in any slice, so never even read
    const other = addr(200);
    accs.set(other, { owner: cpmm.program, data: cpmmPool(addr(201), addr(202), addr(203), addr(204)) });
    const { read } = node(accs);
    const store = new InMemoryMiStore();
    await discoverVenue(deps(read, store), cpmm.id, 60_000);
    const before = store.pools.size;
    resetDiscoveryMemory();
    const r = await discoverVenue(deps(read, store, { now: () => NOW + 25 * 3_600_000 }), cpmm.id, 60_000);
    expect(store.pools.size).toBe(before);
    expect(r.registered).toBe(0);
    expect(r.known).toBeGreaterThan(0);
    expect(store.pools.has(`solana:${other}`)).toBe(false);
  });

  it('reads a venue name list from MI_SOLANA_DISCOVERY and builds the right slices', () => {
    expect(discoveryAdapters(undefined)).toEqual([]);
    expect(discoveryAdapters('0')).toEqual([]);
    expect(discoveryAdapters('*').sort()).toEqual(Object.keys(VENUE_LAYOUTS).sort());
    expect(discoveryAdapters('raydium-cpmm-solana, nope,pumpswap-solana')).toEqual(['raydium-cpmm-solana', 'pumpswap-solana']);
    expect(slicesFor(cpmm.id, [WSOL, USDC, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'])).toHaveLength(6);
    expect(slicesFor('meteora-dbc-solana', [WSOL])).toHaveLength(1); // its pool account does not hold the quote mint
    expect(slicesFor('nope', [WSOL])).toEqual([]);
  });
});

describe('Solana reserves refresher', () => {
  it('updates liquidity, shows a reserve price for a plain constant-product pool, and follows a drained pool', async () => {
    const accs = world([[2, WSOL, 5_000_000_000n, 50_000_000_000n]]); // 5,000 tokens (6 dp) against 50 SOL
    const { read } = node(accs);
    const store = new InMemoryMiStore();
    const d = deps(read, store);
    await discoverVenue(d, cpmm.id, 60_000);
    const refresh = { spec: cpmm, ...d, budgetMs: 10_000 };
    const first = await refreshSolanaReserves(refresh);
    expect(first).toMatchObject({ ok: true, considered: 1, read: 1, unreadable: 0 });
    const stats = store.pools.get(`solana:${addr(12)}`)!.stats!;
    expect(stats.reservesOnly).toBe(true);
    expect(stats.liquidityUsd).toBe(15_000);
    expect(stats.price).toBeNull(); // no trade price
    expect(stats.reservePrice).toBe('0.01'); // 50 SOL / 5,000 tokens
    expect(stats.reservePriceUsd).toBeCloseTo(1.5, 10);
    // the pool is drained
    accs.set(addr(152), { owner: 'tok', data: tokenAccount(0n) });
    const second = await refreshSolanaReserves(refresh);
    expect(second.stateChanges).toBe(1);
    expect(store.pools.get(`solana:${addr(12)}`)!.state).toBe('awaiting_liquidity');
  });

  it('shows no reserve price for a venue whose balance ratio is not its price', async () => {
    const accs = world([[2, WSOL, 5_000_000_000n, 50_000_000_000n]]);
    const { read } = node(accs);
    const store = new InMemoryMiStore();
    const d = deps(read, store);
    await discoverVenue(d, cpmm.id, 60_000);
    const pool = store.pools.get(`solana:${addr(12)}`)!;
    // the same pool, seen by the Orca adapter's refresher (a concentrated-liquidity venue)
    store.pools.set(pool.key, { ...pool, adapterId: orca.id });
    await refreshSolanaReserves({ spec: orca, ...d, budgetMs: 10_000 });
    const stats = store.pools.get(pool.key)!.stats!;
    expect(stats.reservesOnly).toBe(true);
    expect(stats.liquidityUsd).toBe(15_000);
    expect(stats.reservePrice).toBeUndefined();
  });
});

describe('Solana token supply', () => {
  it('reads the supply held in each mint account and records an unreadable mint', async () => {
    const accs = new Map<string, Acc>();
    const mint = mintAccount(6);
    putU64(mint, 36, 1_000_000_000_000n);
    accs.set(addr(40), { owner: 'tok', data: mint });
    const { read } = node(accs);
    const store = new InMemoryMiStore();
    for (const a of [addr(40), addr(41)]) await store.upsertToken({ key: `solana:${a}`, chain: 'solana', address: a, symbol: 'X', name: 'X', decimals: 6, firstSeenAt: 1, firstTradeAt: null, launchboxKey: null });
    const r = await refreshSupplies({ chain: chainConfig('solana'), read, store, now: () => NOW, budgetMs: 10_000 });
    expect(r).toMatchObject({ ok: true, considered: 2, read: 1, unreadable: 1 });
    expect(store.tokens.get(`solana:${addr(40)}`)).toMatchObject({ totalSupply: '1000000000000', supplyAt: NOW });
    expect(store.tokens.get(`solana:${addr(41)}`)).toMatchObject({ totalSupply: null, supplyAt: NOW });
  });
});
