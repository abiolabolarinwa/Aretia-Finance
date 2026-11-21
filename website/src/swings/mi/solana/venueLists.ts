/**
 * Where the pools that already exist are found. Aretia's index learns of a pool the moment it is created, but the pools made before it
 * was watching (BONK's, WIF's, every long-established token's) were never seen, so Top and Trending missed them.
 *
 * Each venue publishes the pools it holds, deepest first. Those lists are only HINTS about which addresses to look at: every pool found
 * here is read from the chain itself, its owner program checked and its account parsed with that program's layout, before the index
 * accepts it (known.ts). A wrong or missing entry in a list therefore costs a wasted read, never a wrong number.
 *
 * A venue can hold hundreds of thousands of pools (Meteora's DLMM alone has about 137,000), nearly all of them empty. "Complete" here means
 * every pool holding at least `minTvlUsd`, deepest first. One failing venue does not stop the others.
 */
import { isSolanaAddress } from './accounts.js';
import { PROGRAMS } from './track.js';

export interface Candidate {
  address: string;
  tvlUsd: number;
  source: string;
}

export interface ListOptions {
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  minTvlUsd: number;
  /** The most pools one venue gives. */
  maxPerSource: number;
}

const PAGE = 100;
/** Raydium lists pools of programs Aretia does not read (its stable pools); only these are kept. */
const RAYDIUM_PROGRAMS = new Set(Object.entries(PROGRAMS).filter(([, p]) => p.id.startsWith('raydium')).map(([program]) => program));

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

async function getJson(o: ListOptions, url: string): Promise<unknown> {
  const res = await o.fetchImpl(url, { signal: o.signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}.`);
  return res.json();
}

export interface ListSource {
  id: string;
  list(o: ListOptions): Promise<Candidate[]>;
}

/** Raydium: all its pool types in one list (AMM v4, CPMM, CLMM), deepest first, by page. */
export const raydiumList: ListSource = {
  id: 'raydium',
  async list(o) {
    const out: Candidate[] = [];
    for (let page = 1; out.length < o.maxPerSource; page++) {
      const body = (await getJson(o, `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=liquidity&sortType=desc&pageSize=${PAGE}&page=${page}`)) as { data?: { data?: { id?: string; programId?: string; tvl?: number }[]; hasNextPage?: boolean } };
      const rows = body?.data?.data;
      if (!Array.isArray(rows) || rows.length === 0) break;
      let below = false;
      for (const r of rows) {
        const tvl = num(r.tvl);
        if (tvl === null) continue;
        if (tvl < o.minTvlUsd) {
          below = true;
          continue;
        }
        if (typeof r.id === 'string' && isSolanaAddress(r.id) && typeof r.programId === 'string' && RAYDIUM_PROGRAMS.has(r.programId)) out.push({ address: r.id, tvlUsd: tvl, source: 'raydium' });
      }
      if (below || body.data?.hasNextPage !== true) break;
    }
    return out.slice(0, o.maxPerSource);
  },
};

/** Orca Whirlpools, deepest first, by cursor. */
export const orcaList: ListSource = {
  id: 'orca',
  async list(o) {
    const out: Candidate[] = [];
    let next: string | null = null;
    while (out.length < o.maxPerSource) {
      const url: string = `https://api.orca.so/v2/solana/pools?sortBy=tvl&sortDirection=desc&size=${PAGE}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
      const body = (await getJson(o, url)) as { data?: { address?: string; tvlUsdc?: string | number }[]; meta?: { cursor?: { next?: string | null } } };
      const rows = body?.data;
      if (!Array.isArray(rows) || rows.length === 0) break;
      let below = false;
      for (const r of rows) {
        const tvl = num(r.tvlUsdc);
        if (tvl === null) continue;
        if (tvl < o.minTvlUsd) {
          below = true;
          continue;
        }
        if (typeof r.address === 'string' && isSolanaAddress(r.address)) out.push({ address: r.address, tvlUsd: tvl, source: 'orca' });
      }
      next = body?.meta?.cursor?.next ?? null;
      if (below || !next) break;
    }
    return out.slice(0, o.maxPerSource);
  },
};

/** Meteora DLMM, deepest first, by page. */
export const meteoraDlmmList: ListSource = {
  id: 'meteora-dlmm',
  async list(o) {
    const out: Candidate[] = [];
    for (let page = 1; out.length < o.maxPerSource; page++) {
      const body = (await getJson(o, `https://dlmm.datapi.meteora.ag/pools?page=${page}&page_size=${PAGE}&sort_by=tvl:desc`)) as { data?: { address?: string; tvl?: number }[] };
      const rows = body?.data;
      if (!Array.isArray(rows) || rows.length === 0) break;
      let below = false;
      for (const r of rows) {
        const tvl = num(r.tvl);
        if (tvl === null) continue;
        if (tvl < o.minTvlUsd) {
          below = true;
          continue;
        }
        if (typeof r.address === 'string' && isSolanaAddress(r.address)) out.push({ address: r.address, tvlUsd: tvl, source: 'meteora-dlmm' });
      }
      if (below || rows.length < PAGE) break;
    }
    return out.slice(0, o.maxPerSource);
  },
};

export const LIST_SOURCES: readonly ListSource[] = [raydiumList, orcaList, meteoraDlmmList];

export interface Found {
  /** Every candidate, deepest first, one entry per address. */
  candidates: Candidate[];
  /** Sources that failed (the others are still used). */
  failed: string[];
  perSource: Record<string, number>;
}

/** All the sources, merged and ordered by depth. A failing source is reported, never thrown. */
export async function findCandidates(o: ListOptions, sources: readonly ListSource[] = LIST_SOURCES): Promise<Found> {
  const failed: string[] = [];
  const perSource: Record<string, number> = {};
  const all: Candidate[] = [];
  const got = await Promise.all(sources.map(async (s) => {
    try {
      return { id: s.id, rows: await s.list(o) };
    } catch {
      failed.push(s.id);
      return { id: s.id, rows: [] as Candidate[] };
    }
  }));
  for (const g of got) {
    perSource[g.id] = g.rows.length;
    all.push(...g.rows);
  }
  const seen = new Set<string>();
  const candidates = all
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .filter((c) => (seen.has(c.address) ? false : (seen.add(c.address), true)));
  return { candidates, failed, perSource };
}
