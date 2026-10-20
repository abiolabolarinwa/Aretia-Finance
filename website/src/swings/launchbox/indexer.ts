/**
 * The Launch Box indexer. Run on a schedule (and, when it has gone quiet, once by a page visit) by the site's server: it reads each chain a
 * little further than last time and records every Aretia-created token it finds. Nothing a browser sends is ever used.
 *
 *  - EVM (BNB Chain, Ethereum, Polygon): the factory's TokenCreated events in confirmed blocks after the stored block number. Free public nodes
 *    refuse old log queries, so history is also rebuilt from the factory's own creation count (its contract nonce): token number n lives at
 *    a computable address, and its name, symbol, decimals and supply can be read from the chain at any time. That count is also a check:
 *    "expected" in the stats is how many tokens the factory has made, "indexed" how many are stored.
 *  - Solana: the fee wallet's signatures, newest first, with a forward edge (new activity) and a backward edge (history, a page at a time).
 *    A transaction is accepted only by acceptSolanaLaunch (core.ts), and its mint is stored with where it stands on the list: shown only
 *    once a read finds it keeping the rule Aretia's on-chain programs apply (supply minted, no mint or freeze authority, only the metadata
 *    extensions). A creation between its two transactions is stored as pending and not shown. Every Solana token is checked again, with
 *    its own share of the time: pending, hidden and unchecked ones first, then all of them a page at a time, carrying on from where the
 *    last run stopped. One that breaks the rule is hidden after two reads in a row (core.ts `nextListing`), never deleted, and comes back
 *    when a read finds it keeping the rule.
 *
 * Safe to run twice or at once: stored tokens are never rewritten (only unknown fields filled, Solana names refreshed, the listing state
 * of Solana tokens updated), and a cursor only moves after the tokens before it were stored. A node error stops that chain for this run
 * and leaves its cursor where it was.
 */
import {
  EVM_FACTORIES,
  SOLANA_FEE_WALLET,
  TOKEN_2022_PROGRAM,
  TOKEN_CREATED_TOPIC,
  acceptSolanaLaunch,
  applyBackfill,
  applyForward,
  cleanText,
  createAddress,
  decodeStringReturn,
  decodeTokenCreated,
  decodeUintReturn,
  evmWindow,
  nextListing,
  parseSolanaState,
  planBackfill,
  planForward,
  selector,
  sameListing,
  serializeSolanaState,
  UNCHECKED,
  type EvmLaunchChain,
  type LaunchChain,
  type LaunchRecord,
  type ParsedTx,
} from './core.js';
import { MissingTableError, type LaunchStore, type NewLaunch, type StoredLaunch } from './store.js';
import { mintRuleProblems, readRawMint } from '../tokens/token2022.js';

export interface IndexerEnv {
  SOLANA_RPC_URL?: string;
  EVM_RPC_BNB?: string;
  EVM_RPC_ETHEREUM?: string;
  EVM_RPC_POLYGON?: string;
}

export const PUBLIC_EVM_RPC: Readonly<Record<EvmLaunchChain, string>> = {
  bnb: 'https://bsc-rpc.publicnode.com',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
};
const ENV_KEY: Readonly<Record<EvmLaunchChain, keyof IndexerEnv>> = { bnb: 'EVM_RPC_BNB', ethereum: 'EVM_RPC_ETHEREUM', polygon: 'EVM_RPC_POLYGON' };
/** Blocks to wait for before trusting a log, per chain. */
const CONFIRMATIONS: Readonly<Record<EvmLaunchChain, number>> = { bnb: 3, ethereum: 2, polygon: 12 };
/** Blocks per log query: well inside what free nodes allow (Polygon refuses more than 10,000; BNB serves only the last few thousand). */
const SPAN = 2000;
/** On the first run, how far behind the latest block to start reading logs. Older tokens come from the creation count. */
const FIRST_LOOKBACK = 1000;
const MAX_WINDOWS = 25;
const MAX_NONCE_FILL = 20;
const SOLANA_PAGE = 100;
const SOLANA_MAX_PAGES = 8;

