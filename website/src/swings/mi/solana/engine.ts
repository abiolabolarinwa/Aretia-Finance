/**
 * The Solana indexing engine: one adapter (Raydium CPMM or Orca Whirlpools) per run.
 *
 * Discovery: the signatures of the accounts only pool creation touches (see indexer/solanaIndexer.ts) are listed since the last
 * run's cursor, their transactions fetched at `finalized` commitment, and the creation instruction decoded exactly. Swaps: for the
 * pools it follows, the signatures of the pool's quote token account are listed since that pool's cursor and each transaction is
 * decoded from the balance changes of the pool's two token accounts, the same for every venue (store/swaps.ts).
 *
 * Properties, each with a test in engine.test.ts:
 *  - finalized only, so there is no reorg to undo; failed transactions are ignored;
 *  - every cursor moves only after the data it covers was written; writes are idempotent, so a crash re-reads and duplicates nothing;
 *  - a creation window or a pool with more signatures than one run can read is paged back to the cursor, and if it still cannot
 *    reach it that is counted as `truncated` in health instead of being hidden;
 *  - amounts are bigints; prices are decimal-safe strings; USD only where the quote is a dollar stablecoin or SOL's price was read
 *    from the chain (Orca's SOL/USDC whirlpool).
 */
import type { MiChainConfig } from '../chains.js';
import { evaluate, FOLLOWED_STATES, type ListingRules } from '../lifecycle.js';
import { parseRaw, priceString, PRICE_SCALE, scaledToString } from '../math.js';
import type { LaunchLookup } from '../engine.js';
import type { RunReport } from '../engine.js';
import { RpcError, type Read } from '../rpc.js';
import { computeStats } from '../stats.js';
import type { MiStore } from '../store.js';
import { poolKeyOf, tokenKeyOf, type MiPool, type MiToken, type MiTrade } from '../types.js';
import { cleanText } from '../../tokens/safeText.js';
import { poolsCreatedIn, type CreatedPool } from '../../indexer/solanaIndexer.js';
import { decodeSolanaSwap, type ParsedTx, type TrackedPool } from '../../store/swaps.js';
import type { SolanaAdapterSpec } from '../dexes.js';
import { ammV4PoolsCreatedIn } from './ammv4.js';
import { pumpswapPoolsCreatedIn } from './pumpswap.js';
import { fromBase64, isSolanaAddress, metadataAddress, parseMetadata, parseMint, parseToken2022Metadata, parseWhirlpool, tokenAmount, whirlpoolPriceScaled } from './accounts.js';

export interface SolDeps {
  spec: SolanaAdapterSpec;
  chain: MiChainConfig;
  rpc: Read;
  store: MiStore;
  rules: ListingRules;
  now: () => number;
  launch?: LaunchLookup | null;
  /** Dollar value of one SOL, or null when it could not be read from the chain. */
  nativeUsd?: () => Promise<number | null>;
  budgetMs?: number;
  /** Signatures read per anchor account per page, and pages. */
  sigPage?: number;
  sigPages?: number;
  /** Creation transactions decoded per run. */
  maxCreationTx?: number;
  followNewest?: number;
  followRecent?: number;
  /** Signatures read per pool per run. */
  swapSigs?: number;
}

interface TxJson extends ParsedTx {
  slot?: number;
  transaction?: { message?: { instructions?: unknown[]; accountKeys?: ({ pubkey?: string; signer?: boolean } | string)[] } };
}

export interface SigInfo {
  signature: string;
  blockTime?: number | null;
  slot?: number;
  err?: unknown;
}

const TX_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' } as const;

/** getMultipleAccounts in slices of 100; null for an account that does not exist. */
export async function accounts(rpc: Read, addresses: readonly string[]): Promise<Map<string, Uint8Array | null>> {
  const out = new Map<string, Uint8Array | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const slice = addresses.slice(i, i + 100);
    const r = (await rpc('getMultipleAccounts', [slice, { encoding: 'base64', commitment: 'finalized' }])) as { value?: ({ data: [string, string] } | null)[] };
    if (!Array.isArray(r?.value)) throw new RpcError('malformed getMultipleAccounts answer', 'node-error');
    slice.forEach((a, k) => out.set(a, r.value![k] ? fromBase64(r.value![k]!.data[0]) : null));
  }
  return out;
}

