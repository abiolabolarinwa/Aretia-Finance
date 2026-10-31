/**
 * Aretia RPC Pool: what a paid node plan gives (capacity, steadiness, no dead ends), made from the free public nodes by sharing
 * the work among them with manners.
 *
 * What it does, and why each part exists:
 *  - Spreads requests over every node it is given, weighted by how fast and how healthy each has been, so the allowance of each free
 *    node is used instead of hammering the first one until it refuses.
 *  - Keeps a polite budget per node (requests per second, requests in flight). A node that answers 429 or "slow down" is left alone for
 *    a while (its own Retry-After if it says one, otherwise a growing pause) rather than asked again at once. It never goes round a
 *    limit: it stays inside each node's.
 *  - Learns what each node cannot do: a node that refuses `eth_getLogs`, or only for wide block ranges, or says a method is not
 *    available, is not asked that again for a while (ranges: it remembers the widest range a node has accepted), and another node is.
 *  - Answers the same question once: identical requests in flight at the same moment share one call, and answers that cannot change (an
 *    old block, a receipt, finished log ranges) or barely change (the chain head, for a second) are kept for a short while.
 *  - Fails over: a transport failure, 429, 5xx or a node saying "try again" moves on to another node within a time budget.
 *
 * What it cannot do, plainly: it cannot make the free nodes keep more history or serve bigger log ranges than they offer, and it
 * cannot beat their combined allowance. It raises the ceiling by using all of them well and by asking less often; a paid node
 * still has a higher ceiling and a promise.
 *
 * Pure apart from the injected `fetchImpl`, clock and sleep, so it is tested without a network.
 */

export interface RpcBody {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly kind: 'node-error' | 'transport',
  ) {
    super(message);
  }
}

/** A node's error text that means "slow down" rather than "your request is wrong": never read as an answer. */
export const RATE_LIMITED = /rate.?limit|too many requests|limit exceeded|throttl|capacity|try again|temporarily|overloaded|timeout|timed out|reached.*limit|request limit/i;
/** Error text that means the log range or result set was too big: the caller halves the range. */
export const RANGE_TOO_BIG = /more than \d+ results|block range|range (is )?too|ranges over|too (many|large|wide|big)|exceeds? (the )?(max|limit)|query (returned|timeout)/i;
/** This node cannot answer this request (a method it does not offer, history it does not keep): another node may. */
export const NODE_CANNOT = /not supported|method not found|unsupported|not available|missing trie node|header not found|archive|is not allowed|limited to 0|not enabled|request blocked|not authorized|unauthorized|access denied|apikey|api key/i;

export const classifyNodeError = (message: string): 'transport' | 'node-error' => (RANGE_TOO_BIG.test(message) ? 'node-error' : RATE_LIMITED.test(message) ? 'transport' : 'node-error');

export type EndpointInput = string | { url: string; /** requests per second for this node */ rps?: number; /** bigger means asked more often */ weight?: number };

export interface PoolOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Most nodes tried for one request. */
  attempts?: number;
  /** Requests per second each node is given unless it says otherwise. */
  rps?: number;
  /** Requests one node may have in flight at once. */
  maxInFlight?: number;
  /** The most time one request may spend waiting for a node and being retried. */
  budgetMs?: number;
  /** false switches the answer cache off (the in-flight sharing stays). */
  cache?: boolean;
}

export interface EndpointHealth {
  url: string;
  state: 'ok' | 'cooling' | 'blocked-for-some-methods';
  coolingForMs: number;
  avgMs: number | null;
  ok: number;
  failed: number;
  limited: number;
  widestLogRange: number | null;
}

