import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { SOLANA_SPECS } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { InMemoryMiStore } from '../store.js';
import { decodeBase58, encodeBase58 } from './accounts.js';
import { emptyReport } from './engine.js';
import { knownAmong, registerKnownPools } from './known.js';

const NOW = 1_800_000_000_000;
const PUMP = SOLANA_SPECS.find((s) => s.id === 'pumpswap-solana')!;
const WSOL = 'So11111111111111111111111111111111111111112';
const key = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0) + (i === 31 ? n : 0)));
const decode = (s: string): Uint8Array => decodeBase58(s)!;
const b64 = (d: Uint8Array): string => Buffer.from(d).toString('base64');

const pumpPool = (base: string, quote: string, vaultA: string, vaultB: string, size = 301): Uint8Array => {
  const d = new Uint8Array(size);
  d.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  d.set(decode(base), 43);
  d.set(decode(quote), 75);
  d.set(decode(vaultA), 139);
  d.set(decode(vaultB), 171);
  return d;
};
const mint = (decimals: number): Uint8Array => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};
const tokenAccount = (amount: bigint): Uint8Array => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
};

/** A chain with the given pools (pool n: base key(100+n), vaults key(200+n) and key(300+n)) and counts of what is asked. */
function chain(good: number[], extra: Record<string, { owner: string; data: Uint8Array }> = {}) {
  const accounts = new Map<string, { owner: string; data: Uint8Array }>(Object.entries(extra));
  accounts.set(WSOL, { owner: 'Tokenkeg', data: mint(9) });
  for (const n of good) {
    accounts.set(key(n), { owner: PUMP.program, data: pumpPool(key(100 + n), WSOL, key(200 + n), key(300 + n)) });
    accounts.set(key(100 + n), { owner: 'Tokenkeg', data: mint(6) });
    accounts.set(key(200 + n), { owner: 'Tokenkeg', data: tokenAccount(1_000_000_000n) });
    accounts.set(key(300 + n), { owner: 'Tokenkeg', data: tokenAccount(50_000_000_000n) });
  }
  const calls: { method: string; n: number }[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push({ method, n: Array.isArray(params[0]) ? (params[0] as unknown[]).length : 1 });
    if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map((k) => (accounts.has(k) ? { owner: accounts.get(k)!.owner, data: [b64(accounts.get(k)!.data), 'base64'] } : null)) };
    if (method === 'getAccountInfo') {
      const a = accounts.get(params[0] as string);
      return { value: a ? { owner: a.owner, data: [b64(a.data), 'base64'] } : null };
    }
    return null;
  }) as never;
  return { rpc, calls };
}
const deps = (rpc: never, store = new InMemoryMiStore()) => ({ chain: chainConfig('solana', {}), rpc, store, rules: DEFAULT_RULES, now: () => NOW, nativeUsd: async () => 150 });

describe('adding pools that already exist', () => {
  it('registers each pool from the chain, a hundred accounts to a read, with its age left unknown', async () => {
    const { rpc, calls } = chain([1, 2, 3]);
    const store = new InMemoryMiStore();
    const r = await registerKnownPools(deps(rpc, store), [key(1), key(2), key(3)], new Map(), emptyReport('x'));
    expect(r).toEqual({ registered: 3, known: 0, skipped: 0, missing: 0 });
    const pools = [...store.pools.values()];
    expect(pools.map((p) => p.address).sort()).toEqual([key(1), key(2), key(3)].sort());
    expect(pools.every((p) => p.base !== WSOL && p.quote === WSOL && p.adapterId === 'pumpswap-solana')).toBe(true);
    expect(pools.every((p) => !p.createdAt)).toBe(true); // no creation transaction is known: not guessed
    expect(calls.filter((c) => c.method === 'getMultipleAccounts' && c.n === 3)).toHaveLength(1); // the three pool accounts in one read
  });

  it('skips pools already in the index without reading them, and is harmless to run twice', async () => {
    const { rpc, calls } = chain([1, 2]);
    const store = new InMemoryMiStore();
    await registerKnownPools(deps(rpc, store), [key(1)], new Map(), emptyReport('x'));
    calls.length = 0;
    const r = await registerKnownPools(deps(rpc, store), [key(1), key(2)], new Map(), emptyReport('x'));
    expect(r).toMatchObject({ registered: 1, known: 1 });
    expect(calls.find((c) => c.method === 'getMultipleAccounts')!.n).toBe(1); // the first read asked for the unknown pool's account only
    expect(store.pools.size).toBe(2);
    expect(await knownAmong(store, [key(1), key(2), key(9)])).toEqual(new Set([key(1), key(2)]));
  });

  it('trusts nothing the list said: a missing account, another program, the wrong size or a bad address is skipped', async () => {
    const { rpc } = chain([1], {
      [key(40)]: { owner: 'SomeOtherProgram', data: new Uint8Array(301) },
      [key(41)]: { owner: PUMP.program, data: pumpPool(key(141), WSOL, key(241), key(341), 400) }, // not a pool account's size
    });
    const store = new InMemoryMiStore();
    const r = await registerKnownPools(deps(rpc, store), [key(1), key(40), key(41), key(42), 'not-an-address'], new Map(), emptyReport('x'));
    expect(r.registered).toBe(1);
    expect(r.missing).toBe(1); // key(42) does not exist
    expect(r.skipped).toBe(3); // another program, wrong size, bad address
    expect(store.pools.size).toBe(1);
  });
});