const cursorKey = (spec: SolanaAdapterSpec): string => spec.id;
const poolCursorKey = (spec: SolanaAdapterSpec, pool: string): string => `${spec.id}|${pool}`;

export async function runSolanaAdapter(d: SolDeps): Promise<RunReport> {
  const t0 = d.now();
  const report: RunReport = { adapterId: d.spec.id, ok: true, skipped: null, head: null, safeHead: null, fromBlock: null, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 };
  let truncated = 0;
  let unavailable = 0;
  const finish = async (): Promise<RunReport> => {
    report.durationMs = d.now() - t0;
    await recordHealth(d, report, truncated, unavailable).catch(() => undefined);
    return report;
  };
  if ((await d.store.disabledAdapters()).has(d.spec.id)) {
    report.skipped = 'disabled';
    return finish();
  }
  const deadline = t0 + (d.budgetMs ?? 40_000);
  try {
    const slot = Number(await d.rpc('getSlot', [{ commitment: 'finalized' }]));
    if (!Number.isSafeInteger(slot)) throw new RpcError('malformed slot', 'node-error');
    report.head = slot;
    report.safeHead = slot;

    // ---- discovery
    const cp = await d.store.getCheckpoint(cursorKey(d.spec));
    let known: Record<string, string> = {};
    try {
      const parsed = cp ? (JSON.parse(cp.blockHash) as unknown) : null;
      if (parsed && typeof parsed === 'object') known = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(v as string))) as Record<string, string>;
    } catch {
      known = {};
    }
    const next: Record<string, string> = { ...known };
    const floor = Math.floor(d.now() / 1000) - d.chain.lookback;
    const fresh = new Map<string, { time: number; anchor: string }>();
    const newestSeen = new Map<string, string>();
    for (const anchor of d.spec.anchors) {
      let before: string | undefined;
      let reached = false;
      for (let page = 0; page < (d.sigPages ?? 3); page++) {
        const params: Record<string, unknown> = { limit: d.sigPage ?? 40, commitment: 'finalized' };
        if (known[anchor]) params.until = known[anchor];
        if (before) params.before = before;
        const sigs = (await d.rpc('getSignaturesForAddress', [anchor, params])) as SigInfo[];
        if (!Array.isArray(sigs)) throw new RpcError('malformed signatures', 'node-error');
        if (sigs.length > 0 && !newestSeen.has(anchor)) newestSeen.set(anchor, sigs[0]!.signature);
        for (const s of sigs) {
          if (s.err !== null && s.err !== undefined) continue;
          if (!known[anchor] && typeof s.blockTime === 'number' && s.blockTime < floor) continue;
          fresh.set(s.signature, { time: s.blockTime ?? 0, anchor });
        }
        if (sigs.length < (d.sigPage ?? 40)) {
          reached = true;
          break;
        }
        before = sigs[sigs.length - 1]!.signature;
        // A first run only wants the lookback window: stop paging once the page is older than it.
        if (!known[anchor] && (sigs[sigs.length - 1]!.blockTime ?? Number.MAX_SAFE_INTEGER) < floor) {
          reached = true;
          break;
        }
      }
      if (!reached) truncated++;
    }
    // Oldest first, capped. An anchor's cursor then moves to the newest signature that was actually read, so whatever the cap left
    // out is simply the next run's work (nothing is skipped, and re-reading what was done is harmless).
    const ordered = [...fresh].sort((x, y) => x[1].time - y[1].time);
    const maxTx = d.maxCreationTx ?? 30;
    const chosen = ordered.slice(0, maxTx);
    const chosenSet = new Set(chosen.map(([sig]) => sig));
    for (const anchor of d.spec.anchors) {
      const mine = ordered.filter(([, v]) => v.anchor === anchor);
      if (mine.length === 0) {
        const n = newestSeen.get(anchor);
        if (n) next[anchor] = n;
      } else if (mine.every(([sig]) => chosenSet.has(sig))) next[anchor] = newestSeen.get(anchor) ?? mine[mine.length - 1]![0];
      else {
        const done = mine.filter(([sig]) => chosenSet.has(sig));
        if (done.length > 0) next[anchor] = done[done.length - 1]![0];
      }
    }
    const created: { pool: CreatedPool; slot: number }[] = [];
    for (let i = 0; i < chosen.length; i += 4) {
      const txs = await Promise.all(chosen.slice(i, i + 4).map(async ([sig]) => ({ sig, tx: (await d.rpc('getTransaction', [sig, TX_OPTS])) as TxJson | null })));
      for (const { sig, tx } of txs) {
        if (tx === null) {
          unavailable++;
          continue;
        }
        const found = d.spec.family === 'pump' ? pumpswapPoolsCreatedIn(tx as never, sig) : d.spec.venue === 'Raydium AMM v4' ? ammV4PoolsCreatedIn(tx as never, sig) : poolsCreatedIn(tx as never, sig);
        for (const p of found) if (p.venue === d.spec.venue) created.push({ pool: p, slot: tx.slot ?? slot });
      }
    }
    report.creations = created.length;
    const tokenCache = new Map<string, TokenFacts | null>();
    for (const c of created) {
      if (d.now() > deadline) break;
      const r = await registerPool(d, c.pool, c.slot, tokenCache, report);
      void r;
    }

    // ---- swaps of followed pools
    const followed = await followedPools(d);
    const touched = new Set<string>();
    const stale = await staleness(d, followed);
    for (const pool of stale) {
      if (d.now() > deadline) break;
      const got = await followPool(d, pool, report);
      truncated += got.truncated ? 1 : 0;
      unavailable += got.unavailable;
      if (got.stored > 0 || got.read) touched.add(pool.key);
    }
    const toRefresh = new Map<string, MiPool>();
    for (const p of followed) if (touched.has(p.key)) toRefresh.set(p.key, p);
    // Pools that can change without a swap: the newest waiting ones.
    for (const p of await d.store.poolsOfAdapter(d.spec.id, ['validating', 'awaiting_liquidity'], 30, 'newest')) toRefresh.set(p.key, p);
    for (const p of toRefresh.values()) await refreshPool(d, p, tokenCache);

    // The creation cursor moves last, and only past what was fully read.
    await d.store.setCheckpoint({ adapterId: cursorKey(d.spec), block: slot, blockHash: JSON.stringify(next), updatedAt: d.now() });
    report.toBlock = slot;
    report.lagBlocks = 0;
  } catch (e) {
    report.ok = false;
    report.error = (e instanceof Error ? e.message : 'the run failed').slice(0, 300);
  }
  return finish();
}

