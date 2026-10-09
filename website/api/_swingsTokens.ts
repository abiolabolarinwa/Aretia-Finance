/**
 * Server side of Aretia's token registry:
 *  - GET  /api/swings-tokens   read: search and the New Tokens list (browser origin allow-list, per-IP limit)
 *  - GET  /api/swings-discover run the discovery workers once (Authorization: Bearer CRON_SECRET only)
 *
 * The browser never sees database credentials: SUPABASE_SERVICE_ROLE_KEY lives in the server
 * environment. Without SUPABASE_URL and the key both endpoints answer 503 "not configured".
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit, PUBLIC_FALLBACK_RPC, type ProxyEnv } from './_rpcProxy.js';
import { CHAIN_IDS, isChainId, type ChainId } from '../src/swings/core/types.js';
import { TokenRegistryService, type RecentFilter } from '../src/swings/tokens/registry.js';
import { SupabaseTokenRepository } from '../src/swings/tokens/supabase.js';
import { TokenDiscoveryWorker, type TokenEnricher, type WorkerRun } from '../src/swings/tokens/discovery.js';
import { GeckoTerminalNewPoolsSource } from '../src/swings/tokens/sources/geckoTerminal.js';
import { sourceVerified, zeroXTokenTax } from '../src/swings/tokens/explorer.js';
import { EvmFactoryDiscoverySource } from '../src/swings/indexer/evmIndexer.js';
import { SolanaPoolDiscoverySource } from '../src/swings/indexer/solanaIndexer.js';
import { EVM_V2_DEXES } from '../src/swings/dex/entries.js';
import { publicRead } from '../src/swings/chains/evmSession.js';
import { EvmTokenEnricher, SolanaTokenEnricher } from '../src/swings/tokens/enrich.js';
import { fetchPoolMarkets, refreshSnapshots, type RefreshResult } from '../src/swings/market/snapshot.js';
import { checkLock } from '../src/swings/market/lock.js';
import { SupabaseTickStore, type TickInput } from '../src/swings/market/tickStore.js';
import type { RiskStatus, TokenMarket } from '../src/swings/core/types.js';

export interface TokensEnv extends ProxyEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
  /** Optional JSON-RPC endpoints for on-chain checks of EVM tokens. Without one, that chain's tokens get no risk assessment. */
  EVM_RPC_ETHEREUM?: string;
  EVM_RPC_BNB?: string;
  EVM_RPC_POLYGON?: string;
  EVM_RPC_BASE?: string;
  EVM_RPC_ARBITRUM?: string;
  EVM_RPC_OPTIMISM?: string;
  EVM_RPC_AVALANCHE?: string;
  /** Optional: Etherscan v2 key for contract-source verification, and the 0x key for token-tax data. */
  ETHERSCAN_API_KEY?: string;
  ZEROX_API_KEY?: string;
}

export interface TokensInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  query: Record<string, string | undefined>;
  env: TokensEnv;
  fetchImpl: typeof fetch;
  now: number;
}

export interface TokensOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

