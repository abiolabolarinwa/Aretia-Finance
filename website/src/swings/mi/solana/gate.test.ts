import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { SOLANA_SPECS } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { InMemoryMiStore } from '../store.js';
import type { MiPool } from '../types.js';
import { followWatchedPools, type SolDeps } from './engine.js';
import { gateFor, VaultGate } from './gate.js';

const NOW = 1_800_000_000_000;
const spec = SOLANA_SPECS.find((s) => s.id === 'pumpswap-solana')!;
const pool = (n: string): MiPool =>
  ({ key: 'solana:P' + n, chain: 'solana', address: 'PoolAddress' + n, adapterId: spec.id, state: 'active', paused: false, quoteVault: 'Vault' + n, baseVault: 'Base' + n, lastTradeAt: NOW - 60_000, base: 'B', quote: 'Q', baseDecimals: 6, quoteDecimals: 9 }) as MiPool;

const slice = (n: bigint): { data: [string, string] } => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return { data: [b.toString('base64'), 'base64'] };
};

/** A node whose vault balances can be changed between calls; counts every call by method. */
function node(balances: Map<string, bigint | null>) {
  const calls: string[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push(method);
    if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map((a) => (balances.get(a) == null ? null : slice(balances.get(a)!))) };
    if (method === 'getSignaturesForAddress') return [];
    return null;
  }) as unknown as SolDeps['rpc'];
  return { rpc, calls };
}

describe('the vault gate', () => {
  it('lets a pool through the first time, then only when its quote vault balance moves', async () => {
    const balances = new Map<string, bigint | null>([['Vault1', 100n], ['Vault2', 200n]]);
    const { rpc, calls } = node(balances);
    const gate = new VaultGate();
    const pools = [pool('1'), pool('2')];
    const first = await gate.select(rpc, pools, NOW);
    expect(first.map((p) => p.address)).toEqual(['PoolAddress1', 'PoolAddress2']); // never seen
    for (const p of first) gate.settle(p.key, true, NOW);
    expect(await gate.select(rpc, pools, NOW + 1_000)).toEqual([]); // nothing moved
    balances.set('Vault2', 250n); // a swap in pool 2
    expect((await gate.select(rpc, pools, NOW + 2_000)).map((p) => p.address)).toEqual(['PoolAddress2']);
    expect(calls.every((c) => c === 'getMultipleAccounts')).toBe(true);
    expect(calls).toHaveLength(3); // one call per look at both pools, not one per pool
    expect(gate.stats.skipped).toBe(3); // 2 on the second look, 1 on the third
  });

  it('reads a hundred pools in one call and 250 in three', async () => {
    const balances = new Map<string, bigint | null>();
    const pools = Array.from({ length: 250 }, (_, i) => pool(String(i)));
    for (const p of pools) balances.set(p.quoteVault!, 5n);
    const { rpc, calls } = node(balances);
    await new VaultGate().select(rpc, pools, NOW);
    expect(calls).toEqual(['getMultipleAccounts', 'getMultipleAccounts', 'getMultipleAccounts']);
  });

  it('follows a pool again if it was followed with a missing transaction, so nothing is lost', async () => {
    const balances = new Map<string, bigint | null>([['Vault1', 100n]]);
    const { rpc } = node(balances);
    const gate = new VaultGate();
    const [p] = await gate.select(rpc, [pool('1')], NOW);
    gate.settle(p!.key, false, NOW); // a transaction was not available yet
    expect(await gate.select(rpc, [pool('1')], NOW + 1_000)).toHaveLength(1);
  });

  it('follows a pool anyway after the quiet limit, and one whose vault cannot be read', async () => {
    const balances = new Map<string, bigint | null>([['Vault1', 100n], ['Vault2', 100n]]);
    const { rpc } = node(balances);
    const gate = new VaultGate(60_000);
    const pools = [pool('1'), pool('2')];
    for (const p of await gate.select(rpc, pools, NOW)) gate.settle(p.key, true, NOW);
    expect(await gate.select(rpc, pools, NOW + 59_000)).toHaveLength(0);
    expect(await gate.select(rpc, pools, NOW + 61_000)).toHaveLength(2);
    balances.set('Vault1', null); // the account is gone or unreadable
    for (const p of pools) gate.settle(p.key, true, NOW + 61_000);
    expect((await gate.select(rpc, pools, NOW + 62_000)).map((p) => p.address)).toEqual(['PoolAddress1']);
  });

  it('follows everything, as without a gate, when the balance read fails', async () => {
    const rpc = (async () => {
      throw new Error('node down');
    }) as unknown as SolDeps['rpc'];
    const pools = [pool('1'), pool('2')];
    expect(await new VaultGate().select(rpc, pools, NOW)).toEqual(pools);
  });

  it('keeps one gate per name for the life of the process', () => {
    expect(gateFor('a')).toBe(gateFor('a'));
    expect(gateFor('a')).not.toBe(gateFor('b'));
  });
});

describe('the watched pools with the gate', () => {
  it('reads signatures only for the pools whose balance moved', async () => {
    const balances = new Map<string, bigint | null>([['Vault1', 1n], ['Vault2', 1n], ['Vault3', 1n]]);
    const { rpc, calls } = node(balances);
    const gate = new VaultGate();
    const d: SolDeps = { spec, chain: chainConfig('solana', {}), rpc, store: new InMemoryMiStore(), rules: DEFAULT_RULES, now: () => NOW, gate };
    const pools = [pool('1'), pool('2'), pool('3')];
    const first = await followWatchedPools(d, pools, { budgetMs: 10_000, maxPools: 10 });
    expect(first.polled).toBe(3);
    calls.length = 0;
    balances.set('Vault3', 9n);
    const second = await followWatchedPools(d, pools, { budgetMs: 10_000, maxPools: 10 });
    expect(second.polled).toBe(1);
    expect(calls).toEqual(['getMultipleAccounts', 'getSignaturesForAddress']); // one look at all three, one signature read
  });
});
