/**
 * The worker's side of "watched pools get priority": it asks the stream service which pools open Markets pages are showing right now, so
 * those pools can be kept current ahead of the rest. The answer is cached for a few seconds. A failure (service down, slow, wrong secret)
 * gives an empty list, never an error: indexing carries on as before.
 */
export interface WatchedOptions {
  /** The stream service on the private network, e.g. http://stream:8090 */
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long an answer is reused (ms). */
  cacheMs?: number;
  timeoutMs?: number;
}

export function watchedReader(o: WatchedOptions): () => Promise<string[]> {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? 2_000;
  let cached: { at: number; keys: string[] } | null = null;
  const base = o.url.replace(/\/+$/, '');
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.keys;
    let keys: string[] = [];
    try {
      const res = await doFetch(`${base}/watched`, { headers: { 'x-stream-secret': o.secret }, signal: AbortSignal.timeout(o.timeoutMs ?? 2_000) });
      if (res.ok) {
        const body = (await res.json()) as { keys?: unknown };
        if (Array.isArray(body.keys)) keys = body.keys.filter((k): k is string => typeof k === 'string');
      }
    } catch {
      keys = [];
    }
    cached = { at: now(), keys };
    return keys;
  };
}
