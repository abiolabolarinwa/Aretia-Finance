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
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function makeRead(urls: readonly string[], o: RpcOptions = {}): Read {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const attempts = o.attempts ?? 3;
  const base = o.baseDelayMs ?? 400;
  const sleep = o.sleep ?? defaultSleep;
  let id = 0;
  return async (method, params) => {
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
          if (body.error) throw new RpcError(String(body.error.message ?? 'node error').slice(0, 200), 'node-error');
          return body.result;
        } catch (e) {
          if (e instanceof RpcError && e.kind === 'node-error') throw e;
          last = e instanceof Error ? e : new Error('transport failure');
        } finally {
          clearTimeout(timer);
        }
      }
      if (attempt < attempts - 1) await sleep(base * 2 ** attempt);
    }
    throw new RpcError(last instanceof Error ? `all nodes failed: ${last.message}` : 'all nodes failed', 'transport');
  };
}