function repoFor(env: TokensEnv, fetchImpl: typeof fetch): SupabaseTokenRepository | null {
  const url = supabaseBase(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? new SupabaseTokenRepository(url, key, fetchImpl) : null;
}

const RISK_STATUSES: readonly RiskStatus[] = ['established', 'new', 'unverified', 'verified', 'elevated', 'high', 'restricted', 'unknown'];

/** Parses the public query string into a filter. Unknown values are ignored, not trusted. */
export function parseFilter(q: Record<string, string | undefined>): RecentFilter {
  const f: RecentFilter = {};
  if (q.chain && isChainId(q.chain)) f.chain = q.chain;
  const n = (v: string | undefined): number | undefined => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  const age = n(q.maxAgeHours);
  if (age !== undefined) f.maxAgeHours = age;
  const liq = n(q.minLiquidityUsd);
  if (liq !== undefined) f.minLiquidityUsd = liq;
  const vol = n(q.minVolumeUsd);
  if (vol !== undefined) f.minVolumeUsd = vol;
  const lim = n(q.limit);
  if (lim !== undefined) f.limit = Math.floor(lim);
  if (q.hideRisky === '1' || q.hideRisky === 'true') f.hideRisky = true;
  if (q.sort === 'newest' || q.sort === 'liquidity' || q.sort === 'volume') f.sort = q.sort;
  if (q.risk) {
    const wanted = q.risk.split(',').filter((s): s is RiskStatus => (RISK_STATUSES as readonly string[]).includes(s));
    if (wanted.length > 0) f.riskStatuses = wanted;
  }
  return f;
}

export async function handleTokens(input: TokensInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'GET, OPTIONS';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET, OPTIONS' });
  if (!allowed) return json(403, { error: 'origin' }, headers);
  const repo = repoFor(input.env, input.fetchImpl);
  if (!repo) return json(503, { error: 'not-configured', message: 'Token discovery is not configured on this server yet.' }, headers);
  if (overLimit(`tokens:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });

  const service = new TokenRegistryService(repo, () => input.now);
  try {
    if (input.query.q !== undefined) return json(200, { results: await service.search(input.query.q, 20) }, headers);
    // The ratings of tokens already on a screen: only what a table needs (rating and burned-liquidity share), by address.
    if (input.query.addresses !== undefined) {
      const wanted = [...new Set(input.query.addresses.split(',').map((a) => a.trim()).filter((a) => /^[A-Za-z0-9]{20,100}$/.test(a)))].slice(0, 80);
      const records = await repo.findByAddresses([...wanted, ...wanted.map((a) => a.toLowerCase())]);
      return json(200, { ratings: records.map((r) => ({ chain: r.ref.chain, address: r.ref.address, status: r.risk?.status ?? null, score: r.risk?.score ?? null, lockedPct: r.market?.lock && r.market.lock.pct >= 50 ? r.market.lock.pct : null })) }, headers);
    }
    return json(200, { tokens: await service.listNew(parseFilter(input.query)) }, headers);
  } catch (e) {
    // The status code only (for example 401 means the key was refused, 404 that the tables are missing). Never the body.
    const detail = e instanceof Error ? /answered (\d{3})/.exec(e.message)?.[1] ?? null : null;
    return json(502, { error: 'database', message: 'The token database could not be reached.', ...(detail ? { status: Number(detail) } : {}) }, headers);
  }
}

const EVM_ENV: Readonly<Record<Exclude<ChainId, 'solana'>, keyof TokensEnv>> = { ethereum: 'EVM_RPC_ETHEREUM', bnb: 'EVM_RPC_BNB', polygon: 'EVM_RPC_POLYGON', base: 'EVM_RPC_BASE', arbitrum: 'EVM_RPC_ARBITRUM', optimism: 'EVM_RPC_OPTIMISM', avalanche: 'EVM_RPC_AVALANCHE' };

function rpcFor(url: string, fetchImpl: typeof fetch) {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`RPC answered ${res.status}`);
    const out = (await res.json()) as { result?: T; error?: unknown };
    if (out.error !== undefined || out.result === undefined) throw new Error('RPC error');
    return out.result;
  };
}

const BUSY_CHAINS: ReadonlySet<ChainId> = new Set<ChainId>(['solana', 'ethereum', 'bnb', 'base']);

export async function handleDiscover(input: TokensInput): Promise<TokensOutput> {
  const headers = { 'cache-control': 'no-store' };
  const secret = input.env.CRON_SECRET?.trim();
  // Constant behaviour for a missing secret: nothing runs unless one is configured and presented.
  if (!secret || input.authorization !== `Bearer ${secret}`) return json(401, { error: 'unauthorized' }, headers);
  const repo = repoFor(input.env, input.fetchImpl);
  if (!repo) return json(503, { error: 'not-configured' }, headers);

  const registry = new TokenRegistryService(repo, () => input.now);
  const solanaRpc = rpcFor(input.env.SOLANA_RPC_URL?.trim() || PUBLIC_FALLBACK_RPC, input.fetchImpl);
  const runs: WorkerRun[] = [];
  // One worker shape for every chain; only the source's chain and the enricher differ.
  for (const chain of CHAIN_IDS) {
    let enricher: TokenEnricher | null = null;
    if (chain === 'solana') enricher = new SolanaTokenEnricher(solanaRpc, () => input.now);
    else {
      const url = input.env[EVM_ENV[chain]]?.trim();
      if (url) {
        enricher = new EvmTokenEnricher(rpcFor(url, input.fetchImpl), () => input.now, {
          sourceVerified: (c, a) => sourceVerified(input.fetchImpl, c, a, input.env.ETHERSCAN_API_KEY?.trim()),
          tax: (c, a) => zeroXTokenTax(input.fetchImpl, c, a, input.env.ZEROX_API_KEY?.trim()),
        });
      }
    }
    const worker = new TokenDiscoveryWorker(new GeckoTerminalNewPoolsSource(chain, input.fetchImpl), registry, repo, enricher, () => input.now);
    runs.push(await worker.runOnce());
    // Two more looks at the same network: a second page of new pools on the busiest networks, and the pools trading most
    // right now (which finds active tokens whose pool was created while no run was looking).
    const extra: GeckoTerminalNewPoolsSource[] = [new GeckoTerminalNewPoolsSource(chain, input.fetchImpl, { feed: 'trending' })];
    if (BUSY_CHAINS.has(chain)) extra.push(new GeckoTerminalNewPoolsSource(chain, input.fetchImpl, { page: 2 }));
    for (const source of extra) runs.push(await new TokenDiscoveryWorker(source, registry, repo, enricher, () => input.now).runOnce());
  }
  // Aretia's own feed: the factory events of each direct venue, read from confirmed blocks. It uses the same worker,
  // registry and cursors as the third-party feed above, and the same on-chain enrichment.
  for (const entry of EVM_V2_DEXES) {
    const url = input.env[EVM_ENV[entry.chain as Exclude<ChainId, 'solana'>]]?.trim();
    const read = url ? ((method: string, params: unknown[]) => rpcFor(url, input.fetchImpl)<unknown>(method, params)) : publicRead(entry.chain, input.fetchImpl);
    const enricher = url
      ? new EvmTokenEnricher(rpcFor(url, input.fetchImpl), () => input.now, {
          sourceVerified: (c, a) => sourceVerified(input.fetchImpl, c, a, input.env.ETHERSCAN_API_KEY?.trim()),
          tax: (c, a) => zeroXTokenTax(input.fetchImpl, c, a, input.env.ZEROX_API_KEY?.trim()),
        })
      : null;
    const worker = new TokenDiscoveryWorker(new EvmFactoryDiscoverySource(entry, read, { now: () => input.now }), registry, repo, enricher, () => input.now);
    runs.push(await worker.runOnce());
  }
  // Aretia's own Solana feed: pool-creation transactions of Raydium CPMM and Orca, decoded from finalized blocks.
  {
    const worker = new TokenDiscoveryWorker(new SolanaPoolDiscoverySource(() => import('@solana/web3.js'), solanaRpc, { now: () => input.now }), registry, repo, new SolanaTokenEnricher(solanaRpc, () => input.now), () => input.now);
    runs.push(await worker.runOnce());
  }
  // Keep the market numbers of recently detected tokens fresh: one request per network for the 30 stalest snapshots.
  // Each reading is also recorded as a price tick, and so are the pools people have opened a chart for in the last day.
  const refresh: Record<string, RefreshResult> = {};
  const supabaseUrl = supabaseBase(input.env.SUPABASE_URL);
  const ticks = supabaseUrl ? new SupabaseTickStore(supabaseUrl, input.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), input.fetchImpl) : null;
  const tickOf = (chain: ChainId, pool: string, m: TokenMarket): TickInput => ({ chain, pool: chain === 'solana' ? pool : pool.toLowerCase(), ts: m.at, price: m.priceUsd, liq: m.liquidityUsd, vol24: m.volume24hUsd });
  for (const chain of CHAIN_IDS) {
    const recorded: TickInput[] = [];
    if (repo.listForMarketRefresh) {
      try {
        const stale = await repo.listForMarketRefresh(chain, input.now - 7 * 86_400_000, 30);
        // A pool's burn status changes rarely, so it is looked at again only every six hours.
        const evmUrl = chain === 'solana' ? undefined : input.env[EVM_ENV[chain]]?.trim();
        const reads = { sol: chain === 'solana' ? solanaRpc : undefined, evm: chain === 'solana' ? undefined : evmUrl ? ((method: string, params: unknown[]) => rpcFor(evmUrl, input.fetchImpl)<unknown>(method, params)) : publicRead(chain, input.fetchImpl) };
        refresh[chain] = await refreshSnapshots(
          chain,
          stale,
          async (r, m) => {
            const known = r.market?.lock;
            const lock = known && input.now - known.at < 6 * 3_600_000 ? known : await checkLock(chain, m.pool, reads, input.now);
            await registry.setMarket(r.ref, lock ? { ...m, lock } : m);
            recorded.push(tickOf(chain, m.pool, m));
          },
          input.fetchImpl,
          input.now,
        );
      } catch {
        refresh[chain] = { asked: 0, updated: 0, error: 'The refresh list could not be read (has migration 0006 been run?).' };
      }
    }
    if (ticks) {
      try {
        const watched = await ticks.tracked(chain, input.now - 86_400_000, 30);
        const { markets } = await fetchPoolMarkets(chain, watched, input.fetchImpl, input.now);
        for (const m of markets.values()) recorded.push(tickOf(chain, m.pool, m));
        await ticks.add(recorded);
      } catch {
        // Price history is optional until migration 0007 has been run; discovery itself is unaffected.
      }
    }
  }
  if (ticks) await ticks.prune(input.now).catch(() => undefined);
  return json(200, { runs, refresh }, headers);
}