interface Endpoint {
  url: string;
  host: string;
  rps: number;
  weight: number;
  tokens: number;
  refilledAt: number;
  inFlight: number;
  cooldownUntil: number;
  failStreak: number;
  avgMs: number | null;
  blocked: Map<string, number>;
  /** Widest `eth_getLogs` block range a node has accepted without complaint, and the narrowest it refused (Infinity until learned). */
  logRangeMax: number;
  /** When what was learned about the log range is forgotten (nodes change their limits, and a refusal may have been a bad moment). */
  logRangeUntil: number;
  ok: number;
  failed: number;
  limited: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** How many blocks a getLogs request spans, or 0 when it is not a plain numeric range. */
export function logRangeOf(method: string, params: unknown[]): number {
  if (method !== 'eth_getLogs') return 0;
  const f = (params[0] as { fromBlock?: unknown; toBlock?: unknown } | undefined) ?? {};
  const from = typeof f.fromBlock === 'string' && /^0x[0-9a-f]+$/i.test(f.fromBlock) ? Number.parseInt(f.fromBlock, 16) : NaN;
  const to = typeof f.toBlock === 'string' && /^0x[0-9a-f]+$/i.test(f.toBlock) ? Number.parseInt(f.toBlock, 16) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from + 1 : 0;
}

/** How long an answer may be reused, in milliseconds (0: never). Only answers that cannot change, or barely change, are kept. */
export function cacheTtlMs(method: string, params: unknown[], body: RpcBody): number {
  if (body.error || body.result === undefined || body.result === null) return 0;
  switch (method) {
    // EVM
    case 'eth_chainId':
    case 'net_version':
      return 3_600_000;
    case 'eth_blockNumber':
      return 1_500;
    case 'eth_gasPrice':
      return 3_000;
    case 'eth_getBlockByNumber':
      return typeof params[0] === 'string' && /^0x[0-9a-f]+$/i.test(params[0]) ? 600_000 : 0;
    case 'eth_getBlockByHash':
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
      return 600_000;
    case 'eth_getLogs': {
      const f = (params[0] as { toBlock?: unknown } | undefined) ?? {};
      // A range that ends at a number (the indexer reads only blocks already buried under its confirmations) cannot change.
      return typeof f.toBlock === 'string' && /^0x[0-9a-f]+$/i.test(f.toBlock) ? 300_000 : 0;
    }
    // Solana
    case 'getSlot':
    case 'getBlockHeight':
      return 400;
    case 'getLatestBlockhash':
      return 1_000;
    case 'getEpochInfo':
      return 5_000;
    case 'getMinimumBalanceForRentExemption':
      return 600_000;
    case 'getRecentPrioritizationFees':
      return 4_000;
    case 'getTransaction':
      return 600_000;
    default:
      return 0;
  }
}

const cacheKey = (method: string, params: unknown[]): string => `${method}|${JSON.stringify(params)}`;

export class RpcPool {
  private readonly eps: Endpoint[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly maxInFlight: number;
  private readonly budgetMs: number;
  private readonly useCache: boolean;
  private readonly answers = new Map<string, { at: number; ttl: number; body: RpcBody }>();
  private readonly inFlight = new Map<string, Promise<RpcBody>>();
  private id = 0;

  constructor(urls: readonly EndpointInput[], o: PoolOptions = {}) {
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.random = o.random ?? Math.random;
    this.timeoutMs = o.timeoutMs ?? 6_000;
    this.attempts = o.attempts ?? 6;
    this.maxInFlight = o.maxInFlight ?? 3;
    this.budgetMs = o.budgetMs ?? 25_000;
    this.useCache = o.cache !== false;
    const rps = o.rps ?? 4;
    const t = this.now();
    const seen = new Set<string>();
    this.eps = [];
    for (const u of urls) {
      const spec = typeof u === 'string' ? { url: u } : u;
      if (seen.has(spec.url)) continue;
      seen.add(spec.url);
      const r = spec.rps ?? rps;
      this.eps.push({ url: spec.url, host: hostOf(spec.url), rps: r, weight: spec.weight ?? 1, tokens: Math.max(1, r * 2), refilledAt: t, inFlight: 0, cooldownUntil: 0, failStreak: 0, avgMs: null, blocked: new Map(), logRangeMax: Infinity, logRangeUntil: 0, ok: 0, failed: 0, limited: 0 });
    }
  }

  /** What an operator can read about each node: never the full address (a node address can carry a key). */
  health(): EndpointHealth[] {
    const t = this.now();
    return this.eps.map((e) => ({
      url: e.host,
      state: e.cooldownUntil > t ? 'cooling' : [...e.blocked.values()].some((u) => u > t) ? 'blocked-for-some-methods' : 'ok',
      coolingForMs: Math.max(0, e.cooldownUntil - t),
      avgMs: e.avgMs === null ? null : Math.round(e.avgMs),
      ok: e.ok,
      failed: e.failed,
      limited: e.limited,
      widestLogRange: Number.isFinite(e.logRangeMax) ? e.logRangeMax : null,
    }));
  }

  /** The reader the rest of the code uses: the answer, or an RpcError (a node's own error is a 'node-error', never retried). */
  readonly read = async (method: string, params: unknown[]): Promise<unknown> => {
    const body = await this.call(method, params);
    if (body.error) {
      const text = String(body.error.message ?? 'node error').slice(0, 200);
      throw new RpcError(text, classifyNodeError(text) === 'transport' ? 'transport' : 'node-error');
    }
    return body.result;
  };

  /** The raw JSON-RPC reply (a result, or a node's own error), after failing over. Throws RpcError('transport') when no node could answer. */
  call(method: string, params: unknown[]): Promise<RpcBody> {
    const key = cacheKey(method, params);
    if (this.useCache) {
      const hit = this.answers.get(key);
      if (hit && this.now() - hit.at < hit.ttl) return Promise.resolve(hit.body);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = this.callUncached(method, params)
      .then((body) => {
        const ttl = this.useCache ? cacheTtlMs(method, params, body) : 0;
        if (ttl > 0) {
          if (this.answers.size > 2_000) this.answers.clear();
          this.answers.set(key, { at: this.now(), ttl, body });
        }
        return body;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  // ------------------------------------------------------------------ choosing a node

  private refill(e: Endpoint, t: number): void {
    const cap = Math.max(1, e.rps * 2);
    e.tokens = Math.min(cap, e.tokens + ((t - e.refilledAt) / 1000) * e.rps);
    e.refilledAt = t;
  }

  private usable(e: Endpoint, method: string, range: number, t: number): boolean {
    if (e.logRangeMax !== Infinity && t >= e.logRangeUntil) e.logRangeMax = Infinity;
    return (e.blocked.get(method) ?? 0) <= t && e.logRangeMax >= range;
  }

  /** The node to use now, waiting briefly if every usable one is cooling or out of budget. Null when none can serve this request in time. */
  private async acquire(method: string, range: number, exclude: Set<Endpoint>, deadline: number): Promise<Endpoint | null> {
    for (;;) {
      const t = this.now();
      for (const e of this.eps) this.refill(e, t);
      const candidates = this.eps.filter((e) => !exclude.has(e) && this.usable(e, method, range, t));
      if (candidates.length === 0) return null;
      const ready = candidates.filter((e) => e.cooldownUntil <= t && e.tokens >= 1 && e.inFlight < this.maxInFlight);
      if (ready.length > 0) {
        // Weighted by speed and health, with some chance for every ready node, so load spreads rather than piling on the fastest.
        const weights = ready.map((e) => e.weight * (1 / ((e.avgMs ?? 800) + 100)) * 0.5 ** Math.min(e.failStreak, 6));
        const total = weights.reduce((a, b) => a + b, 0);
        let pick = this.random() * total;
        let chosen = ready[ready.length - 1]!;
        for (let i = 0; i < ready.length; i++) {
          pick -= weights[i]!;
          if (pick <= 0) {
            chosen = ready[i]!;
            break;
          }
        }
        chosen.tokens -= 1;
        chosen.inFlight++;
        return chosen;
      }
      const waits = candidates.map((e) => Math.max(e.cooldownUntil - t, e.tokens >= 1 ? 0 : ((1 - e.tokens) / e.rps) * 1000, e.inFlight >= this.maxInFlight ? 40 : 0));
      const wait = Math.max(10, Math.min(...waits));
      if (t + wait > deadline) return null;
      await this.sleep(wait);
    }
  }

  private cool(e: Endpoint, ms: number): void {
    e.cooldownUntil = Math.max(e.cooldownUntil, this.now() + ms);
  }

  // ------------------------------------------------------------------ one request

  private async callUncached(method: string, params: unknown[]): Promise<RpcBody> {
    const deadline = this.now() + this.budgetMs;
    const range = logRangeOf(method, params);
    const exclude = new Set<Endpoint>();
    let last: unknown = null;
    let rangeRefusal: RpcBody | null = null;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      let ep = await this.acquire(method, range, exclude, deadline);
      if (!ep) {
        // Every node has been tried for this request. If some were only skipped this round, a short pause and one more look is fair.
        if (exclude.size > 0 && this.now() < deadline - 500 && attempt < this.attempts - 1) {
          exclude.clear();
          await this.sleep(150 + Math.floor(this.random() * 100));
          ep = await this.acquire(method, range, exclude, deadline);
        }
        if (!ep) break;
      }
      const started = this.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(ep.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }), signal: controller.signal });
        if (res.status === 429) {
          ep.limited++;
          ep.failStreak++;
          const retryAfter = Number(res.headers.get('retry-after'));
          this.cool(ep, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 120_000) : Math.min(2_000 * 2 ** Math.min(ep.failStreak - 1, 6), 120_000));
          last = new RpcError(`${ep.host} answered HTTP 429`, 'transport');
          exclude.add(ep);
          continue;
        }
        if (res.status === 403 || res.status === 401) {
          // Most often "this method needs a key" on that node: do not ask it this again for a while, but it may serve other methods.
          ep.failed++;
          ep.blocked.set(method, this.now() + 600_000);
          last = new RpcError(`${ep.host} answered HTTP ${res.status}`, 'transport');
          exclude.add(ep);
          continue;
        }
        if (res.status >= 500 || !res.ok) {
          ep.failed++;
          ep.failStreak++;
          this.cool(ep, Math.min(3_000 * 2 ** Math.min(ep.failStreak - 1, 5), 60_000));
          last = new RpcError(`${ep.host} answered HTTP ${res.status}`, 'transport');
          exclude.add(ep);
          continue;
        }
        const body = (await res.json()) as RpcBody;
        if (body.error) {
          const text = String(body.error.message ?? 'node error').slice(0, 200);
          if (method === 'eth_getLogs' && RANGE_TOO_BIG.test(text)) {
            // This node's limit, not the request's fault: remember it and let a node that takes wider ranges try.
            if (range > 1) {
              ep.logRangeMax = Math.min(ep.logRangeMax, Math.max(1, Math.floor(range / 2)));
              ep.logRangeUntil = this.now() + 1_800_000;
            }
            rangeRefusal = body;
            exclude.add(ep);
            continue;
          }
          if (NODE_CANNOT.test(text)) {
            ep.blocked.set(method, this.now() + 600_000);
            last = new RpcError(text, 'transport');
            exclude.add(ep);
            continue;
          }
          if (RATE_LIMITED.test(text)) {
            ep.limited++;
            ep.failStreak++;
            this.cool(ep, Math.min(2_000 * 2 ** Math.min(ep.failStreak - 1, 6), 120_000));
            last = new RpcError(text, 'transport');
            exclude.add(ep);
            continue;
          }
          // The node answered the request with its own error (a revert, a bad parameter): that is the answer.
          ep.ok++;
          return body;
        }
        const ms = this.now() - started;
        ep.avgMs = ep.avgMs === null ? ms : ep.avgMs * 0.8 + ms * 0.2;
        ep.ok++;
        ep.failStreak = 0;
        return body;
      } catch (e) {
        ep.failed++;
        ep.failStreak++;
        this.cool(ep, Math.min(3_000 * 2 ** Math.min(ep.failStreak - 1, 5), 60_000));
        last = e instanceof Error ? e : new Error('transport failure');
        exclude.add(ep);
      } finally {
        clearTimeout(timer);
        ep.inFlight--;
      }
    }
    // No node would take the range: hand back the refusal, so the caller halves the range (it is the same message a single node gives).
    if (rangeRefusal) return rangeRefusal;
    throw new RpcError(last instanceof Error ? `all nodes failed: ${last.message}` : 'all nodes failed', 'transport');
  }
}

// ------------------------------------------------------------------ shared pools

const shared = new Map<string, RpcPool>();

/**
 * One pool per list of nodes for the life of the process. A serverless function that is called every minute keeps its warm
 * instance, so what the pool has learned (which node is cooling, which refuses what) and its answers carry over from call to call.
 */
export function sharedPool(urls: readonly EndpointInput[], o: PoolOptions = {}): RpcPool {
  const key = urls.map((u) => (typeof u === 'string' ? u : u.url)).join('|');
  let pool = shared.get(key);
  if (!pool || o.fetchImpl) {
    // A pool given its own fetch (a test) is never shared.
    pool = new RpcPool(urls, o);
    if (!o.fetchImpl) shared.set(key, pool);
  }
  return pool;
}

export function resetSharedPools(): void {
  shared.clear();
}

/** Health of every shared pool, for the status page. */
export function sharedPoolHealth(): { nodes: string[]; health: EndpointHealth[] }[] {
  return [...shared.entries()].map(([key, pool]) => ({ nodes: key.split('|').map(hostOf), health: pool.health() }));
}
