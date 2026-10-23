/**
 * Server-side JSON-RPC reader for the indexer: ordered node list, per-request timeout, retry with exponential backoff, failover.
 * A node's own error reply (a revert, a bad range) is NOT retried on the same node: it is thrown as RpcError so the caller can
 * react (for example halve a log range). Only transport failures and HTTP 429/5xx are retried.
 */
export type Read = (method: string, params: unknown[]) => Promise<unknown>;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly kind: 'node-error' | 'transport',
  ) {
    super(message);
  }
}

export interface RpcOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Requests in flight at once through this reader (public nodes refuse bursts). */
  concurrency?: number;
}

/** A node's error text that means "slow down" rather than "your request is wrong": retried with backoff, never read as an answer. */
const RATE_LIMITED = /rate.?limit|too many requests|limit exceeded|throttl|capacity|try again|temporarily|overloaded|timeout|timed out/i;
/** Error text that means the log range or result set was too big: the caller halves the range. */
const RANGE_TOO_BIG = /more than \d+ results|block range|range (is )?too|too (many|large|wide|big)|exceeds? (the )?(max|limit)|query (returned|timeout)/i;

export const classifyNodeError = (message: string): 'transport' | 'node-error' => (RANGE_TOO_BIG.test(message) ? 'node-error' : RATE_LIMITED.test(message) ? 'transport' : 'node-error');

/** This node cannot answer this request (a method it does not offer, history it does not keep): another node may. */
const NODE_CANNOT = /not supported|method not found|unsupported|not available|missing trie node|header not found|archive/i;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function makeRead(urls: readonly string[], o: RpcOptions = {}): Read {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const attempts = o.attempts ?? 5;
  const base = o.baseDelayMs ?? 400;
  const sleep = o.sleep ?? defaultSleep;
  let id = 0;
  const maxActive = o.concurrency ?? 4;
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active >= maxActive) await new Promise<void>((r) => waiting.push(r));
    active++;
  };
  const release = (): void => {
    active--;
    waiting.shift()?.();
  };
  return async (method, params) => {
    await acquire();
    try {
      return await attemptAll(method, params);
    } finally {
      release();
    }
  };
  async function attemptAll(method: string, params: unknown[]): Promise<unknown> {
    let last: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: controller.signal });
          if (res.status === 429 || res.status >= 500 || res.status === 403) {
            last = new RpcError(`node answered HTTP ${res.status}`, 'transport');
            continue;
          }
          if (!res.ok) {
            last = new RpcError(`node answered HTTP ${res.status}`, 'transport');
            continue;
          }
          const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
          if (body.error) {
            const text = String(body.error.message ?? 'node error').slice(0, 200);
            const kind = classifyNodeError(text);
            if (kind === 'node-error' && !NODE_CANNOT.test(text)) throw new RpcError(text, 'node-error');
            last = new RpcError(text, 'transport');
            continue;
          }
          return body.result;
        } catch (e) {
          if (e instanceof RpcError && e.kind === 'node-error') throw e;
          last = e instanceof Error ? e : new Error('transport failure');
        } finally {
          clearTimeout(timer);
        }
      }
      if (attempt < attempts - 1) await sleep(base * 2 ** attempt + Math.floor(Math.random() * 100));
    }
    throw new RpcError(last instanceof Error ? `all nodes failed: ${last.message}` : 'all nodes failed', 'transport');
  }
}
