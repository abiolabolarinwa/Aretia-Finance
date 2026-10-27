import { describe, expect, it } from 'vitest';
import {
  CURVE_SCAN_FROM_ISO,
  CURVE_TOPICS,
  ZERO,
  addrTopic,
  blockAtOrAfter,
  changeOver,
  changeText,
  coinText,
  createdTokens,
  decodeTrades,
  holdersFromTransfers,
  shareText,
  totalsOf,
} from './walletCreatorStatsCore';
import { HistoryUnavailable, MAX_TOKENS, readCreatorStats } from './walletCreatorStatsFlow';

const CREATOR = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const CURVE = '0x4e85bc5bd6f08fa87ceb749372e34226556837e8';
const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
const hexN = (n: number): string => '0x' + n.toString(16);
const pad = (a: string): string => addrTopic(a);

const traded = (block: number, trader: string, isBuy: boolean, coin: bigint, fee: bigint): Record<string, unknown> => ({
  topics: [CURVE_TOPICS.traded, pad(TOKEN), pad(trader)],
  data: '0x' + w(isBuy ? 1 : 0) + w(coin) + w(fee) + w(1000) + w(0) + w(0) + w(0),
  blockNumber: hexN(block),
});
const transfer = (block: number, from: string, to: string, v: bigint): Record<string, unknown> => ({ topics: [CURVE_TOPICS.transfer, pad(from), pad(to)], data: '0x' + w(v), blockNumber: hexN(block) });

describe('decoding', () => {
  it('reads the tokens a creator made and ignores malformed logs', () => {
    expect(createdTokens([{ topics: [CURVE_TOPICS.created, pad(TOKEN), pad(CREATOR)] }, { topics: ['x'] }, {}, { topics: [CURVE_TOPICS.created, pad(TOKEN)] }])).toEqual([TOKEN]);
  });
  it('decodes trades and counts what it cannot read instead of guessing', () => {
    const { trades, skipped } = decodeTrades([traded(10, BUYER, true, 5n * 10n ** 18n, 10n ** 16n), traded(11, BUYER, false, 10n ** 18n, 10n ** 15n), { topics: [], data: '0x' }, { ...traded(12, BUYER, true, 1n, 0n), data: '0x' + w(7) + w(1) + w(0) + w(0) + w(0) + w(0) }]);
    expect(trades).toHaveLength(2);
    expect(skipped).toBe(2);
    const t = totalsOf(trades);
    expect(t).toMatchObject({ trades: 2, buys: 1, sells: 1, traders: 1, volume: 6n * 10n ** 18n, fees: 10n ** 16n + 10n ** 15n });
  });
});

describe('holders', () => {
  it('replays transfers into a count and the creator share', () => {
    const logs = [transfer(1, ZERO, CREATOR, 1000n), transfer(2, CREATOR, TOKEN, 600n), transfer(3, TOKEN, BUYER, 100n)];
    const h = holdersFromTransfers(logs, CREATOR, true)!;
    expect(h.count).toBe(3);
    expect(h.creatorBalance).toBe(400n);
    expect(h.supply).toBe(1000n);
    expect(shareText(h.creatorBalance, h.supply)).toBe('40.0%');
  });
  it('gives no number when the logs are incomplete or do not add up', () => {
    expect(holdersFromTransfers([transfer(1, ZERO, CREATOR, 1n)], CREATOR, false)).toBeNull();
    expect(holdersFromTransfers([transfer(2, CREATOR, BUYER, 5n)], CREATOR, true)).toBeNull(); // the mint was not in the logs
    expect(holdersFromTransfers([{ topics: [CURVE_TOPICS.transfer], data: '0x' }], CREATOR, true)).toBeNull();
  });
});

describe('7 and 30 day change', () => {
  const trades = decodeTrades([traded(100, BUYER, true, 10n, 0n), traded(250, BUYER, true, 30n, 0n), traded(300, BUYER, false, 10n, 0n)]).trades;
  const cut = { head: 400, back1: 200, back2: 0 };
  it('compares the last window with the one before, in percent', () => {
    const c = changeOver(trades, cut, true);
    expect(c.current).toEqual({ trades: 2, volume: 40n });
    expect(c.previous).toEqual({ trades: 1, volume: 10n });
    expect(c.volumePct).toBe(300);
  });
  it('refuses to compare when the earlier window is not fully read, or has no volume', () => {
    expect(changeOver(trades, cut, false).volumePct).toBeNull();
    expect(changeOver(trades, { head: 400, back1: 300, back2: 260 }, true).volumePct).toBeNull();
    expect(changeText(changeOver(trades, cut, false), 7, 'ETH')).toMatch(/No comparison yet/);
  });
});

describe('words', () => {
  it('rounds coin amounts for people and says "under" instead of rounding to zero', () => {
    expect(coinText(0n, 'ETH')).toBe('0 ETH');
    expect(coinText(1500000000000000000n, 'ETH')).toBe('1.5 ETH');
    expect(coinText(1234567890000000000000n, 'ETH')).toBe('1,234.5679 ETH');
    expect(coinText(10n ** 13n, 'ETH')).toBe('under 0.0001 ETH');
    expect(shareText(1n, 0n)).toBeNull();
  });
  it('finds a block by time', async () => {
    expect(await blockAtOrAfter(500, 1000, async (b) => b)).toBe(500);
    expect(await blockAtOrAfter(5000, 1000, async (b) => b)).toBe(1000);
    expect(await blockAtOrAfter(0, 1000, async (b) => b, 200)).toBe(200);
  });
});

