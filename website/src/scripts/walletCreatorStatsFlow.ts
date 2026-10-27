/**
 * Creator analytics, the reading: finds the Aretia Curve tokens a wallet created on one network and reads each one's trades and
 * holders from event logs. Read-only: `read` is a plain JSON-RPC reader (a public node), nothing is signed or sent. Every outside
 * dependency is passed in, so the whole path is tested with a fake node.
 */
import type { EvmRead } from '../swings/chains/evmSession.js';
import {
  CURVE_SCAN_FROM_ISO,
  CURVE_TOPICS,
  addrTopic,
  blockAtOrAfter,
  changeOver,
  createdTokens,
  decodeTrades,
  holdersFromTransfers,
  totalsOf,
  type Change,
  type Holders,
  type RawLog,
  type Totals,
} from './walletCreatorStatsCore';

export const MAX_TOKENS = 20;
const LOG_RANGE = 40_000;
const MIN_RANGE = 500;
/** More logs than this for one token and the holders figure is not attempted (reading it would be slow and a node may cut it short). */
export const MAX_TRANSFER_LOGS = 20_000;
const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567' } as const;
const DAY = 86_400;

const hex = (n: number): string => '0x' + n.toString(16);
const num = (v: unknown): number | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(v) ? Number(BigInt(v)) : null);

export interface TokenStats {
  token: string;
  symbol: string;
  decimals: number;
  /** Everything below is null when it could not be read, never zero. */
  totals: Totals | null;
  change7: Change | null;
  change30: Change | null;
  holders: Holders | null;
  /** Why a figure is missing, in words for the page. */
  notes: string[];
}

export interface CreatorListing {
  tokens: TokenStats[];
  /** More tokens than MAX_TOKENS were found. */
  truncated: boolean;
  /** The day the logs were read from, and the age of what was read, for the page to state. */
  readFrom: string;
}

export interface CreatorDeps {
  read: EvmRead;
  /** Seconds since 1970. */
  nowSeconds: () => number;
}

/** The free public nodes only answer log queries for the last few hours (and some cap the range). Raised when that is why a read failed. */
export class HistoryUnavailable extends Error {
  constructor() {
    super('History is not available from the free public nodes.');
    this.name = 'HistoryUnavailable';
  }
}
const isHistoryLimit = (e: unknown): boolean => /archive|limit exceeded|ranges over|range|not supported|too many|exceed/i.test(e instanceof Error ? e.message : String(e));

/** eth_getLogs over a range, halving the range when a node refuses it. Returns null when it cannot be read at all. */
export async function getLogs(read: EvmRead, base: Record<string, unknown>, from: number, to: number): Promise<RawLog[] | null> {
  const out: RawLog[] = [];
  let size = LOG_RANGE;
  let at = from;
  while (at <= to) {
    const end = Math.min(at + size - 1, to);
    try {
      const logs = (await read('eth_getLogs', [{ ...base, fromBlock: hex(at), toBlock: hex(end) }])) as unknown;
      if (!Array.isArray(logs)) return null;
      out.push(...(logs as RawLog[]));
      at = end + 1;
    } catch (e) {
      if (size <= MIN_RANGE) {
        if (isHistoryLimit(e)) throw new HistoryUnavailable();
        return null;
      }
      size = Math.max(MIN_RANGE, Math.floor(size / 2));
    }
  }
  return out;
}

const decodeString = (hexValue: unknown): string | null => {
  if (typeof hexValue !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hexValue) || hexValue.length < 2 + 128) return null;
  const len = Number(BigInt('0x' + hexValue.slice(2 + 64, 2 + 128)));
  const body = hexValue.slice(2 + 128, 2 + 128 + len * 2);
  if (len === 0 || len > 40 || body.length !== len * 2) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(body.match(/../g) ?? [], (x) => Number.parseInt(x, 16)));
  } catch {
    return null;
  }
};