export interface TokenFacts {
  decimals: number;
  symbol: string;
  name: string;
}

async function tokenFactsFor(d: SolDeps, mints: readonly string[], cache: Map<string, TokenFacts | null>): Promise<void> {
  const need = mints.filter((m) => !cache.has(m));
  if (need.length === 0) return;
  const meta = need.map((m) => metadataAddress(m));
  const got = await accounts(d.rpc, [...need, ...meta.filter((x): x is string => x !== null)]);
  need.forEach((m, i) => {
    const mint = got.get(m) ? parseMint(got.get(m)!) : null;
    if (!mint) return void cache.set(m, null);
    const md = meta[i] ? got.get(meta[i]!) : null;
    // Metaplex metadata account first; otherwise the name Token-2022 keeps inside the mint itself.
    const parsed = (md ? parseMetadata(md) : null) ?? parseToken2022Metadata(got.get(m)!);
    // A metadata account names its own mint; one that names another is ignored.
    const ok = parsed && parsed.mint === m ? parsed : null;
    cache.set(m, { decimals: mint.decimals, symbol: cleanText(ok?.symbol ?? '', 20), name: cleanText(ok?.name ?? '', 60) });
  });
}

export async function registerPool(d: SolDeps, c: CreatedPool, slot: number, cache: Map<string, TokenFacts | null>, report: RunReport): Promise<void> {
  const key = poolKeyOf('solana', c.pool);
  if ((await d.store.getPools([key])).has(key)) return;
  if (![c.pool, c.mintA, c.mintB, c.vaultA, c.vaultB].every(isSolanaAddress) || c.mintA === c.mintB) return;
  const quotes = d.chain.quoteTokens;
  const qA = quotes.find((q) => q.address === c.mintA);
  const qB = quotes.find((q) => q.address === c.mintB);
  let quoteIsB: boolean;
  if (qA && qB) quoteIsB = qB.role === 'usd' || qA.role !== 'usd';
  else quoteIsB = !qA;
  const [base, quote, baseVault, quoteVault] = quoteIsB ? [c.mintA, c.mintB, c.vaultA, c.vaultB] : [c.mintB, c.mintA, c.vaultB, c.vaultA];
  await tokenFactsFor(d, [base, quote], cache);
  const bf = cache.get(base) ?? null;
  const qf = cache.get(quote) ?? null;
  const readable = bf !== null && qf !== null;
  const now = d.now();
  const pool: MiPool = {
    key, chain: 'solana', address: c.pool, adapterId: d.spec.id, dex: d.spec.family, kind: d.spec.kind, feeTier: null, base, quote,
    baseDecimals: bf?.decimals ?? 0, quoteDecimals: qf?.decimals ?? 0, baseIsToken0: true, baseVault, quoteVault, tickSpacing: null, hooks: null, historyBlock: null, historyDone: c.signature !== 'tracked',
    createdBlock: slot, createdTx: c.signature, createdAt: c.blockTime * 1000, state: 'discovered', stateReason: 'creation seen', stateAt: now,
    reserveBase: null, reserveQuote: null, reserveBlock: null, firstTradeAt: null, lastTradeAt: null, paused: false, stats: null,
  };
  if (readable) {
    for (const [addr, f] of [[base, bf], [quote, qf]] as const) {
      const t: MiToken = { key: tokenKeyOf('solana', addr), chain: 'solana', address: addr, symbol: f.symbol, name: f.name, decimals: f.decimals, firstSeenAt: now, firstTradeAt: null, launchboxKey: null };
      if (await d.store.upsertToken(t)) report.tokensNew++;
    }
    if (d.launch) for (const [addr, lb] of await d.launch.find('solana', [base, quote])) await d.store.setTokenLaunchbox(tokenKeyOf('solana', addr), lb);
  }
  const recognised = Boolean(qA || qB);
  const reserves = readable && recognised ? await readReserves(d, pool) : null;
  if (reserves) Object.assign(pool, { reserveBase: reserves.base.toString(), reserveQuote: reserves.quote.toString() });
  const ev = evaluate('discovered', await factsOf(d, pool, readable, recognised, reserves), d.rules, now);
  pool.state = ev.state;
  pool.stateReason = ev.reason;
  if (await d.store.insertPool(pool)) report.poolsNew++;
}

