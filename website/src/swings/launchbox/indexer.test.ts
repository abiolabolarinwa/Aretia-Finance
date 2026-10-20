import { describe, expect, it } from 'vitest';
import { EVM_FACTORIES, SOLANA_FEE_WALLET, TOKEN_2022_PROGRAM, TOKEN_CREATED_TOPIC, createAddress, parseSolanaState, selector } from './core';
import { FakeLaunchStore } from './fakeStore';
import { indexEvmChain, indexSolana, runIndexer } from './indexer';
import { base58, base58To32 } from '../tokens/token2022';

const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
const hexStr = (s: string): string => {
  const b = [...new TextEncoder().encode(s)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return w(new TextEncoder().encode(s).length) + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
};
const eventData = (name: string, symbol: string, decimals: number, supply: bigint): string => {
  const a = hexStr(name);
  const b = hexStr(symbol);
  return '0x' + w(128) + w(128 + a.length / 2) + w(decimals) + w(supply) + a + b;
};
const topic = (a: string): string => '0x' + a.slice(2).padStart(64, '0');

const FACTORY = EVM_FACTORIES.bnb;
const T1 = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';

interface Call {
  url: string;
  method: string;
  params: unknown[];
}

/** A pretend node. `handlers` answer by method; anything unlisted is an error so a test notices an unexpected call. */
function node(handlers: Record<string, (params: unknown[], url: string) => unknown>, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push({ url, method, params });
    const h = handlers[method];
    if (!h) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `no handler for ${method}` } }), { status: 200 });
    try {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: h(params, url) }), { status: 200 });
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: (e as Error).message } }), { status: 200 });
    }
  }) as unknown as typeof fetch;
}

const created = (token: string, block: number, name = 'Green', symbol = 'GRN') => ({
  address: FACTORY,
  topics: [TOKEN_CREATED_TOPIC, topic(token), topic(CREATOR)],
  data: eventData(name, symbol, 18, 1000n),
  blockNumber: '0x' + block.toString(16),
  transactionHash: '0x' + 'cd'.repeat(32),
  logIndex: '0x0',
});

