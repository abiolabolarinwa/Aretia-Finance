/**
 * Server-side JSON-RPC reader for the indexer and the other server code: a thin face over the RPC Pool (src/swings/rpc/pool.ts), which
 * spreads requests over the nodes it is given, keeps within each node's allowance, learns what each cannot do, shares identical
 * requests and keeps answers that cannot change, and fails over. A node's own error reply (a revert, a bad range) is NOT retried on
 * the same node: it is thrown as RpcError so the caller can react (for example halve a log range). Only transport failures and
 * HTTP 429/5xx move on to another node.
 */
import { classifyNodeError, RpcError, RpcPool, sharedPool, type EndpointInput } from '../rpc/pool.js';

export type Read = (method: string, params: unknown[]) => Promise<unknown>;

export { classifyNodeError, RpcError };

export interface RpcOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  /** Kept for compatibility; waits are now decided per node by the pool. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Requests in flight at once through this reader (public nodes refuse bursts). */
  concurrency?: number;
  /** Requests per second each node is given (default 4). */
  rps?: number;
}

export function makeRead(urls: readonly EndpointInput[], o: RpcOptions = {}): Read {
  const pool: RpcPool = o.fetchImpl || o.sleep
    ? new RpcPool(urls, { ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.attempts ? { attempts: o.attempts } : {}), ...(o.rps ? { rps: o.rps } : {}) })
    : sharedPool(urls, { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.attempts ? { attempts: o.attempts } : {}), ...(o.rps ? { rps: o.rps } : {}) });
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
      return await pool.read(method, params);
    } finally {
      release();
    }
  };
}