async function readReserves(d: SolDeps, pool: MiPool): Promise<{ base: bigint; quote: bigint } | null> {
  const got = await accounts(d.rpc, [pool.baseVault!, pool.quoteVault!]);
  const b = got.get(pool.baseVault!) ? tokenAmount(got.get(pool.baseVault!)!) : null;
  const q = got.get(pool.quoteVault!) ? tokenAmount(got.get(pool.quoteVault!)!) : null;
  return b !== null && q !== null ? { base: b, quote: q } : null;
}

async function quoteUsdOf(d: SolDeps, pool: MiPool): Promise<number | null> {
  const q = d.chain.quoteTokens.find((x) => x.address === pool.quote);
  if (!q) return null;
  return q.role === 'usd' ? 1 : d.nativeUsd ? await d.nativeUsd() : null;
}

async function factsOf(d: SolDeps, pool: MiPool, readable: boolean, recognised: boolean, reserves: { base: bigint; quote: bigint } | null) {
  const usd = await quoteUsdOf(d, pool);
  return {
    tokensReadable: readable,
    quoteRecognised: recognised,
    reserveBase: reserves ? reserves.base : null,
    reserveQuote: reserves ? reserves.quote : null,
    liquidityUsd: reserves && usd !== null ? (Number(reserves.quote) / 10 ** pool.quoteDecimals) * 2 * usd : null,
    createdAt: pool.createdAt,
    firstSeenAt: pool.stateAt,
    lastTradeAt: pool.lastTradeAt,
    paused: pool.paused,
  };
}

async function followedPools(d: SolDeps): Promise<MiPool[]> {
  const a = await d.store.poolsOfAdapter(d.spec.id, FOLLOWED_STATES, d.followNewest ?? 40, 'newest');
  const b = await d.store.poolsOfAdapter(d.spec.id, FOLLOWED_STATES, d.followRecent ?? 40, 'recent-trade');
  return [...new Map([...a, ...b].map((p) => [p.key, p])).values()];
}