describe('EVM indexer', () => {
  const baseHandlers = (logs: (p: { fromBlock: string; toBlock: string }) => unknown[], latest = 20_000, nonce = 2) => ({
    eth_blockNumber: () => '0x' + latest.toString(16),
    eth_getLogs: (p: unknown[]) => logs(p[0] as { fromBlock: string; toBlock: string }),
    eth_getBlockByNumber: () => ({ timestamp: '0x' + (1_760_000_000).toString(16) }),
    eth_getTransactionCount: () => '0x' + nonce.toString(16),
  });

  it('records a token from its TokenCreated log with the block time, and moves the cursor to the end of the window', async () => {
    const store = new FakeLaunchStore();
    await store.setCursor('bnb', '19000', 1, null);
    const fetchImpl = node(baseHandlers((r) => (parseInt(r.fromBlock, 16) <= 19500 && parseInt(r.toBlock, 16) >= 19500 ? [created(T1, 19500)] : [])));
    const report = await indexEvmChain('bnb', { store, fetchImpl, env: {}, now: () => 5_000 }, 1e12);
    expect(report.error).toBeUndefined();
    expect(report.added).toBe(1);
    const row = [...store.rows.values()][0]!;
    expect(row).toMatchObject({ chain: 'bnb', address: T1, name: 'Green', symbol: 'GRN', decimals: 18, supply: '1000', creator: CREATOR, createdAt: 1_760_000_000_000, source: 'factory' });
    expect((await store.getCursor('bnb'))?.cursor).toBe(String(20_000 - 3));
  });

  it('reads only confirmed blocks, in steps no bigger than the node allows', async () => {
    const store = new FakeLaunchStore();
    await store.setCursor('bnb', '10000', 1, null);
    const calls: Call[] = [];
    await indexEvmChain('bnb', { store, fetchImpl: node(baseHandlers(() => [], 20_000, 1), calls), env: {}, now: () => 5_000 }, 1e12);
    const ranges = calls.filter((c) => c.method === 'eth_getLogs').map((c) => c.params[0] as { fromBlock: string; toBlock: string });
    expect(parseInt(ranges[0]!.fromBlock, 16)).toBe(10_001);
    for (const r of ranges) expect(parseInt(r.toBlock, 16) - parseInt(r.fromBlock, 16) + 1).toBeLessThanOrEqual(2000);
    expect(parseInt(ranges.at(-1)!.toBlock, 16)).toBe(19_997);
  });

  it('is idempotent: running twice adds nothing the second time', async () => {
    const store = new FakeLaunchStore();
    await store.setCursor('bnb', '19000', 1, null);
    const handlers = baseHandlers((r) => (parseInt(r.fromBlock, 16) <= 19500 && parseInt(r.toBlock, 16) >= 19500 ? [created(T1, 19500)] : []), 20_000, 2);
    // The factory has made exactly one token, at its nonce-1 address, so the count check has nothing to add.
    const fetchImpl = node(handlers);
    const one = await indexEvmChain('bnb', { store, fetchImpl, env: {}, now: () => 5_000 }, 1e12);
    // Reset the cursor as if the first run had been cut short, and read the same blocks again.
    await store.setCursor('bnb', '19000', 2, null);
    const two = await indexEvmChain('bnb', { store, fetchImpl, env: {}, now: () => 6_000 }, 1e12);
    expect(one.added).toBe(1);
    expect(two.added).toBe(0);
    expect(store.rows.size).toBe(1);
  });

  it('keeps the cursor where it was when the node fails, and reports the failure', async () => {
    const store = new FakeLaunchStore();
    await store.setCursor('bnb', '19000', 1, null);
    const handlers = { ...baseHandlers(() => []), eth_getLogs: () => { throw new Error('upstream timeout'); } };
    const report = await indexEvmChain('bnb', { store, fetchImpl: node(handlers), env: {}, now: () => 5_000 }, 1e12);
    expect(report.error).toMatch(/upstream timeout/);
    expect((await store.getCursor('bnb'))?.cursor).toBe('19000');
    expect(store.rows.size).toBe(0);
  });

  it('does not advance past a window whose tokens could not be stored', async () => {
    const store = new FakeLaunchStore();
    await store.setCursor('bnb', '19000', 1, null);
    const real = store.insertNew.bind(store);
    store.insertNew = async () => {
      throw new Error('database down');
    };
    const report = await indexEvmChain('bnb', { store, fetchImpl: node(baseHandlers(() => [created(T1, 19500)])), env: {}, now: () => 5_000 }, 1e12);
    expect(report.error).toMatch(/database down/);
    expect((await store.getCursor('bnb'))?.cursor).toBe('19000');
    store.insertNew = real;
  });

  it('ignores logs from other contracts or with the wrong shape', async () => {
    const store = new FakeLaunchStore();
    await store.setCursor('bnb', '19000', 1, null);
    const logs = [{ ...created(T1, 19500), address: '0x3333333333333333333333333333333333333333' }, { ...created(T1, 19500), topics: [TOKEN_CREATED_TOPIC] }];
    const report = await indexEvmChain('bnb', { store, fetchImpl: node(baseHandlers(() => logs, 20_000, 1)), env: {}, now: () => 5_000 }, 1e12);
    expect(report.added).toBe(0);
  });

  it('skips ahead when the node cannot serve old blocks, and finds the older tokens by counting the factory\'s creations', async () => {
    const store = new FakeLaunchStore();
    const old = createAddress(FACTORY, 1n);
    const handlers = {
      ...baseHandlers(() => [], 500_000, 2),
      eth_getLogs: (p: unknown[]) => {
        const r = p[0] as { fromBlock: string };
        if (parseInt(r.fromBlock, 16) < 400_000) throw new Error('Archive requests require a personal token');
        return [];
      },
      eth_getCode: () => '0x6080',
      eth_call: (p: unknown[]) => {
        const data = (p[0] as { data: string }).data;
        if (data === selector('name()')) return '0x' + w(32) + hexStr('Old Coin');
        if (data === selector('symbol()')) return '0x' + w(32) + hexStr('OLD');
        if (data === selector('decimals()')) return '0x' + w(6);
        return '0x' + w(777);
      },
    };
    await store.setCursor('bnb', '100', 1, null);
    const report = await indexEvmChain('bnb', { store, fetchImpl: node(handlers), env: {}, now: () => 5_000 }, 1e12);
    expect(report.error).toBeUndefined();
    expect(report).toMatchObject({ expected: 1, indexed: 1, added: 1 });
    expect(store.rows.get(`bnb:${old}`)).toMatchObject({ name: 'Old Coin', symbol: 'OLD', decimals: 6, supply: '777', creator: null, createdAt: null, source: 'nonce' });
    expect((await store.getCursor('bnb'))?.stats).toMatchObject({ expected: 1, indexed: 1 });
  });

  it('says how many tokens the factory has made, so a gap is visible', async () => {
    const store = new FakeLaunchStore();
    await store.setCursor('bnb', '19000', 1, null);
    const handlers = { ...baseHandlers(() => [], 20_000, 4), eth_getCode: () => '0x' };
    const report = await indexEvmChain('bnb', { store, fetchImpl: node(handlers), env: {}, now: () => 5_000 }, 1e12);
    expect(report).toMatchObject({ expected: 3, indexed: 0 });
  });

  it('uses the owner\'s own node when one is configured', async () => {
    const calls: Call[] = [];
    const store = new FakeLaunchStore();
    await indexEvmChain('bnb', { store, fetchImpl: node(baseHandlers(() => [], 20_000, 1), calls), env: { EVM_RPC_BNB: 'https://own.example/rpc' }, now: () => 5_000 }, 1e12);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set(['https://own.example/rpc']));
  });
});

