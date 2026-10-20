/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import poolArtifact from '../../../contracts-evm/AretiaPool.artifact.json';
import { createAddress } from './walletCurveEvmCore';
import { evmPoolChain, type EvmPoolMath } from './walletAretiaPoolEvmCore';
import type { EvmPoolFlowDeps } from './walletAretiaPoolEvmFlow';
import { POOL_SEL } from './walletAretiaPoolEvmTx';
import { POOL_EVENT_TOPICS, ownerLogFilters, rowClaimText, rowFrom, rowHasClaimable, rowLockText, rowName, sortRows, tokensFromLogs } from './walletYourPoolsEvmCore';
import { LOG_RANGE, MAX_EVM_POSITIONS, YourEvmPools } from './walletYourPoolsEvmFlow';

const ETH = 10n ** 18n;
const ME = '0x00000000000000000000000000000000000c0de1';
const POOL = '0x2222222222222222222222222222222222222222';
const addresses = { ethereum: POOL } as const;
const blocks = { ethereum: 1_000 } as const;
const chain = evmPoolChain('ethereum', addresses)!;
const TOKEN_A = createAddress(chain.factory, 4n);
const TOKEN_B = createAddress(chain.factory, 5n);
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const w32 = (n: bigint) => n.toString(16).padStart(64, '0');
const topicAddr = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const str = (s: string) => '0x' + w32(32n) + w32(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
const math: EvmPoolMath = { feeBps: 25n, x: 10n ** 27n, y: 5n * ETH, l: 10n * ETH, acc: 1n << 70n, feeReserve: 0n };

describe('event topics', () => {
  it('equal the hashes of the contract’s event signatures', () => {
    const events = (poolArtifact.pool.abi as { type: string; name: string; inputs: { type: string }[] }[]).filter((e) => e.type === 'event');
    const sig = (n: string) => `${n}(${events.find((e) => e.name === n)!.inputs.map((i) => i.type).join(',')})`;
    expect(sig('Created')).toBe('Created(address,address,address,uint256,uint256,uint256,uint256,bool)');
    expect(sig('PositionTransferred')).toBe('PositionTransferred(address,address,address)');
    expect(sig('LiquidityChanged')).toBe('LiquidityChanged(address,address,bool,uint256,uint256,uint256)');
    for (const t of Object.values(POOL_EVENT_TOPICS)) expect(t).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(Object.values(POOL_EVENT_TOPICS)).size).toBe(3);
  });
  it('the filters put the wallet where the contract’s indexed parameters are', () => {
    const f = ownerLogFilters(ME);
    expect(f.map((x) => x.name)).toEqual(['created', 'transferred', 'liquidity']);
    expect(f[0]!.topics).toEqual([POOL_EVENT_TOPICS.created, null, null, topicAddr(ME)]);
    expect(f[1]!.topics).toEqual([POOL_EVENT_TOPICS.transferred, null, null, topicAddr(ME)]);
    expect(f[2]!.topics).toEqual([POOL_EVENT_TOPICS.liquidity, null, topicAddr(ME)]);
  });
  it('pulls distinct token addresses from logs and ignores malformed ones', () => {
    const logs = [{ topics: ['0x1', topicAddr(TOKEN_A)] }, { topics: ['0x1', topicAddr(TOKEN_A.toUpperCase().replace('0X', '0x'))] }, { topics: ['0x1', topicAddr(TOKEN_B)] }, { topics: ['0x1', '0x12'] }, { topics: 'nope' }, {}];
    expect(tokensFromLogs(logs).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
  });
});

describe('rows', () => {
  const pos = (over: any = {}) => ({ open: true, shares: 10n * ETH, locked: 10n * ETH, checkpoint: 0n, pending: 0n, recipient: null, ...over });
  it('say what can be claimed, and sort pools with fees first', () => {
    const a = rowFrom(chain, TOKEN_A, { symbol: 'AAA', decimals: 18 }, { ...math, acc: 0n } as any, pos());
    const b = rowFrom(chain, TOKEN_B, { symbol: 'BBB', decimals: 18 }, math as any, pos());
    expect(rowHasClaimable(a)).toBe(false);
    expect(rowClaimText(a)).toBe('Nothing to claim yet');
    expect(rowHasClaimable(b)).toBe(true);
    expect(rowClaimText(b)).toMatch(/ETH$/);
    expect(rowName(b)).toBe('BBB / ETH');
    expect(rowLockText(b)).toBe('Locked for good');
    expect(sortRows([a, b]).map(rowName)).toEqual(['BBB / ETH', 'AAA / ETH']);
  });
});

/** A scripted chain with a pool contract that keeps a log list and positions, and a node that limits the log range. */
function world(opts: { maxRange?: number } = {}) {
  const state = {
    head: 5_000,
    logs: [] as { block: number; topics: (string | null)[] }[],
    positions: new Map<string, any>(),
    asked: [] as number[],
    sent: [] as any[],
    claimed: false,
  };
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    const p = params as any[];
    if (method === 'eth_blockNumber') return hex(state.head);
    if (method === 'eth_getLogs') {
      const f = p[0];
      const from = Number(BigInt(f.fromBlock));
      const to = Number(BigInt(f.toBlock));
      state.asked.push(to - from + 1);
      if (opts.maxRange && to - from + 1 > opts.maxRange) throw new Error('query returned more than 10000 results');
      return state.logs.filter((l) => l.block >= from && l.block <= to && f.topics.every((t: string | null, i: number) => t === null || l.topics[i] === t)).map((l) => ({ topics: l.topics }));
    }
    if (method === 'eth_chainId') return hex(1);
    if (method === 'eth_getCode') return '0x6080';
    if (method === 'eth_getBalance') return hex(10n * ETH);
    if (method === 'eth_gasPrice') return hex(20_000_000_000n);
    if (method === 'eth_estimateGas') return hex(60_000);
    if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
    if (method === 'eth_call') {
      const tx = p[0] as { to: string; data: string; from?: string };
      const d = tx.data;
      if (d.startsWith('0x95d89b41')) return str('TST');
      if (d.startsWith('0x313ce567')) return '0x' + w32(18n);
      if (d.startsWith('0x70a08231')) return '0x' + w32(0n);
      if (d.startsWith(POOL_SEL.factory)) return '0x' + w32(BigInt(chain.factory));
      if (d.startsWith(POOL_SEL.feeRecipient)) return '0x' + w32(BigInt(chain.feeAddress));
      if (d.startsWith(POOL_SEL.creationFee)) return '0x' + w32(chain.creationFee);
      if (d.startsWith(POOL_SEL.pools)) return '0x' + [25n, BigInt(ME), 1n, math.x, math.y, math.l, math.acc, math.feeReserve, math.l, 0n].map(w32).join('');
      if (d.startsWith(POOL_SEL.positions)) {
        const token = '0x' + d.slice(10 + 24, 10 + 64);
        const who = '0x' + d.slice(10 + 64 + 24);
        const q = state.positions.get(`${token}:${who}`);
        const checkpoint = q && state.claimed ? math.acc : (q?.checkpoint ?? 0n);
        return '0x' + [q ? 1n : 0n, q?.shares ?? 0n, q?.locked ?? 0n, checkpoint, q?.pending ?? 0n, 0n].map(w32).join('');
      }
      return '0x';
    }
    throw new Error(`unexpected ${method}`);
  };
  const adapter = {
    getAccounts: async () => [ME],
    getChainId: async () => 1,
    switchChain: async () => undefined,
    sendTransaction: async (tx: any) => {
      state.sent.push(tx);
      state.claimed = true;
      return '0x' + '1'.padStart(64, '0');
    },
  };
  let clock = 0;
  const deps = { adapter, read: async () => null, now: () => (clock += 60_000), nowSeconds: () => 1, sleep: async () => undefined } as unknown as EvmPoolFlowDeps;
  const engine = new YourEvmPools(deps, () => read as any, addresses, blocks);
  const own = (token: string) => state.positions.set(`${token}:${ME}`, { shares: 10n * ETH, locked: 10n * ETH, checkpoint: 0n, pending: 0n });
  return { state, engine, own };
}