/** Followed pools, the one read longest ago first, so a run that runs out of time moves on to the others next time. */
async function staleness(d: SolDeps, pools: readonly MiPool[]): Promise<MiPool[]> {
  const ages = await Promise.all(pools.map(async (p) => ({ p, at: (await d.store.getCheckpoint(poolCursorKey(d.spec, p.address)))?.updatedAt ?? 0 })));
  return ages.sort((x, y) => x.at - y.at).map((x) => x.p);
}

interface Followed {
  stored: number;
  read: boolean;
  truncated: boolean;
  unavailable: number;
  oldest?: string | null;
  exhausted?: boolean;
}

/** Trades from a list of signatures that touched a pool's quote token account: each transaction is read and decoded from the pool's balance changes. */
export async function tradesFromSignatures(d: SolDeps, pool: MiPool, sigs: readonly SigInfo[], report: RunReport): Promise<{ trades: MiTrade[]; unavailable: number }> {
  const tracked: TrackedPool = { chain: 'solana', pool: pool.address, venue: d.spec.family, baseMint: pool.base, quoteMint: pool.quote, baseDecimals: pool.baseDecimals, quoteDecimals: pool.quoteDecimals, baseVault: pool.baseVault!, quoteVault: pool.quoteVault! };
  const trades: MiTrade[] = [];
  let unavailable = 0;
  const wanted = sigs.filter((s) => s.err === null || s.err === undefined);
  for (let i = 0; i < wanted.length; i += 4) {
    const txs = await Promise.all(wanted.slice(i, i + 4).map(async (s) => ({ s, tx: (await d.rpc('getTransaction', [s.signature, TX_OPTS])) as TxJson | null })));
    for (const { s, tx } of txs) {
      if (tx === null) {
        unavailable++;
        continue;
      }
      const rec = decodeSolanaSwap(tx, s.signature, tracked);
      report.swapsSeen += rec ? 1 : 0;
      if (!rec) continue;
      const base = parseRaw(rec.baseAmount);
      const quote = parseRaw(rec.quoteAmount);
      const price = base !== null && quote !== null ? priceString(base, pool.baseDecimals, quote, pool.quoteDecimals) : null;
      if (price === null) continue;
      const first = tx.transaction?.message?.accountKeys?.[0];
      const maker = typeof first === 'string' ? first : (first?.pubkey ?? '');
      trades.push({ chain: 'solana', pool: pool.address, id: rec.id, block: tx.slot ?? rec.seq, blockHash: '', time: rec.time, side: rec.side, baseAmount: rec.baseAmount, quoteAmount: rec.quoteAmount, price, maker });
    }
  }
  return { trades, unavailable };
}

export async function followPool(d: SolDeps, pool: MiPool, report: RunReport): Promise<Followed> {
  const cp = await d.store.getCheckpoint(poolCursorKey(d.spec, pool.address));
  const until = cp?.blockHash && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(cp.blockHash) ? cp.blockHash : undefined;
  const limit = d.swapSigs ?? 50;
  const params: Record<string, unknown> = { limit, commitment: 'finalized' };
  if (until) params.until = until;
  const sigs = (await d.rpc('getSignaturesForAddress', [pool.quoteVault!, params])) as SigInfo[];
  if (!Array.isArray(sigs)) throw new RpcError('malformed signatures', 'node-error');
  const { trades, unavailable } = await tradesFromSignatures(d, pool, sigs, report);
  const stored = await d.store.putTrades(d.spec.id, trades);
  report.tradesNew += stored;
  // The pool's cursor moves only after its trades were written. A pool with a failed fetch keeps the old cursor so it is read again.
  if (sigs.length > 0 && unavailable === 0) await d.store.setCheckpoint({ adapterId: poolCursorKey(d.spec, pool.address), block: sigs[0]!.slot ?? 0, blockHash: sigs[0]!.signature, updatedAt: d.now() });
  else await d.store.setCheckpoint({ adapterId: poolCursorKey(d.spec, pool.address), block: cp?.block ?? 0, blockHash: cp?.blockHash ?? '', updatedAt: d.now() });
  // `oldest` and `exhausted` say how far back this read reached: a first read that returned fewer signatures than asked for has the pool's whole history.
  return { stored, read: sigs.length > 0, truncated: sigs.length >= limit && until !== undefined, unavailable, oldest: sigs.length ? sigs[sigs.length - 1]!.signature : null, exhausted: until === undefined && sigs.length < limit && unavailable === 0 };
}