// ---------------------------------------------------------------- Solana

const sig = (c: string): string => c.repeat(88);
const PAYER = base58(new Uint8Array(32).fill(7));
const mint = (c: string): string => `Mint${c}`.padEnd(43, c);
const launchTx = (m: string) => ({
  blockTime: 1_760_000_000,
  meta: { err: null },
  transaction: {
    message: {
      accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: m, signer: true }],
      instructions: [
        { programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: PAYER, destination: SOLANA_FEE_WALLET, lamports: 50_000_000 } } },
        { programId: '11111111111111111111111111111111', parsed: { type: 'createAccount', info: { source: PAYER, newAccount: m, owner: TOKEN_2022_PROGRAM, lamports: 1, space: 234 } } },
        { programId: TOKEN_2022_PROGRAM, parsed: { type: 'initializeMint', info: { mint: m, decimals: 9, mintAuthority: PAYER } } },
      ],
    },
  },
});
const plainTransfer = {
  blockTime: 1_760_000_100,
  meta: { err: null },
  transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }], instructions: [{ programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: PAYER, destination: SOLANA_FEE_WALLET, lamports: 50_000_000 } } }] } },
};
/** A Token-2022 mint account as the node returns it (base64): metadata pointer and metadata, optionally other extensions and authorities. */
function rawMint(name: string, symbol: string, supply: string, o: { mintAuthority?: string | null; freezeAuthority?: string | null; extra?: [number, number][] } = {}): Uint8Array {
  const enc = new TextEncoder();
  const str = (t: string): number[] => {
    const b = [...enc.encode(t)];
    return [b.length & 255, b.length >> 8, 0, 0, ...b];
  };
  const meta = [...new Array(64).fill(0), ...str(name), ...str(symbol), ...str('https://x.example/m.json'), 0, 0, 0, 0];
  const tlv = (type: number, body: number[]): number[] => [type & 255, type >> 8, body.length & 255, body.length >> 8, ...body];
  const body = [...tlv(18, new Array(64).fill(0)), ...tlv(19, meta), ...(o.extra ?? []).flatMap(([t, l]) => tlv(t, new Array(l).fill(1)))];
  const d = new Uint8Array(166 + body.length);
  const v = new DataView(d.buffer);
  const ma = o.mintAuthority === undefined ? null : o.mintAuthority;
  if (ma) {
    v.setUint32(0, 1, true);
    d.set(base58To32(ma)!, 4);
  }
  v.setBigUint64(36, BigInt(supply), true);
  d[44] = 9;
  d[45] = 1;
  if (o.freezeAuthority) {
    v.setUint32(46, 1, true);
    d.set(base58To32(o.freezeAuthority)!, 50);
  }
  d[165] = 1;
  d.set(body, 166);
  return d;
}
const accountOf = (data: Uint8Array, owner = TOKEN_2022_PROGRAM) => ({ owner, data: [Buffer.from(data).toString('base64'), 'base64'] });
const mintAccount = (name: string, symbol: string, supply: string, o: Parameters<typeof rawMint>[3] = {}) => ({ value: accountOf(rawMint(name, symbol, supply, o)) });

