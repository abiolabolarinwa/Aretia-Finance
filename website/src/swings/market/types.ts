/**
 * One row of the token tables (Find Tokens and Marketplace). A row is one token as traded in one pool: the numbers
 * describe that pool, so they can differ from other venues. Numbers that a source does not give are null and shown as
 * a dash, never as zero.
 */
import type { ChainId } from '../core/types.js';

export interface Changes {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

export interface MarketRow {
  chain: ChainId;
  /** The token's address (the pool's first token). */
  address: string;
  symbol: string;
  /** The other side of the pool, for example "SOL" in PEPE / SOL. */
  quoteSymbol: string;
  name: string;
  icon: string | null;
  decimals: number | null;
  pool: string;
  priceUsd: number | null;
  /** Market cap when the source has one, otherwise fully diluted value. */
  capUsd: number | null;
  /** Pool age in milliseconds, or null when unknown. */
  ageMs: number | null;
  txns24h: number | null;
  volume24hUsd: number | null;
  /** People who traded in 24h (buyers plus sellers), when the source counts them. */
  traders24h: number | null;
  change: Changes;
  liquidityUsd: number | null;
  /** Share of the pool's liquidity proven burned, when Aretia checked and found some; otherwise null. */
  lockedPct?: number | null;
  /** How the liquidity is locked: burned (permanent) or held in a locker until a date. Absent means burned, as Aretia's records say. */
  lockInfo?: { kind: 'burned' | 'time-locked'; until: number | null; by?: string } | null;
  /** Aretia's own rating, only for tokens in its registry. */
  risk: { status: string; label: string; score: number | null; /** Where it came from: Aretia's registry, a live on-chain check, or market data alone. */ basis?: 'registry' | 'onchain' | 'market' } | null;
  /** In Aretia's registry of newly detected tokens. */
  fresh: boolean;
}

export type SortKey = 'cap' | 'price' | 'age' | 'txns' | 'volume' | 'traders' | 'm5' | 'h1' | 'h6' | 'h24' | 'liquidity';

const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/** A price the way trading screens write it: tiny prices show a count of zeros, like $0.0₄8793. */
export function formatPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n <= 0) return '–';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(n >= 100 ? 2 : 4).replace(/0+$/, '').replace(/\.$/, '')}`;
  if (n >= 0.0001) return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  const zeros = Math.ceil(-Math.log10(n)) - 1;
  const digits = Math.round(n * 10 ** (zeros + 5)).toString().slice(0, 4).replace(/0+$/, '') || '0';
  const count = String(zeros).split('').map((d) => SUBSCRIPT[Number(d)]).join('');
  return `$0.0${count}${digits}`;
}

/** Big money, short: $4.3M, $161K, $74. */
export function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2).replace(/\.?0+$/, '')}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.?0+$/, '')}K`;
  return `$${Math.round(n)}`;
}

export function compactCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** A percentage change with its sign. Very large ones are shortened (2,392% stays whole; 354000% becomes 354K%). */
export function formatChange(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const body = abs >= 100_000 ? `${Math.round(abs / 1000).toLocaleString('en-US')}K` : abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return `${n < 0 ? '-' : ''}${body}%`;
}

/** Pool age: 12m, 3h, 11d, 2y. */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '–';
  const m = ms / 60_000;
  if (m < 1) return '<1m';
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 365) return `${Math.floor(d)}d`;
  return `${Math.floor(d / 365)}y`;
}

const value = (r: MarketRow, key: SortKey): number | null => {
  switch (key) {
    case 'cap': return r.capUsd;
    case 'price': return r.priceUsd;
    case 'age': return r.ageMs;
    case 'txns': return r.txns24h;
    case 'volume': return r.volume24hUsd;
    case 'traders': return r.traders24h;
    case 'm5': return r.change.m5;
    case 'h1': return r.change.h1;
    case 'h6': return r.change.h6;
    case 'h24': return r.change.h24;
    case 'liquidity': return r.liquidityUsd;
  }
};

/** Sorts a copy by a column. Missing values always go last, whichever way it is sorted. Stable. */
export function sortRows(rows: readonly MarketRow[], key: SortKey, dir: 'asc' | 'desc'): MarketRow[] {
  return rows
    .map((r, i) => ({ r, i, v: value(r, key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return (dir === 'asc' ? a.v - b.v : b.v - a.v) || a.i - b.i;
    })
    .map((x) => x.r);
}