// ---------------------------------------------------------------- the whole read, against a fake node

const scanTs = Date.parse(`${CURVE_SCAN_FROM_ISO}T00:00:00Z`) / 1000;
const NOW = scanTs + 10 * 86_400;
const HEAD = 100_000;
const START = HEAD - (10 * 86_400) / 12;

function fakeNode(opts: { failTransfers?: boolean; tokens?: string[] } = {}) {
  const calls: string[] = [];
  const tokens = opts.tokens ?? [TOKEN];
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method);
    if (method === 'eth_blockNumber') return hexN(HEAD);
    if (method === 'eth_getBlockByNumber') return { timestamp: hexN(NOW - (HEAD - Number.parseInt(String(params[0]), 16)) * 12) };
    if (method === 'eth_call') {
      const data = (params[0] as { data: string }).data;
      if (data === '0x313ce567') return '0x' + w(18);
      return '0x' + w(32) + w(3) + Buffer.from('ABC').toString('hex').padEnd(64, '0');
    }
    if (method === 'eth_getLogs') {
      const f = params[0] as { address: string; topics: (string | null)[]; fromBlock: string; toBlock: string };
      const inRange = (l: Record<string, unknown>): boolean => Number.parseInt(String(l.blockNumber), 16) >= Number.parseInt(f.fromBlock, 16) && Number.parseInt(String(l.blockNumber), 16) <= Number.parseInt(f.toBlock, 16);
      const only = (logs: Record<string, unknown>[]): Record<string, unknown>[] => logs.filter(inRange);
      if (f.topics[0] === CURVE_TOPICS.created) return only(tokens.map((t) => ({ topics: [CURVE_TOPICS.created, pad(t), pad(CREATOR)], blockNumber: hexN(START + 5) })));
      if (f.topics[0] === CURVE_TOPICS.traded) return only([traded(START + 10, BUYER, true, 5n * 10n ** 18n, 10n ** 16n), traded(HEAD - 100, BUYER, false, 10n ** 18n, 10n ** 15n)]);
      if (opts.failTransfers) throw new Error('range too large');
      return only([transfer(START + 6, ZERO, CREATOR, 1000n), transfer(START + 7, CREATOR, BUYER, 250n)]);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { read, calls };
}

describe('reading a creator from a node', () => {
  it('reports trades, holders and the creator share, and says the 7 and 30 day comparison is not possible yet', async () => {
    const { read } = fakeNode();
    const r = await readCreatorStats({ read, nowSeconds: () => NOW }, CURVE, CREATOR);
    const t = r.tokens[0]!;
    expect(r.tokens).toHaveLength(1);
    expect(t.symbol).toBe('ABC');
    expect(t.totals).toMatchObject({ trades: 2, buys: 1, sells: 1, volume: 6n * 10n ** 18n });
    expect(t.holders).toMatchObject({ count: 2, creatorBalance: 750n });
    // Ten days of history: the 7 day change needs 14, so no percentage is invented.
    expect(t.change7?.comparable).toBe(false);
    expect(t.change7?.volumePct).toBeNull();
    expect(t.change30?.comparable).toBe(false);
    expect(t.change7?.current.trades).toBe(1);
    expect(t.notes).toEqual([]);
  });
  it('shows a figure as missing, with a reason, when the node will not give the logs', async () => {
    const { read } = fakeNode({ failTransfers: true });
    const t = (await readCreatorStats({ read, nowSeconds: () => NOW }, CURVE, CREATOR)).tokens[0]!;
    expect(t.holders).toBeNull();
    expect(t.totals).not.toBeNull();
    expect(t.notes.join(' ')).toMatch(/holder count is not shown/);
  });
  it('returns an empty list for a wallet that made nothing, and caps a long list', async () => {
    expect((await readCreatorStats({ read: fakeNode({ tokens: [] }).read, nowSeconds: () => NOW }, CURVE, CREATOR)).tokens).toEqual([]);
    const many = Array.from({ length: MAX_TOKENS + 3 }, (_, n) => '0x' + (n + 1).toString(16).padStart(40, '0'));
    const r = await readCreatorStats({ read: fakeNode({ tokens: many }).read, nowSeconds: () => NOW }, CURVE, CREATOR);
    expect(r.tokens).toHaveLength(MAX_TOKENS);
    expect(r.truncated).toBe(true);
  });
  it('says the history is unavailable (not an empty list) when a free node refuses old logs for the Curve', async () => {
    const read = async (method: string): Promise<unknown> => {
      if (method === 'eth_blockNumber') return hexN(HEAD);
      if (method === 'eth_getBlockByNumber') return { timestamp: hexN(NOW) };
      throw new Error('Archive requests require a personal token.');
    };
    await expect(readCreatorStats({ read, nowSeconds: () => NOW }, CURVE, CREATOR)).rejects.toBeInstanceOf(HistoryUnavailable);
  });
  it('fails loudly, not with an empty list, when the node is unreadable', async () => {
    await expect(readCreatorStats({ read: async () => { throw new Error('down'); }, nowSeconds: () => NOW }, CURVE, CREATOR)).rejects.toThrow();
  });
});