export async function refreshPool(d: SolDeps, pool: MiPool, cache: Map<string, TokenFacts | null>): Promise<void> {
  const now = d.now();
  const stored = (await d.store.getPools([pool.key])).get(pool.key) ?? pool;
  const since = Math.floor(now / 1000) - 86_400;
  const [recent, prior] = await Promise.all([d.store.tradesSince('solana', stored.address, since, 5_000), d.store.lastTradeBefore('solana', stored.address, since)]);
  const last = recent.length ? recent[recent.length - 1]!.time * 1000 : stored.lastTradeAt;
  const first = recent.length ? Math.min(stored.firstTradeAt ?? Infinity, recent[0]!.time * 1000) : stored.firstTradeAt;
  const live: MiPool = { ...stored, firstTradeAt: first, lastTradeAt: last };
  await tokenFactsFor(d, [live.base, live.quote], cache);
  const readable = (cache.get(live.base) ?? null) !== null && (cache.get(live.quote) ?? null) !== null;
  const recognised = d.chain.quoteTokens.some((q) => q.address === live.base || q.address === live.quote);
  const reserves = readable && recognised ? await readReserves(d, live) : null;
  const ev = evaluate(live.state, await factsOf(d, live, readable, recognised, reserves), d.rules, now);
  const quoteUsd = await quoteUsdOf(d, live);
  const stats = computeStats(live, recent, prior, now, { quoteUsd }, reserves ? reserves.quote : parseRaw(live.reserveQuote));
  const patch: Partial<MiPool> = { firstTradeAt: first, lastTradeAt: last, stats, ...(reserves ? { reserveBase: reserves.base.toString(), reserveQuote: reserves.quote.toString() } : {}) };
  if (ev.state !== stored.state) Object.assign(patch, { state: ev.state, stateReason: ev.reason, stateAt: now });
  await d.store.updatePool(live.key, patch);
  if (first !== null) await d.store.setTokenFirstTrade(tokenKeyOf('solana', live.base), first);
}

async function recordHealth(d: SolDeps, r: RunReport, truncated: number, unavailable: number): Promise<void> {
  const prev = (await d.store.listHealth()).find((h) => h.adapterId === d.spec.id);
  const cp = await d.store.getCheckpoint(cursorKey(d.spec));
  const now = d.now();
  await d.store.putHealth({
    adapterId: d.spec.id,
    chain: 'solana',
    head: r.head,
    safeHead: r.safeHead,
    checkpoint: cp?.block ?? null,
    lagBlocks: r.safeHead !== null && cp ? Math.max(0, r.safeHead - cp.block) : null,
    lastRunAt: now,
    lastSuccessAt: r.ok ? now : (prev?.lastSuccessAt ?? null),
    lastError: r.ok ? null : r.error,
    consecutiveFailures: r.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    stats: { creations: r.creations, poolsNew: r.poolsNew, tokensNew: r.tokensNew, swapsSeen: r.swapsSeen, tradesNew: r.tradesNew, truncated, unavailable, durationMs: r.durationMs },
  });
}

/** SOL's dollar price from Orca's SOL/USDC whirlpool, read from the chain. Null when it cannot be read or is not that pool. */
export const ORCA_SOL_USDC_WHIRLPOOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
export function solUsdReader(rpc: Read, now: () => number, ttlMs = 60_000): () => Promise<number | null> {
  let cached: { at: number; value: number | null } | null = null;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    let value: number | null;
    try {
      const got = await accounts(rpc, [ORCA_SOL_USDC_WHIRLPOOL]);
      const w = got.get(ORCA_SOL_USDC_WHIRLPOOL) ? parseWhirlpool(got.get(ORCA_SOL_USDC_WHIRLPOOL)!) : null;
      // Only this exact pair is trusted: WSOL as token A and USDC as token B, 9 and 6 decimals.
      const p = w && w.mintA === 'So11111111111111111111111111111111111111112' && w.mintB === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? whirlpoolPriceScaled(w.sqrtPrice, 9, 6, PRICE_SCALE) : null;
      value = p === null ? null : Number(scaledToString(p));
    } catch {
      value = cached?.value ?? null;
    }
    cached = { at: now(), value };
    return value;
  };
}