export interface IndexerDeps {
  store: LaunchStore;
  fetchImpl: typeof fetch;
  env: IndexerEnv;
  now: () => number;
  /** Milliseconds this run may keep starting new work. */
  budgetMs?: number;
  /** Milliseconds of that kept for re-checking stored Solana tokens (default RECHECK_SHARE of the budget). */
  recheckBudgetMs?: number;
  /** Which chains to read; default all. */
  chains?: readonly LaunchChain[];
}

export interface ChainReport {
  chain: LaunchChain;
  added: number;
  cursor: string | null;
  expected?: number;
  indexed?: number;
  error?: string;
  note?: string;
  /** Solana: what the re-check of stored tokens did this run. */
  recheck?: { checked: number; hidden: number; readmitted: number; error?: string };
}
export interface IndexerReport {
  ok: boolean;
  chains: ChainReport[];
  /** True when the Launch Box tables do not exist yet. */
  missingTable?: boolean;
}

// ---------------------------------------------------------------- JSON-RPC

class Rpc {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async call(method: string, params: unknown[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`The node answered ${res.status}.`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(String(body.error.message ?? 'The node refused the request.').slice(0, 160));
    return body.result;
  }
}

const hexNum = (n: number): string => '0x' + n.toString(16);
const pad32 = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');

// ---------------------------------------------------------------- EVM

export async function indexEvmChain(chain: EvmLaunchChain, d: IndexerDeps, deadline: number): Promise<ChainReport> {
  const own = d.env[ENV_KEY[chain]]?.trim();
  const rpc = new Rpc(own || PUBLIC_EVM_RPC[chain], d.fetchImpl);
  const factory = EVM_FACTORIES[chain];
  const report: ChainReport = { chain, added: 0, cursor: null };
  const row = await d.store.getCursor(chain);
  let cursor = row?.cursor ?? null;
  report.cursor = cursor;
  const notes: string[] = [];
  try {
    const latest = Number.parseInt(String(await rpc.call('eth_blockNumber', [])), 16);
    if (!Number.isSafeInteger(latest)) throw new Error('The node gave no block number.');
    for (let i = 0; i < MAX_WINDOWS && d.now() < deadline; i++) {
      const w = evmWindow(cursor, latest, CONFIRMATIONS[chain], SPAN, FIRST_LOOKBACK);
      if (!w) break;
      let logs: unknown;
      try {
        logs = await rpc.call('eth_getLogs', [{ address: factory, topics: [TOKEN_CREATED_TOPIC], fromBlock: hexNum(w.from), toBlock: hexNum(w.to) }]);
      } catch (e) {
        // A free node cannot answer for blocks this old. Skip to the recent window; the creation count below picks up what was skipped.
        const safe = latest - CONFIRMATIONS[chain];
        if (w.to < safe - 3 * SPAN && /archive|range|exceed|too (old|many)|limit|pruned|missing trie/i.test(String(e instanceof Error ? e.message : e))) {
          cursor = String(Math.max(w.to, safe - FIRST_LOOKBACK - 1));
          notes.push('Older blocks are not served by the node; earlier tokens come from the factory\'s creation count.');
          await d.store.setCursor(chain, cursor, d.now(), { note: notes.join(' ') });
          continue;
        }
        throw e;
      }
      if (!Array.isArray(logs)) throw new Error('The node gave no log list.');
      const found = logs.map((l) => decodeTokenCreated(chain, l as never)).filter((x): x is NonNullable<typeof x> => x !== null);
      const times = new Map<number, number>();
      for (const b of new Set(found.map((f) => f.blockNumber))) {
        const block = (await rpc.call('eth_getBlockByNumber', [hexNum(b), false])) as { timestamp?: string } | null;
        const ts = block?.timestamp ? Number.parseInt(block.timestamp, 16) : NaN;
        if (Number.isFinite(ts)) times.set(b, ts * 1000);
      }
      const records: LaunchRecord[] = found.map((f) => ({ chain, address: f.address, name: f.name, symbol: f.symbol, decimals: f.decimals, supply: f.supply, creator: f.creator, createdAt: times.get(f.blockNumber) ?? null, tx: f.tx, source: 'factory' }));
      report.added += await d.store.insertNew(records, d.now());
      cursor = String(w.to);
      await d.store.setCursor(chain, cursor, d.now(), null);
    }
    report.cursor = cursor;

    // Completeness: the factory has made `expected` tokens; fill in any that the log window did not cover.
    const nonce = Number.parseInt(String(await rpc.call('eth_getTransactionCount', [factory, 'latest'])), 16);
    if (!Number.isSafeInteger(nonce) || nonce < 1) throw new Error('The node gave no creation count.');
    const expected = nonce - 1;
    let indexed = await d.store.count(chain);
    if (indexed < expected && d.now() < deadline) {
      const all: string[] = [];
      for (let n = 1; n <= expected && n <= 5000; n++) all.push(createAddress(factory, BigInt(n)));
      const have = await d.store.existing(chain, all);
      const missing = all.filter((a) => !have.has(a)).slice(-MAX_NONCE_FILL);
      const records: LaunchRecord[] = [];
      for (const address of missing) {
        if (d.now() >= deadline) break;
        const rec = await readEvmToken(chain, rpc, address, own ? latest : null);
        if (rec) records.push(rec);
      }
      report.added += await d.store.insertNew(records, d.now());
      indexed = await d.store.count(chain);
    }
    report.expected = expected;
    report.indexed = indexed;
    await d.store.setCursor(chain, cursor, d.now(), { expected, indexed, note: notes.join(' ') || undefined });
    if (notes.length) report.note = notes.join(' ');
  } catch (e) {
    if (e instanceof MissingTableError) throw e;
    report.error = String(e instanceof Error ? e.message : e).slice(0, 200);
  }
  return report;
}

/** Reads one factory-made token from the chain: the log if the node can still serve it (a provider with history), otherwise name, symbol, decimals and supply by direct calls. */
async function readEvmToken(chain: EvmLaunchChain, rpc: Rpc, address: string, historyFrom: number | null): Promise<LaunchRecord | null> {
  const code = await rpc.call('eth_getCode', [address, 'latest']);
  if (typeof code !== 'string' || code === '0x') return null;
  if (historyFrom !== null) {
    try {
      const logs = await rpc.call('eth_getLogs', [{ address: EVM_FACTORIES[chain], topics: [TOKEN_CREATED_TOPIC, '0x' + pad32(address)], fromBlock: '0x0', toBlock: hexNum(historyFrom) }]);
      const first = Array.isArray(logs) ? logs.map((l) => decodeTokenCreated(chain, l as never)).find((x) => x !== null) : null;
      if (first) {
        const block = (await rpc.call('eth_getBlockByNumber', [hexNum(first.blockNumber), false])) as { timestamp?: string } | null;
        const ts = block?.timestamp ? Number.parseInt(block.timestamp, 16) : NaN;
        return { chain, address, name: first.name, symbol: first.symbol, decimals: first.decimals, supply: first.supply, creator: first.creator, createdAt: Number.isFinite(ts) ? ts * 1000 : null, tx: first.tx, source: 'factory' };
      }
    } catch {
      // Fall through to the direct reads.
    }
  }
  const call = (sig: string): Promise<unknown> => rpc.call('eth_call', [{ to: address, data: selector(sig) }, 'latest']);
  const [name, symbol, decimals, supply] = await Promise.all([call('name()'), call('symbol()'), call('decimals()'), call('totalSupply()')]);
  const dec = decodeUintReturn(decimals);
  const sup = decodeUintReturn(supply);
  return {
    chain,
    address,
    name: cleanText(decodeStringReturn(name) ?? '', 64),
    symbol: cleanText(decodeStringReturn(symbol) ?? '', 32),
    decimals: dec !== null && dec <= 255n ? Number(dec) : null,
    supply: sup !== null ? sup.toString() : null,
    creator: null,
    createdAt: null,
    tx: null,
    source: 'nonce',
  };
}

// ---------------------------------------------------------------- Solana

interface SigInfo {
  signature: string;
  err: unknown;
  blockTime?: number | null;
}

export interface MintInfo {
  name: string;
  symbol: string;
  decimals: number | null;
  supply: string | null;
  /** Why the mint breaks the launch rule (tokens/token2022.ts `mintRuleProblems`); empty when it keeps it. */
  problems: string[];
  /** The creation is not finished: nothing minted yet, or a mint authority is still set. Never shown while so. */
  pending: boolean;
}

/** A pending creation (the creator still holds the mint authority, nothing minted yet) is given this long to finish. */
const PENDING_MS = 3 * 86_400_000;

/** One mint account as `getAccountInfo` / `getMultipleAccounts` return it with base64 encoding. */
type RawAccount = { owner?: string; data?: [string, string] | unknown } | null | undefined;

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Name, symbol, decimals and supply of a Token-2022 mint, read from its raw bytes (the metadata the creator wrote into the mint itself),
 * and whether it keeps the rule Aretia's on-chain programs apply to a mint: no mint or freeze authority once minted, and no extension
 * but the metadata pointer and the metadata. Null when there is no such account.
 */
export function mintInfoOf(account: RawAccount, pendingCreator: string | null): MintInfo | null {
  if (!account || typeof account.owner !== 'string' || !Array.isArray(account.data) || typeof account.data[0] !== 'string') return null;
  let data: Uint8Array;
  try {
    data = fromBase64(account.data[0]);
  } catch {
    return null;
  }
  const problems = mintRuleProblems(account.owner, data, pendingCreator);
  const raw = account.owner === TOKEN_2022_PROGRAM ? readRawMint(data) : null;
  if (!raw) return { name: '', symbol: '', decimals: null, supply: null, problems: problems.length ? problems : ['not a readable mint'], pending: false };
  return { name: cleanText(raw.name ?? '', 64), symbol: cleanText(raw.symbol ?? '', 32), decimals: raw.decimals, supply: raw.supply.toString(), problems, pending: raw.supply === 0n || raw.mintAuthority !== null };
}

export async function readSolanaMint(rpc: { call(method: string, params: unknown[]): Promise<unknown> }, mint: string, pendingCreator: string | null = null): Promise<MintInfo | null> {
  const res = (await rpc.call('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }])) as { value?: RawAccount } | null;
  return mintInfoOf(res?.value, pendingCreator);
}

/** Rows re-checked per node request (getMultipleAccounts takes up to 100). */
const RECHECK_PAGE = 100;
/** The share of a run's budget kept for the re-check when the caller does not set one. */
const RECHECK_SHARE = 0.35;

/**
 * Checks stored Solana tokens against the launch rule again and moves each one on the list (core.ts `nextListing`): a pending creation is
 * shown once its supply is minted and the mint authority is gone, a token found breaking the rule twice in a row is hidden with the reason,
 * and a hidden one that keeps the rule again comes back. First every row that most needs a look (pending, hidden, never checked, failing,
 * nothing minted), then all rows a page at a time from where the last run stopped (`recheckAfter` in the cursor's stats), so no row is
 * left out however many there are. Supply, name and symbol are refreshed for tokens that keep the rule (a creator may hold the metadata
 * update authority).
 */
export async function recheckSolana(rpc: { call(method: string, params: unknown[]): Promise<unknown> }, d: IndexerDeps, deadline: number): Promise<NonNullable<ChainReport['recheck']>> {
  const out = { checked: 0, hidden: 0, readmitted: 0 };
  const seen = new Set<string>();
  const checkPage = async (rows: readonly StoredLaunch[]): Promise<void> => {
    const fresh = rows.filter((t) => !seen.has(t.address));
    if (fresh.length === 0) return;
    const res = (await rpc.call('getMultipleAccounts', [fresh.map((t) => t.address), { encoding: 'base64', commitment: 'confirmed' }])) as { value?: RawAccount[] } | null;
    if (!res || !Array.isArray(res.value) || res.value.length !== fresh.length) throw new Error('The node gave no account list.');
    for (const [n, t] of fresh.entries()) {
      seen.add(t.address);
      out.checked++;
      const pendingCreator = t.createdAt !== null && d.now() - t.createdAt < PENDING_MS ? t.creator : null;
      const info = mintInfoOf(res.value[n], pendingCreator);
      // No account: a node that lags or forgot is not proof of anything (a launch mint cannot be closed), so nothing changes.
      const next = nextListing(t, info && { problems: info.problems, pending: info.pending }, d.now());
      if (!sameListing(t, next)) {
        if (t.hiddenAt === null && next.hiddenAt !== null) out.hidden++;
        if (t.hiddenAt !== null && next.hiddenAt === null) out.readmitted++;
        await d.store.setListing('solana', t.address, next);
      }
      if (!info || info.problems.length > 0) continue;
      const fields: Parameters<LaunchStore['patch']>[2] = {};
      if (info.supply && info.supply !== '0' && info.supply !== t.supply) fields.supply = info.supply;
      if (info.name && info.name !== t.name) fields.name = info.name;
      if (info.symbol && info.symbol !== t.symbol) fields.symbol = info.symbol;
      if (Object.keys(fields).length > 0) await d.store.patch('solana', t.address, fields);
    }
  };
  // 1. The rows that most need a look, all of them.
  for (let after: string | null = null; d.now() < deadline; ) {
    const page = await d.store.listForCheck('solana', { afterKey: after, limit: RECHECK_PAGE, priority: true });
    await checkPage(page);
    if (page.length < RECHECK_PAGE) break;
    after = `solana:${page[page.length - 1]!.address}`;
  }
  // 2. Every row, a page at a time, continuing from where the last run stopped and starting over once at the end.
  const cursor = await d.store.getCursor('solana');
  const startedAt = typeof cursor?.stats?.recheckAfter === 'string' ? cursor.stats.recheckAfter : null;
  let after = startedAt;
  for (let wrapped = false; d.now() < deadline; ) {
    const page = await d.store.listForCheck('solana', { afterKey: after, limit: RECHECK_PAGE, priority: false });
    // Back at rows already checked this run: the whole table has been covered.
    if (wrapped && page.length > 0 && page.every((t) => seen.has(t.address))) break;
    await checkPage(page);
    if (page.length === RECHECK_PAGE) {
      after = `solana:${page[page.length - 1]!.address}`;
      continue;
    }
    after = null;
    if (wrapped || startedAt === null) break;
    wrapped = true;
  }
  const latest = await d.store.getCursor('solana');
  await d.store.setCursor('solana', latest?.cursor ?? null, d.now(), { ...(latest?.stats ?? {}), recheckAfter: after });
  return out;
}

/**
 * Reads the fee wallet's new and old signatures until `deadline`, then re-checks stored tokens with a budget of its own (`recheckMs`,
 * counted from when it starts), so a slow history read never leaves pending or hidden tokens unchecked.
 */
export async function indexSolana(d: IndexerDeps, deadline: number, recheckMs = d.recheckBudgetMs ?? 12_000): Promise<ChainReport> {
  const rpc = new Rpc(d.env.SOLANA_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com', d.fetchImpl);
  const report: ChainReport = { chain: 'solana', added: 0, cursor: null };
  const row = await d.store.getCursor('solana');
  let state = parseSolanaState(row?.cursor ?? null);
  report.cursor = serializeSolanaState(state);
  let unreadable = Number((row?.stats as { unreadable?: number } | null)?.unreadable ?? 0);
  let rejected = Number((row?.stats as { rejected?: number } | null)?.rejected ?? 0);
  // Other fields of the stats (the re-check's place) are kept when the reading part writes its own.
  const stats = (): Record<string, unknown> => ({ ...(row?.stats ?? {}) });

  const handlePage = async (page: SigInfo[]): Promise<void> => {
    const ok = page.filter((s) => !s.err);
    const records: NewLaunch[] = [];
    for (let i = 0; i < ok.length; i += 4) {
      const batch = await Promise.all(
        ok.slice(i, i + 4).map(async (s) => {
          const tx = (await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])) as ParsedTx | null;
          if (tx === null) {
            // Not available from this node. Very recent: try again next run (stop here). Old: count it, so the page can say some were unreadable.
            if (s.blockTime && d.now() / 1000 - s.blockTime < 600) throw new Error('A recent transaction is not available from the node yet.');
            unreadable++;
            return null;
          }
          const hit = acceptSolanaLaunch(tx, s.signature, SOLANA_FEE_WALLET);
          if (!hit) return null;
          // The mint itself must keep the launch rule; a creation still between its two transactions may hold the authority. Every
          // accepted creation is stored, with where it stands: not shown until a read finds it finished and keeping the rule, so a
          // creator who finishes late is listed then, and one node's wrong answer cannot lose a token for good.
          const pending = hit.blockTime === null || d.now() / 1000 - hit.blockTime < PENDING_MS / 1000 ? hit.creator : null;
          const info = await readSolanaMint(rpc, hit.mint, pending);
          if (info && info.problems.length > 0) rejected++;
          return { hit, info } as const;
        }),
      );
      for (const b of batch) {
        if (!b) continue;
        records.push({
          chain: 'solana',
          address: b.hit.mint,
          name: b.info?.name ?? '',
          symbol: b.info?.symbol ?? '',
          decimals: b.info?.decimals ?? b.hit.decimals,
          supply: b.info?.supply ?? null,
          creator: b.hit.creator,
          createdAt: b.hit.blockTime ? b.hit.blockTime * 1000 : null,
          tx: b.hit.signature,
          source: 'solana-fee',
          ...nextListing(UNCHECKED, b.info && { problems: b.info.problems, pending: b.info.pending }, d.now()),
        });
      }
    }
    report.added += await d.store.insertNew(records, d.now());
  };
  const list = async (opts: { before?: string; until?: string }): Promise<SigInfo[]> => {
    const got = await rpc.call('getSignaturesForAddress', [SOLANA_FEE_WALLET, { limit: SOLANA_PAGE, commitment: 'confirmed', ...opts }]);
    if (!Array.isArray(got)) throw new Error('The node gave no signature list.');
    return got as SigInfo[];
  };

  try {
    let pages = 0;
    for (let plan = planForward(state); plan && pages < SOLANA_MAX_PAGES && d.now() < deadline; plan = planForward(state), pages++) {
      const page = await list(plan);
      await handlePage(page);
      state = applyForward(state, page, SOLANA_PAGE);
      await d.store.setCursor('solana', serializeSolanaState(state), d.now(), { ...stats(), unreadable, rejected });
    }
    for (let plan = planBackfill(state); plan && pages < SOLANA_MAX_PAGES && d.now() < deadline; plan = planBackfill(state), pages++) {
      const page = await list(plan);
      await handlePage(page);
      state = applyBackfill(state, page, SOLANA_PAGE);
      await d.store.setCursor('solana', serializeSolanaState(state), d.now(), { ...stats(), unreadable, rejected });
    }
  } catch (e) {
    if (e instanceof MissingTableError) throw e;
    report.error = String(e instanceof Error ? e.message : e).slice(0, 200);
  }
  // A creation is two transactions; the supply is minted by the second. Stored tokens are checked again even when reading the history
  // failed: pending ones are shown once finished, and the listing of the rest is kept true (see recheckSolana).
  try {
    report.recheck = await recheckSolana(rpc, d, d.now() + recheckMs);
  } catch (e) {
    if (e instanceof MissingTableError) throw e;
    const error = String(e instanceof Error ? e.message : e).slice(0, 200);
    report.recheck = { checked: 0, hidden: 0, readmitted: 0, error };
    report.error ??= error;
  }
  report.cursor = serializeSolanaState(state);
  return report;
}

// ---------------------------------------------------------------- all chains

export async function runIndexer(d: IndexerDeps): Promise<IndexerReport> {
  const budget = d.budgetMs ?? 40_000;
  const chains = d.chains ?? (['bnb', 'ethereum', 'polygon', 'solana'] as const);
  // The Solana re-check has its own share of the time, so reading the chains can never use it up.
  const recheckMs = chains.includes('solana') ? (d.recheckBudgetMs ?? Math.round(budget * RECHECK_SHARE)) : 0;
  const deadline = d.now() + budget - recheckMs;
  const reports: ChainReport[] = [];
  try {
    // Chains are independent: a failing node for one does not stop the rest.
    for (const chain of chains) reports.push(chain === 'solana' ? await indexSolana(d, deadline, recheckMs) : await indexEvmChain(chain, d, deadline));
  } catch (e) {
    if (e instanceof MissingTableError) return { ok: false, chains: reports, missingTable: true };
    throw e;
  }
  return { ok: reports.every((r) => !r.error), chains: reports };
}
