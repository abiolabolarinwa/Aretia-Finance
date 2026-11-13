/**
 * The numbers of a Markets row that move with trades, built from a pool's stored statistics. One function for two users: the list the
 * server sends (mi/marketList.ts `rowFromRecord`) and the live updates the page applies to a row it already shows (liveStream.ts), so a row
 * that was just pushed and the same row after a reload can never disagree. Pure, and light enough for the page to import.
 */
import type { MarketRow } from './types.js';

export type LiveWindow = 'm5' | 'h1' | 'h6' | 'h24';
/** How long each statistics window is, in ms. */
export const WINDOW_MS: Readonly<Record<LiveWindow, number>> = { m5: 300_000, h1: 3_600_000, h6: 21_600_000, h24: 86_400_000 };
type Window4 = { m5: number; h1: number; h6: number; h24: number };
type Win<T> = { m5: T; h1: T; h6: T; h24: T };

/** The fields of a stored pool that the live numbers come from (the names of the columns the list reads). */
export interface LiveRecord {
  p_usd: number | null;
  /** Price read from the pool's reserves, used while the pool has no stored trade. */
  rp?: number | null;
  chg: Win<number | null> | null;
  buys: Window4 | null;
  sells: Window4 | null;
  vol: Win<number | null> | null;
  ro: boolean | null;
  mk?: number | null;
  cp?: boolean | null;
  /** When the pool last traded (ms): a window that closed after it holds no trade, whatever the stored figures (computed earlier) still say. */
  last_trade_at?: number | null;
  liquidity_usd: number | null;
}

/** What a live update carries for one pool: the record, plus the key the page matches it to its row with. */
export interface LiveUpdate extends LiveRecord {
  key: string;
  /** When the index wrote it (ms). */
  at: number;
}

export interface LiveFields {
  priceUsd: number | null;
  priceFromReserves: boolean;
  txns24h: number | null;
  txnsCapped: boolean;
  volume24hUsd: number | null;
  traders24h: number | null;
  volumeUsd: Win<number | null>;
  txns: Win<number | null>;
  change: Win<number | null>;
  liquidityUsd: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const pct = (bps: unknown): number | null => {
  const n = num(bps);
  return n === null ? null : n / 100;
};

/** A number the index does not state stays null (drawn as a dash, or the grey 0.00% for a change), never zero. */
export function liveFieldsOf(p: LiveRecord, now: number): LiveFields {
  const traded = p.ro !== true && p.chg !== null && p.buys !== null && p.sells !== null;
  const last = num(p.last_trade_at);
  const quiet = (w: LiveWindow): boolean => traded && last !== null && now - last >= WINDOW_MS[w];
  const sum = (w: LiveWindow): number | null => (traded ? (quiet(w) ? 0 : p.buys![w] + p.sells![w]) : null);
  const win = <T>(pick: (w: LiveWindow) => T): Win<T> => ({ m5: pick('m5'), h1: pick('h1'), h6: pick('h6'), h24: pick('h24') });
  return {
    // A pool with no stored trade shows the price read from its reserves, marked as such; a traded price is never replaced by it.
    priceUsd: traded ? num(p.p_usd) : positive(p.rp),
    priceFromReserves: !traded && positive(p.rp) !== null,
    txns24h: sum('h24'),
    txnsCapped: p.cp === true,
    volume24hUsd: traded ? (quiet('h24') ? 0 : num(p.vol?.h24)) : null,
    traders24h: traded && !quiet('h24') ? num(p.mk) : null,
    volumeUsd: win((w) => (traded ? (quiet(w) ? 0 : num(p.vol?.[w])) : null)),
    txns: win(sum),
    change: win((w) => (traded && !quiet(w) ? pct(p.chg?.[w]) : null)),
    liquidityUsd: num(p.liquidity_usd),
  };
}

/** The fully diluted value after a price change: the row's own supply (its value over its price) at the new price, or null when it cannot be known. */
export function capAtPrice(row: Pick<MarketRow, 'priceUsd' | 'capUsd' | 'capIsFdv'>, newPrice: number | null, maxUsd = 1e12): number | null {
  if (row.capIsFdv !== true || row.capUsd === null || row.priceUsd === null || !(row.priceUsd > 0) || newPrice === null || !(newPrice > 0)) return null;
  const v = (row.capUsd / row.priceUsd) * newPrice;
  return Number.isFinite(v) && v > 0 && v <= maxUsd ? v : null;
}

/** A row with a live update applied: only the numbers that move with trades change, everything else (name, age, risk, icon) stays as it was. */
export function applyLive(row: MarketRow, u: LiveRecord, now: number): MarketRow {
  const f = liveFieldsOf(u, now);
  const capUsd = capAtPrice(row, f.priceUsd);
  const next: MarketRow = {
    ...row,
    priceUsd: f.priceUsd,
    txns24h: f.txns24h,
    volume24hUsd: f.volume24hUsd,
    traders24h: f.traders24h,
    volumeUsd: f.volumeUsd,
    txns: f.txns,
    change: f.change,
    liquidityUsd: f.liquidityUsd,
    capUsd: row.capIsFdv === true ? capUsd : row.capUsd,
  };
  if (f.priceFromReserves) next.priceFromReserves = true;
  else delete next.priceFromReserves;
  if (f.txnsCapped) next.txnsCapped = true;
  else delete next.txnsCapped;
  if (row.capIsFdv === true && capUsd === null) delete next.capIsFdv;
  return next;
}