function solanaNode(sigs: { signature: string; err?: unknown; blockTime?: number }[], txs: Record<string, unknown>, mints: Record<string, unknown>, calls: Call[] = []) {
  return node(
    {
      getSignaturesForAddress: (p) => {
        const o = p[1] as { before?: string; until?: string; limit: number };
        let list = sigs;
        if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1);
        if (o.until) {
          const i = list.findIndex((s) => s.signature === o.until);
          if (i >= 0) list = list.slice(0, i);
        }
        return list.slice(0, o.limit);
      },
      getTransaction: (p) => txs[p[0] as string] ?? null,
      getAccountInfo: (p) => mints[p[0] as string] ?? { value: null },
      getMultipleAccounts: (p) => ({ value: (p[0] as string[]).map((a) => (mints[a] as { value: unknown } | undefined)?.value ?? null) }),
    },
    calls,
  );
}

describe('Solana indexer', () => {
  const sigs = [{ signature: sig('a'), blockTime: 1_760_000_200 }, { signature: sig('b'), blockTime: 1_760_000_100 }, { signature: sig('c'), blockTime: 1_760_000_000 }, { signature: sig('d'), err: { x: 1 }, blockTime: 1_759_999_000 }];
  const txs = { [sig('a')]: launchTx(mint('1')), [sig('b')]: plainTransfer, [sig('c')]: launchTx(mint('2')) };
  const mints = { [mint('1')]: mintAccount('One', 'ONE', '1000'), [mint('2')]: mintAccount('Two', 'TWO', '0', { mintAuthority: PAYER }) };
  const deps = (store: FakeLaunchStore, fetchImpl: typeof fetch, now = 1_760_100_000_000) => ({ store, fetchImpl, env: {}, now: () => now });

  it('records fee-paying mint creations from the fee wallet\'s history, ignores the rest, and reads the name from the mint itself', async () => {
    const store = new FakeLaunchStore();
    const report = await indexSolana(deps(store, solanaNode(sigs, txs, mints)), 1e15);
    expect(report.error).toBeUndefined();
    expect(report.added).toBe(2);
    expect(store.rows.get(`solana:${mint('1')}`)).toMatchObject({ name: 'One', symbol: 'ONE', supply: '1000', creator: PAYER, tx: sig('a'), createdAt: 1_760_000_000_000, source: 'solana-fee' });
    expect(store.rows.get(`solana:${mint('2')}`)).toMatchObject({ name: 'Two', supply: '0' });
    const state = parseSolanaState((await store.getCursor('solana'))?.cursor ?? null);
    expect(state).toMatchObject({ head: sig('a'), done: true });
  });

  it('on the next run reads only what is new, and twice over changes nothing', async () => {
    const store = new FakeLaunchStore();
    await indexSolana(deps(store, solanaNode(sigs, txs, mints)), 1e15);
    const calls: Call[] = [];
    const newer = [{ signature: sig('e'), blockTime: 1_760_000_300 }, ...sigs];
    const more = { ...txs, [sig('e')]: launchTx(mint('3')) };
    const report = await indexSolana(deps(store, solanaNode(newer, more, { ...mints, [mint('3')]: mintAccount('Three', 'THR', '5') }, calls)), 1e15);
    expect(report.added).toBe(1);
    expect(calls.filter((c) => c.method === 'getTransaction').map((c) => c.params[0])).toEqual([sig('e')]);
    const again = await indexSolana(deps(store, solanaNode(newer, more, {})), 1e15);
    expect(again.added).toBe(0);
    expect(store.rows.size).toBe(3);
  });

  it('keeps its place when a transaction cannot be read, then continues from there', async () => {
    const store = new FakeLaunchStore();
    const broken = node({
      getSignaturesForAddress: () => sigs,
      getTransaction: () => {
        throw new Error('node busy');
      },
    });
    const bad = await indexSolana(deps(store, broken), 1e15);
    expect(bad.error).toMatch(/node busy/);
    expect(parseSolanaState((await store.getCursor('solana'))?.cursor ?? null)).toEqual({ head: null, tail: null, done: false, fwd: null });
    const good = await indexSolana(deps(store, solanaNode(sigs, txs, mints)), 1e15);
    expect(good.added).toBe(2);
  });

  it('waits for a very recent transaction the node does not have yet instead of skipping it', async () => {
    const store = new FakeLaunchStore();
    const now = 1_760_000_250_000;
    const report = await indexSolana(deps(store, solanaNode(sigs, {}, {}), now), 1e15);
    expect(report.error).toMatch(/not available/);
    expect(store.rows.size).toBe(0);
  });

  it('counts old transactions the node no longer has, and says so', async () => {
    const store = new FakeLaunchStore();
    await indexSolana(deps(store, solanaNode(sigs, {}, {})), 1e15);
    expect((await store.getCursor('solana'))?.stats).toMatchObject({ unreadable: 3 });
  });

  it('walks a long history back a page at a time and a quiet wallet costs one call', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ signature: 'a'.repeat(60) + [...String(i).padStart(3, '0')].map((d) => 'ABCDEFGHJK'[Number(d)]).join(''), blockTime: 1_000_000 + (250 - i) }));
    const store = new FakeLaunchStore();
    const calls: Call[] = [];
    const report = await indexSolana(deps(store, solanaNode(many, {}, {}, calls)), 1e15);
    expect(report.error).toBeUndefined();
    expect(calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(3);
    expect(parseSolanaState((await store.getCursor('solana'))?.cursor ?? null).done).toBe(true);
  });

  it('later fills in the supply of a token whose second transaction came after the first', async () => {
    const store = new FakeLaunchStore();
    await indexSolana(deps(store, solanaNode(sigs, txs, mints), 1_760_000_500_000), 1e15);
    const later = { ...mints, [mint('2')]: mintAccount('Two', 'TWO', '9000') };
    await indexSolana(deps(store, solanaNode(sigs, txs, later), 1_760_000_900_000), 1e15);
    expect(store.rows.get(`solana:${mint('2')}`)?.supply).toBe('9000');
  });
});

