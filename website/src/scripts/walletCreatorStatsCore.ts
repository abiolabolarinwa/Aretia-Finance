/**
 * Creator analytics, the pure part: turning the Aretia Curve's event logs and a token's Transfer logs into numbers a creator can read,
 * and saying plainly what could not be read. No network, no keys, nothing invented: a number that cannot be read from the chain is
 * `null`, and the page says why instead of showing a zero.
 *
 * What the chain gives for a curve: every `Created` (who made it), every `Traded` (buy or sell, the coin paid, the fee, the tokens)
 * and, from the token's own Transfer logs, who holds what. What it does not give: who a holder is, what a trade was worth in dollars,
 * or any fee paid to the creator, because the curve pays its trading fee to Aretia's fee address and none to the creator.
 */
import { keccak256 } from '../swings/core/keccak.js';

const enc = new TextEncoder();
const topicOf = (signature: string): string => '0x' + [...keccak256(enc.encode(signature))].map((x) => x.toString(16).padStart(2, '0')).join('');

export const CURVE_TOPICS = {
  created: topicOf('Created(address,address,uint256,uint256,uint256,uint256,uint256)'),
  traded: topicOf('Traded(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256)'),
  transfer: topicOf('Transfer(address,address,uint256)'),
} as const;

/**
 * Logs are read from this day on. The Aretia Curve was deployed on 17 Oct 2026 or before (the addresses were added to the site that day),
 * so nothing earlier can exist; the margin is deliberate. Moving it earlier only costs a longer read.
 */
export const CURVE_SCAN_FROM_ISO = '2026-10-14';
export const ZERO = '0x0000000000000000000000000000000000000000';

export const addrTopic = (a: string): string => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const topicAddr = (t: unknown): string | null => (typeof t === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(t) ? '0x' + t.slice(26).toLowerCase() : null);
const words = (data: unknown, n: number): bigint[] | null => {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 2 + 64 * n) return null;
  return Array.from({ length: n }, (_, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64)));
};
const blockOf = (l: { blockNumber?: unknown }): number | null => (typeof l.blockNumber === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(l.blockNumber) ? Number(BigInt(l.blockNumber)) : null);

export interface RawLog {
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
}

/** The tokens named by `Created` logs (the filter on the creator is done by the node). */
export function createdTokens(logs: readonly RawLog[]): string[] {
  const out = new Set<string>();
  for (const l of logs) {
    const t = Array.isArray(l.topics) ? topicAddr(l.topics[1]) : null;
    if (t) out.add(t);
  }
  return [...out];
}

export interface Trade {
  block: number;
  trader: string;
  isBuy: boolean;
  /** Coin paid (buy) or received before the fee (sell), wei. */
  coin: bigint;
  fee: bigint;
  tokens: bigint;
}

/** Decodes `Traded` logs; a malformed log is dropped and counted, never guessed at. */
export function decodeTrades(logs: readonly RawLog[]): { trades: Trade[]; skipped: number } {
  const trades: Trade[] = [];
  let skipped = 0;
  for (const l of logs) {
    const topics = Array.isArray(l.topics) ? l.topics : [];
    const trader = topicAddr(topics[2]);
    const w = words(l.data, 6);
    const block = blockOf(l);
    if (!trader || !w || block === null || w[0]! > 1n) {
      skipped += 1;
      continue;
    }
    trades.push({ block, trader, isBuy: w[0] === 1n, coin: w[1]!, fee: w[2]!, tokens: w[3]! });
  }
  return { trades, skipped };
}

export interface Holders {
  /** Addresses holding more than zero, not counting the zero address. */
  count: number;
  /** What the creator holds, and the total supply seen (the sum of balances), smallest units. */
  creatorBalance: bigint;
  supply: bigint;
}

/**
 * Replays Transfer logs (in the order given, which must be chain order) into balances. Correct only if the logs run from the token's
 * creation: the caller passes `complete` as false when they did not, and the result is then null.
 */
export function holdersFromTransfers(logs: readonly RawLog[], creator: string, complete: boolean): Holders | null {
  if (!complete) return null;
  const bal = new Map<string, bigint>();
  for (const l of logs) {
    const topics = Array.isArray(l.topics) ? l.topics : [];
    const from = topicAddr(topics[1]);
    const to = topicAddr(topics[2]);
    const w = words(l.data, 1);
    if (!from || !to || !w) return null;
    if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - w[0]!);
    if (to !== ZERO) bal.set(to, (bal.get(to) ?? 0n) + w[0]!);
  }
  let count = 0;
  let supply = 0n;
  for (const v of bal.values()) {
    if (v < 0n) return null; // Balances that go negative mean a log was missed. Better no number than a wrong one.
    if (v > 0n) count += 1;
    supply += v;
  }
  return { count, creatorBalance: bal.get(creator.toLowerCase()) ?? 0n, supply };
}