/** Per-token reads: a missing history leaves that figure out (with a note) instead of failing the whole page. */
const softLogs = (...a: Parameters<typeof getLogs>): Promise<RawLog[] | null> => getLogs(...a).catch((e: unknown) => (e instanceof HistoryUnavailable ? null : Promise.reject(e)));

export async function readCreatorStats(d: CreatorDeps, curve: string, creator: string): Promise<CreatorListing> {
  const { read } = d;
  const headRaw = num(await read('eth_blockNumber', []));
  if (headRaw === null) throw new Error('The network did not give its latest block.');
  const head = headRaw;
  const tsOf = async (b: number): Promise<number> => {
    const blk = (await read('eth_getBlockByNumber', [hex(b), false])) as { timestamp?: unknown } | null;
    const t = num(blk?.timestamp);
    if (t === null) throw new Error('The network did not give a block time.');
    return t;
  };
  const scanTs = Date.parse(`${CURVE_SCAN_FROM_ISO}T00:00:00Z`) / 1000;
  const start = await blockAtOrAfter(scanTs, head, tsOf);
  const startTs = await tsOf(start);
  const now = d.nowSeconds();

  const created = await getLogs(read, { address: curve, topics: [CURVE_TOPICS.created, null, addrTopic(creator)] }, start, head);
  if (created === null) throw new HistoryUnavailable();
  const found = createdTokens(created);
  const chosen = found.slice(0, MAX_TOKENS);

  // Block boundaries for the 7 and 30 day windows, found once and shared by every token.
  const cutFor = async (days: number): Promise<{ head: number; back1: number; back2: number }> => ({
    head,
    back1: await blockAtOrAfter(now - days * DAY, head, tsOf, start),
    back2: await blockAtOrAfter(now - 2 * days * DAY, head, tsOf, start),
  });
  const [cut7, cut30] = chosen.length ? await Promise.all([cutFor(7), cutFor(30)]) : [null, null];
  const comparable = (days: number): boolean => now - 2 * days * DAY >= startTs;

  const tokens: TokenStats[] = [];
  for (const token of chosen) {
    const notes: string[] = [];
    const [sym, dec] = await Promise.all([read('eth_call', [{ to: token, data: SEL.symbol }, 'latest']).catch(() => null), read('eth_call', [{ to: token, data: SEL.decimals }, 'latest']).catch(() => null)]);
    const decimals = num(dec) ?? 18;
    const symbol = decodeString(sym) ?? `${token.slice(0, 6)}…${token.slice(-4)}`;

    let totals: Totals | null = null;
    let change7: Change | null = null;
    let change30: Change | null = null;
    const tradeLogs = await softLogs(read, { address: curve, topics: [CURVE_TOPICS.traded, '0x' + token.slice(2).padStart(64, '0')] }, start, head);
    if (tradeLogs === null) notes.push('Could not read this token’s trades from the network.');
    else {
      const { trades, skipped } = decodeTrades(tradeLogs);
      if (skipped > 0) notes.push(`${skipped} trade record${skipped === 1 ? ' was' : 's were'} unreadable and left out, so these totals may be short.`);
      totals = totalsOf(trades);
      if (cut7) change7 = changeOver(trades, cut7, comparable(7));
      if (cut30) change30 = changeOver(trades, cut30, comparable(30));
    }

    let holders: Holders | null = null;
    const transfers = await softLogs(read, { address: token, topics: [CURVE_TOPICS.transfer] }, start, head);
    if (transfers === null) notes.push('Could not read this token’s transfers, so the holder count is not shown.');
    else if (transfers.length > MAX_TRANSFER_LOGS) notes.push('This token has too many transfers to count its holders here.');
    else {
      holders = holdersFromTransfers(transfers, creator, true);
      if (!holders) notes.push('The transfers did not add up, so the holder count is not shown.');
    }
    tokens.push({ token, symbol, decimals, totals, change7, change30, holders, notes });
  }
  return { tokens, truncated: found.length > MAX_TOKENS, readFrom: CURVE_SCAN_FROM_ISO };
}
