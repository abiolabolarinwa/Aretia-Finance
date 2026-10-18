/**
 * The Launch Box indexer. Run on a schedule (and, when it has gone quiet, once by a page visit) by the site's server: it reads each chain a
 * little further than last time and records every Aretia-created token it finds. Nothing a browser sends is ever used.
 *
 *  - EVM (BNB Chain, Ethereum, Polygon): the factory's TokenCreated events in confirmed blocks after the stored block number. Free public nodes
 *    refuse old log queries, so history is also rebuilt from the factory's own creation count (its contract nonce): token number n lives at
 *    a computable address, and its name, symbol, decimals and supply can be read from the chain at any time. That count is also a check:
 *    "expected" in the stats is how many tokens the factory has made, "indexed" how many are stored.
 *  - Solana: the fee wallet's signatures, newest first, with a forward edge (new activity) and a backward edge (history, a page at a time).
 *    A transaction is accepted only by acceptSolanaLaunch (core.ts).
 *
 * Safe to run twice or at once: stored tokens are never rewritten, and a cursor only moves after the tokens before it were stored. A node
 * error stops that chain for this run and leaves its cursor where it was.
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
  parseSolanaState,
  planBackfill,
  planForward,
  selector,
  serializeSolanaState,
  type EvmLaunchChain,
  type LaunchChain,
  type LaunchRecord,
  type ParsedTx,
} from './core.js';
import { MissingTableError, type LaunchStore } from './store.js';

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
}

/** Name, symbol, decimals and supply of a Token-2022 mint, read from its account (the metadata the creator wrote into the mint itself). */
export async function readSolanaMint(rpc: { call(method: string, params: unknown[]): Promise<unknown> }, mint: string): Promise<MintInfo | null> {
  const res = (await rpc.call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }])) as { value?: { owner?: string; data?: { parsed?: { info?: Record<string, unknown> } } } | null } | null;
  const v = res?.value;
  if (!v || v.owner !== TOKEN_2022_PROGRAM) return null;
  const info = v.data?.parsed?.info ?? {};
  const ext = Array.isArray(info.extensions) ? (info.extensions as { extension?: string; state?: { name?: string; symbol?: string } }[]).find((x) => x.extension === 'tokenMetadata') : undefined;
  const supply = typeof info.supply === 'string' && /^\d{1,80}$/.test(info.supply) ? info.supply : null;
  return { name: cleanText(String(ext?.state?.name ?? ''), 64), symbol: cleanText(String(ext?.state?.symbol ?? ''), 32), decimals: typeof info.decimals === 'number' ? info.decimals : null, supply };
}

export async function indexSolana(d: IndexerDeps, deadline: number): Promise<ChainReport> {
  const rpc = new Rpc(d.env.SOLANA_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com', d.fetchImpl);
  const report: ChainReport = { chain: 'solana', added: 0, cursor: null };
  const row = await d.store.getCursor('solana');
  let state = parseSolanaState(row?.cursor ?? null);
  report.cursor = serializeSolanaState(state);
  let unreadable = Number((row?.stats as { unreadable?: number } | null)?.unreadable ?? 0);

  const handlePage = async (page: SigInfo[]): Promise<void> => {
    const ok = page.filter((s) => !s.err);
    const records: LaunchRecord[] = [];
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
          const info = await readSolanaMint(rpc, hit.mint);
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
      await d.store.setCursor('solana', serializeSolanaState(state), d.now(), { unreadable });
    }
    for (let plan = planBackfill(state); plan && pages < SOLANA_MAX_PAGES && d.now() < deadline; plan = planBackfill(state), pages++) {
      const page = await list(plan);
      await handlePage(page);
      state = applyBackfill(state, page, SOLANA_PAGE);
      await d.store.setCursor('solana', serializeSolanaState(state), d.now(), { unreadable });
    }
    // A creation is two transactions; the supply is minted by the second. Read it again for recent tokens that still show none.
    const recent = (await d.store.list(300)).filter((t) => t.chain === 'solana' && (t.supply === null || t.supply === '0') && t.createdAt !== null && d.now() - t.createdAt < 3 * 86_400_000).slice(0, 10);
    for (const t of recent) {
      if (d.now() >= deadline) break;
      const info = await readSolanaMint(rpc, t.address);
      if (info && info.supply && info.supply !== '0') await d.store.patch('solana', t.address, { supply: info.supply, name: info.name || undefined, symbol: info.symbol || undefined });
    }
  } catch (e) {
    if (e instanceof MissingTableError) throw e;
    report.error = String(e instanceof Error ? e.message : e).slice(0, 200);
  }
  report.cursor = serializeSolanaState(state);
  return report;
}

// ---------------------------------------------------------------- all chains

export async function runIndexer(d: IndexerDeps): Promise<IndexerReport> {
  const deadline = d.now() + (d.budgetMs ?? 40_000);
  const chains = d.chains ?? (['bnb', 'ethereum', 'polygon', 'solana'] as const);
  const reports: ChainReport[] = [];
  try {
    // Chains are independent: a failing node for one does not stop the rest.
    for (const chain of chains) reports.push(chain === 'solana' ? await indexSolana(d, deadline) : await indexEvmChain(chain, d, deadline));
  } catch (e) {
    if (e instanceof MissingTableError) return { ok: false, chains: reports, missingTable: true };
    throw e;
  }
  return { ok: reports.every((r) => !r.error), chains: reports };
}