export interface WindowStats {
  trades: number;
  volume: bigint;
}
export interface Change {
  current: WindowStats;
  previous: WindowStats;
  /** Percent change in volume, or null when there is no earlier volume to compare with. */
  volumePct: number | null;
  /** False when the earlier window reaches back before the curve's logs were read from, so it cannot be compared fairly. */
  comparable: boolean;
}

export interface Totals {
  trades: number;
  buys: number;
  sells: number;
  traders: number;
  volume: bigint;
  fees: bigint;
}

export function totalsOf(trades: readonly Trade[]): Totals {
  const traders = new Set<string>();
  const t: Totals = { trades: trades.length, buys: 0, sells: 0, traders: 0, volume: 0n, fees: 0n };
  for (const x of trades) {
    traders.add(x.trader);
    if (x.isBuy) t.buys += 1;
    else t.sells += 1;
    t.volume += x.coin;
    t.fees += x.fee;
  }
  t.traders = traders.size;
  return t;
}

const windowOf = (trades: readonly Trade[], from: number, to: number): WindowStats => {
  const w: WindowStats = { trades: 0, volume: 0n };
  for (const x of trades) if (x.block >= from && x.block < to) { w.trades += 1; w.volume += x.coin; }
  return w;
};

/**
 * The last `days` against the `days` before them, by block. `cut` is the first block of each boundary (now, `days` ago, `2×days` ago).
 * `comparable` must be false when the earlier window reaches back before the logs were read from (the caller knows the times), because
 * then part of it is missing and a percentage would be wrong.
 */
export function changeOver(trades: readonly Trade[], cut: { head: number; back1: number; back2: number }, comparable: boolean): Change {
  const current = windowOf(trades, cut.back1, cut.head + 1);
  const previous = windowOf(trades, cut.back2, cut.back1);
  const volumePct = comparable && previous.volume > 0n ? Number(((current.volume - previous.volume) * 10_000n) / previous.volume) / 100 : null;
  return { current, previous, volumePct, comparable };
}

/** The first block whose timestamp is at or after `target` (seconds), by bisection. `tsOf` reads a block's timestamp. */
export async function blockAtOrAfter(target: number, head: number, tsOf: (block: number) => Promise<number>, low = 0): Promise<number> {
  let lo = low;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await tsOf(mid)) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---------------------------------------------------------------- words for the page

/** "1.2345 ETH", rounded for people, "0" when nothing, never more than four decimals (under 0.0001 reads "under 0.0001"). */
export function coinText(wei: bigint, symbol: string): string {
  if (wei <= 0n) return `0 ${symbol}`;
  const unit = 10n ** 14n;
  const r = (wei + unit / 2n) / unit;
  if (r === 0n) return `under 0.0001 ${symbol}`;
  const whole = (r / 10_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (r % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${frac ? `${whole}.${frac}` : whole} ${symbol}`;
}

/** "12.5% of the supply", or "0%" when none; supply 0 gives null. */
export function shareText(part: bigint, total: bigint): string | null {
  if (total <= 0n) return null;
  const bp = Number((part * 10_000n) / total) / 100;
  return `${bp.toFixed(bp > 0 && bp < 0.1 ? 2 : 1)}%`;
}

export function changeText(c: Change, days: number, symbol: string): string {
  const now = `${c.current.trades} trade${c.current.trades === 1 ? '' : 's'}, ${coinText(c.current.volume, symbol)}`;
  if (!c.comparable) return `${now} in the last ${days} days. No comparison yet: that needs ${days * 2} days of history and the Curve is not that old.`;
  if (c.volumePct === null) return `${now} in the last ${days} days. There was no trading in the ${days} days before, so there is nothing to compare with.`;
  const sign = c.volumePct > 0 ? '+' : '';
  return `${now} in the last ${days} days, ${sign}${c.volumePct}% volume against the ${days} days before.`;
}

/** What this page cannot show, said every time, so a missing number is never mistaken for a zero. */
export const CANNOT_SHOW: readonly string[] = [
  'Who holders are, and any figure in dollars: the chain gives amounts in the network’s coin only.',
  'Creator fees. The Aretia Curve pays its trading fee to Aretia’s fee address, so there is no creator fee to show.',
  'Anything for tokens you made on Solana: the Aretia Curve is not live on Solana mainnet, and Solana has no list of the tokens a wallet created, so nothing is shown rather than a guess.',
  'Trades on pools and exchanges outside the Aretia Curve (for example after the token graduates to Uniswap or PancakeSwap).',
];
