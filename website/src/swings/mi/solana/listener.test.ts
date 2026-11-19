import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { SOLANA_SPECS } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { InMemoryMiStore } from '../store.js';
import { emptyReport } from './engine.js';
import { decodeBase58, encodeBase58 } from './accounts.js';
import { CREATION_LOG, listenableVenues, registerHeard, startListener, type Heard, type Socket } from './listener.js';

const NOW = 1_800_000_000_000;
const PUMP = SOLANA_SPECS.find((s) => s.id === 'pumpswap-solana')!;
const WSOL = 'So11111111111111111111111111111111111111112';
const key = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0) + (i === 31 ? n : 0)));

class FakeSocket implements Socket {
  sent: string[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
  say(o: unknown): void {
    this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) });
  }
}

function harness(over: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const heard: Heard[] = [];
  const logs: string[] = [];
  let clock = NOW;
  const l = startListener({
    url: 'wss://example.test',
    venues: ['meteora-dlmm-solana', 'orca-whirlpool-solana'],
    onHeard: (h) => heard.push(h),
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
    log: (x) => logs.push(x),
    ...over,
  });
  return { l, sockets, timers, heard, logs, tick: (ms: number) => (clock += ms) };
}

const note = (subscription: number, signature: string, logs: string[], err: unknown = null) => ({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription, result: { value: { signature, err, logs } } } });

describe('the creation log line', () => {
  it('matches pool-making instructions and nothing a swap or a position logs', () => {
    for (const ok of ['Program log: Instruction: InitializeLbPair2', 'Program log: Instruction: InitializeCustomizablePermissionlessLbPair', 'Program log: Instruction: InitializePool', 'Program log: Instruction: InitializePoolV2', 'Program log: Instruction: InitializeVirtualPoolWithSplToken', 'Program log: Instruction: CreatePool']) expect(CREATION_LOG.test(ok), ok).toBe(true);
    for (const no of ['Program log: Instruction: Swap', 'Program log: Instruction: Swap2', 'Program log: Instruction: InitializePosition', 'Program log: Instruction: InitializeBinArray', 'Program log: Instruction: AddLiquidity', 'Program log: Instruction: InitializeTickArray']) expect(CREATION_LOG.test(no), no).toBe(false);
  });
  it('lists the venues it can hear and ignores the rest', () => {
    expect(listenableVenues(undefined)).toEqual([]);
    expect(listenableVenues('0')).toEqual([]);
    expect(listenableVenues('meteora-dlmm-solana, nonsense')).toEqual(['meteora-dlmm-solana']);
    expect(listenableVenues('*')).toContain('meteora-dbc-solana');
  });
});

describe('the websocket listener', () => {
  it('subscribes to each program once connected and reports only successful creations, once each', () => {
    const { l, sockets, heard } = harness();
    const s = sockets[0]!;
    s.onopen?.({});
    expect(s.sent).toHaveLength(2);
    const first = JSON.parse(s.sent[0]!);
    expect(first.method).toBe('logsSubscribe');
    expect(first.params[0].mentions[0]).toBe(SOLANA_SPECS.find((x) => x.id === 'meteora-dlmm-solana')!.program);
    s.say({ jsonrpc: '2.0', result: 77, id: 1 });
    s.say({ jsonrpc: '2.0', result: 88, id: 2 });
    s.say(note(77, 'sigSwap', ['Program log: Instruction: Swap2']));
    s.say(note(77, 'sigFailed', ['Program log: Instruction: InitializeLbPair2'], { InstructionError: [0, 'Custom'] }));
    s.say(note(77, 'sigNew', ['Program log: Instruction: InitializeLbPair2']));
    s.say(note(77, 'sigNew', ['Program log: Instruction: InitializeLbPair2'])); // the same one again
    s.say(note(88, 'sigOrca', ['Program log: Instruction: InitializePoolV2']));
    s.say(note(99, 'sigUnknownSubscription', ['Program log: Instruction: InitializePool']));
    s.say('not json');
    expect(heard).toEqual([{ signature: 'sigNew', adapterId: 'meteora-dlmm-solana' }, { signature: 'sigOrca', adapterId: 'orca-whirlpool-solana' }]);
    expect(l.stats.heard).toBe(2);
    expect(l.stats.connected).toBe(true);
  });

  it('reconnects with a growing wait after the socket drops, and stops when closed', () => {
    const { l, sockets, timers } = harness();
    sockets[0]!.onopen?.({});
    sockets[0]!.onclose?.({});
    expect(timers.map((t) => t.ms)).toEqual([2_000]);
    timers[0]!.fn();
    expect(sockets).toHaveLength(2);
    sockets[1]!.onclose?.({}); // dropped before it ever opened
    expect(timers[1]!.ms).toBe(4_000);
    l.close();
    timers[1]!.fn();
    expect(sockets).toHaveLength(2); // closed: no new socket
  });

  it('closes and rests when a program streams more than the byte limit in a minute', () => {
    const { l, sockets, timers, logs } = harness({ maxBytesPerMinute: 1_000, restMs: 600_000 });
    const s = sockets[0]!;
    s.onopen?.({});
    s.say({ jsonrpc: '2.0', result: 77, id: 1 });
    s.say(note(77, 'big', ['x'.repeat(2_000)]));
    expect(s.closed).toBe(true);
    expect(l.stats.tripped).toBe(1);
    expect(timers.at(-1)!.ms).toBe(600_000);
    expect(logs.some((x) => /closing for 10 minutes/.test(x))).toBe(true);
  });
});