describe('Solana indexer: the launch rule (audit M-6)', () => {
  const sigs = [{ signature: sig('a'), blockTime: 1_760_000_200 }, { signature: sig('c'), blockTime: 1_760_000_000 }];
  const txs = { [sig('a')]: launchTx(mint('1')), [sig('c')]: launchTx(mint('2')) };
  const deps = (store: FakeLaunchStore, fetchImpl: typeof fetch, now = 1_760_100_000_000) => ({ store, fetchImpl, env: {}, now: () => now });
  const OTHER = base58(new Uint8Array(32).fill(9));

  it('does not list a mint with a permanent delegate, transfer hook or pausable extension, or with a freeze authority', async () => {
    for (const bad of [{ extra: [[12, 32]] as [number, number][] }, { extra: [[14, 64]] as [number, number][] }, { extra: [[26, 65]] as [number, number][] }, { freezeAuthority: PAYER }]) {
      const store = new FakeLaunchStore();
      const mints = { [mint('1')]: mintAccount('One', 'ONE', '1000', bad), [mint('2')]: mintAccount('Two', 'TWO', '1000') };
      const report = await indexSolana(deps(store, solanaNode(sigs, txs, mints)), 1e15);
      expect(report.added).toBe(1);
      expect([...store.rows.keys()]).toEqual([`solana:${mint('2')}`]);
      expect((await store.getCursor('solana'))?.stats).toMatchObject({ rejected: 1 });
    }
  });

  it('does not list a minted token whose mint authority was kept, or held by someone other than the creator', async () => {
    const store = new FakeLaunchStore();
    const mints = { [mint('1')]: mintAccount('One', 'ONE', '1000', { mintAuthority: PAYER }), [mint('2')]: mintAccount('Two', 'TWO', '0', { mintAuthority: OTHER }) };
    const report = await indexSolana(deps(store, solanaNode(sigs, txs, mints)), 1e15);
    expect(report.added).toBe(0);
  });

  it('takes a pending creation off the list when the creator mints but keeps the authority, or never finishes', async () => {
    const store = new FakeLaunchStore();
    const pending = { [mint('1')]: mintAccount('One', 'ONE', '0', { mintAuthority: PAYER }), [mint('2')]: mintAccount('Two', 'TWO', '0', { mintAuthority: PAYER }) };
    await indexSolana(deps(store, solanaNode(sigs, txs, pending), 1_760_000_500_000), 1e15);
    expect(store.rows.size).toBe(2);
    // Mint 1: supply minted, authority kept. Mint 2: still pending, but within the window.
    const later = { ...pending, [mint('1')]: mintAccount('One', 'ONE', '1000', { mintAuthority: PAYER }) };
    await indexSolana(deps(store, solanaNode(sigs, txs, later), 1_760_001_000_000), 1e15);
    expect([...store.rows.keys()]).toEqual([`solana:${mint('2')}`]);
    // Four days on, mint 2 has still not been finished.
    await indexSolana(deps(store, solanaNode(sigs, txs, later), 1_760_000_000_000 + 4 * 86_400_000), 1e15);
    expect(store.rows.size).toBe(0);
  });

  it('refreshes a name the creator changed after listing, cleaned of invisible characters', async () => {
    const store = new FakeLaunchStore();
    const mints = { [mint('1')]: mintAccount('One', 'ONE', '1000'), [mint('2')]: mintAccount('Two', 'TWO', '1000') };
    await indexSolana(deps(store, solanaNode(sigs, txs, mints)), 1e15);
    const renamed = { ...mints, [mint('1')]: mintAccount('Uno\u202e\ufeff', 'UNO\u2060', '1000') };
    await indexSolana(deps(store, solanaNode(sigs, txs, renamed)), 1e15);
    expect(store.rows.get(`solana:${mint('1')}`)).toMatchObject({ name: 'Uno', symbol: 'UNO' });
  });
});

describe('runIndexer', () => {
  it('runs every chain, and one chain\'s node failing does not stop the others', async () => {
    const store = new FakeLaunchStore();
    const fetchImpl = node({
      eth_blockNumber: (_p, url) => {
        if (url.includes('bsc')) throw new Error('bsc node down');
        return '0x4e20';
      },
      eth_getLogs: () => [],
      eth_getTransactionCount: () => '0x1',
      getSignaturesForAddress: () => [],
    });
    const report = await runIndexer({ store, fetchImpl, env: {}, now: () => 1 });
    expect(report.ok).toBe(false);
    expect(report.chains.map((c) => [c.chain, Boolean(c.error)])).toEqual([['bnb', true], ['ethereum', false], ['polygon', false], ['solana', false]]);
  });

  it('reports a missing table once, without throwing', async () => {
    const store = new FakeLaunchStore();
    store.missing = true;
    const report = await runIndexer({ store, fetchImpl: node({}), env: {}, now: () => 1 });
    expect(report.missingTable).toBe(true);
  });
});