describe('listing a wallet’s positions', () => {
  it('finds tokens from all three kinds of log, and lists only positions the contract still shows as open', async () => {
    const { state, engine, own } = world();
    state.logs.push({ block: 1500, topics: [POOL_EVENT_TOPICS.created, topicAddr(TOKEN_A), topicAddr(ME), topicAddr(ME)] });
    state.logs.push({ block: 2500, topics: [POOL_EVENT_TOPICS.transferred, topicAddr(TOKEN_B), topicAddr('0x' + '9'.repeat(40)), topicAddr(ME)] });
    state.logs.push({ block: 3500, topics: [POOL_EVENT_TOPICS.liquidity, topicAddr(TOKEN_B), topicAddr('0x' + '8'.repeat(40))] }); // someone else's deposit
    own(TOKEN_A);
    // TOKEN_B was handed to this wallet and then handed on: the log remains, the contract shows no position.
    const r = await engine.list(ME, ['ethereum']);
    expect(r.failed).toEqual([]);
    expect(r.rows.map((x) => x.token)).toEqual([TOKEN_A]);
    expect(r.rows[0]).toMatchObject({ symbol: 'TST', decimals: 18 });
    expect(rowHasClaimable(r.rows[0]!)).toBe(true);
    own(TOKEN_B);
    expect((await engine.list(ME, ['ethereum'])).rows.map((x) => x.token).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
  });
  it('asks for smaller block ranges when a node refuses a wide one, and never reads before the deployment block', async () => {
    const { state, engine, own } = world({ maxRange: 1_100 });
    state.head = 9_000;
    state.logs.push({ block: 1010, topics: [POOL_EVENT_TOPICS.created, topicAddr(TOKEN_A), topicAddr(ME), topicAddr(ME)] });
    state.logs.push({ block: 8999, topics: [POOL_EVENT_TOPICS.liquidity, topicAddr(TOKEN_B), topicAddr(ME)] });
    state.logs.push({ block: 500, topics: [POOL_EVENT_TOPICS.liquidity, topicAddr(TOKEN_B), topicAddr(ME)] }); // before the contract existed: cannot be real
    own(TOKEN_A);
    own(TOKEN_B);
    const r = await engine.list(ME, ['ethereum']);
    expect(r.rows).toHaveLength(2);
    expect(state.asked[0]).toBe(LOG_RANGE > 9_000 - 1_000 + 1 ? 9_000 - 1_000 + 1 : LOG_RANGE);
    expect(Math.max(...state.asked.slice(-6))).toBeLessThanOrEqual(1_100);
  });
  it('lists nothing for a network without a contract or a deployment block, and reports a network it cannot read', async () => {
    const { engine } = world();
    expect((await engine.list(ME, ['bnb', 'sepolia'])).rows).toEqual([]);
    expect(engine.chainOf('ethereum')).not.toBeNull();
    expect(engine.chainOf('bnb')).toBeNull();
    const broken = new YourEvmPools({ adapter: {} as any, read: async () => null, now: () => 0, nowSeconds: () => 0 }, () => async () => {
      throw new Error('down');
    }, addresses, blocks);
    expect((await broken.list(ME, ['ethereum'])).failed).toEqual(['Ethereum']);
  });
  it('caps what it lists and says so', async () => {
    const { state, engine, own } = world();
    for (let i = 0; i < MAX_EVM_POSITIONS + 3; i++) {
      const t = '0x' + (i + 1).toString(16).padStart(40, '0');
      state.logs.push({ block: 2000, topics: [POOL_EVENT_TOPICS.liquidity, topicAddr(t), topicAddr(ME)] });
      own(t);
    }
    const r = await engine.list(ME, ['ethereum']);
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(MAX_EVM_POSITIONS);
  });
  it('filters out empty positions BEFORE capping, so spam cannot push real positions off the list (L-19)', async () => {
    const { state, engine, own } = world();
    for (let i = 0; i < MAX_EVM_POSITIONS + 10; i++) {
      const t = '0x' + (i + 1).toString(16).padStart(40, '0');
      state.logs.push({ block: 2000, topics: [POOL_EVENT_TOPICS.liquidity, topicAddr(t), topicAddr(ME)] });
      // open but empty: no shares, nothing pending
      state.positions.set(`${t}:${ME}`, { shares: 0n, locked: 0n, checkpoint: 0n, pending: 0n });
    }
    state.logs.push({ block: 3000, topics: [POOL_EVENT_TOPICS.created, topicAddr(TOKEN_A), topicAddr(ME), topicAddr(ME)] });
    own(TOKEN_A);
    const r = await engine.list(ME, ['ethereum']);
    expect(r.rows.map((x) => x.token)).toEqual([TOKEN_A]);
    expect(r.truncated).toBe(false);
  });
});

describe('claiming from the list', () => {
  it('sends the contract’s own claim, checked first, and reads the row back with nothing left to claim', async () => {
    const { state, engine, own } = world();
    state.logs.push({ block: 1500, topics: [POOL_EVENT_TOPICS.created, topicAddr(TOKEN_A), topicAddr(ME), topicAddr(ME)] });
    own(TOKEN_A);
    const row = (await engine.list(ME, ['ethereum'])).rows[0]!;
    const { outcome, after } = await engine.claim(row, ME);
    expect(outcome.differences).toEqual([]);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ to: POOL, value: '0x0' });
    expect(state.sent[0].data.startsWith(POOL_SEL.claimFees)).toBe(true);
    expect(after && rowHasClaimable(after)).toBe(false);
  });
  it('refuses when there is nothing to claim and sends nothing', async () => {
    const { state, engine, own } = world();
    state.logs.push({ block: 1500, topics: [POOL_EVENT_TOPICS.created, topicAddr(TOKEN_A), topicAddr(ME), topicAddr(ME)] });
    own(TOKEN_A);
    const row = (await engine.list(ME, ['ethereum'])).rows[0]!;
    await expect(engine.claim({ ...row, pool: { ...row.pool, acc: 0n }, claimable: 0n }, ME)).rejects.toThrow(/nothing to claim/);
    expect(state.sent).toEqual([]);
  });
});