// ---- registering what was heard

const pumpPool = (base: string, quote: string, vaultA: string, vaultB: string): Uint8Array => {
  const d = new Uint8Array(301);
  d.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  d.set(decode(base), 43);
  d.set(decode(quote), 75);
  d.set(decode(vaultA), 139);
  d.set(decode(vaultB), 171);
  return d;
};
const decode = (s: string): Uint8Array => decodeBase58(s)!;
const b64 = (d: Uint8Array): string => Buffer.from(d).toString('base64');
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

describe('registering a pool that was heard', () => {
  const SYSTEM = '11111111111111111111111111111111';
  const POOL = key(1);
  const BASE = key(2);
  const VA = key(3);
  const VB = key(4);
  const accountData = new Map<string, { owner: string; data: Uint8Array }>([
    [POOL, { owner: PUMP.program, data: pumpPool(BASE, WSOL, VA, VB) }],
    [BASE, { owner: 'Tokenkeg', data: mint(6) }],
    [WSOL, { owner: 'Tokenkeg', data: mint(9) }],
    [VA, { owner: 'Tokenkeg', data: tokenAccount(1_000_000_000n) }],
    [VB, { owner: 'Tokenkeg', data: tokenAccount(50_000_000_000n) }],
  ]);
  const node = (txs: Record<string, unknown>) => {
    const calls: string[] = [];
    const rpc = (async (method: string, params: unknown[]) => {
      calls.push(method);
      if (method === 'getTransaction') return txs[params[0] as string] ?? null;
      if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map((k) => (accountData.has(k) ? { owner: accountData.get(k)!.owner, data: [b64(accountData.get(k)!.data), 'base64'] } : null)) };
      if (method === 'getAccountInfo') return { value: null };
      return null;
    }) as never;
    return { rpc, calls };
  };
  const tx = (keys: string[]) => ({ slot: 42, blockTime: NOW / 1000, meta: {}, transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions: [] } } });
  const deps = (rpc: never, store = new InMemoryMiStore()) => ({ chain: chainConfig('solana', {}), rpc, store, rules: DEFAULT_RULES, now: () => NOW, nativeUsd: async () => 150 });

  it('finds the new pool among the accounts the transaction touched and registers it with its tokens', async () => {
    const { rpc, calls } = node({ sigNew: tx([SYSTEM, PUMP.program, POOL, BASE, WSOL, VA, VB]) });
    const store = new InMemoryMiStore();
    const r = await registerHeard(deps(rpc, store), { signature: 'sigNew', adapterId: 'pumpswap-solana' }, new Map(), emptyReport('pumpswap-solana'));
    expect(r).toEqual({ pools: 1, retry: false });
    const pool = [...store.pools.values()][0]!;
    expect(pool.address).toBe(POOL);
    expect(pool.base).toBe(BASE);
    expect(pool.quote).toBe(WSOL);
    expect(pool.adapterId).toBe('pumpswap-solana');
    expect(calls.filter((c) => c === 'getTransaction')).toHaveLength(1); // one transaction read for the creation, nothing else per swap
  });

  it('asks again later when the transaction is not available yet, and registers nothing for one that made no pool', async () => {
    const missing = node({});
    expect(await registerHeard(deps(missing.rpc), { signature: 'gone', adapterId: 'pumpswap-solana' }, new Map(), emptyReport('x'))).toEqual({ pools: 0, retry: true });
    const none = node({ other: tx([SYSTEM, PUMP.program, key(9)]) });
    expect(await registerHeard(deps(none.rpc), { signature: 'other', adapterId: 'pumpswap-solana' }, new Map(), emptyReport('x'))).toEqual({ pools: 0, retry: false });
  });

  it('is harmless to hear the same creation twice', async () => {
    const { rpc } = node({ sigNew: tx([POOL, BASE, WSOL, VA, VB]) });
    const store = new InMemoryMiStore();
    const d = deps(rpc, store);
    await registerHeard(d, { signature: 'sigNew', adapterId: 'pumpswap-solana' }, new Map(), emptyReport('x'));
    await registerHeard(d, { signature: 'sigNew', adapterId: 'pumpswap-solana' }, new Map(), emptyReport('x'));
    expect(store.pools.size).toBe(1);
  });
});
