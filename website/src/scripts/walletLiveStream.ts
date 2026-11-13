/**
 * The page's side of the live market stream (see docs/market-stream.md): it opens one Server-Sent Events connection for the pools a Markets
 * page shows, hands every update to the page, and keeps itself tidy:
 *  - it names at most 100 pools, and re-connects (after a short pause) when the pools on screen change;
 *  - it closes while the tab is hidden and opens again when it is shown;
 *  - when the connection fails it waits longer each time, and after several failures in a row it gives up for a while, so a stream that is
 *    switched off or unreachable costs the page nothing (the list's own refresh keeps it current either way).
 * No update changes which rows exist: that stays with the list's refresh.
 */
import type { LiveUpdate } from '../swings/market/liveFields.js';

export const MAX_STREAM_KEYS = 100;
const RECONNECT_MS = [3_000, 6_000, 12_000, 30_000];
/** After this many failed connections in a row, stop trying for a while. */
const GIVE_UP_AFTER = 5;
const GIVE_UP_MS = 10 * 60_000;
/** The pools on screen are re-sent to the stream only after they have stopped changing for this long. */
const SETTLE_MS = 400;

export interface EventSourceLike {
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  addEventListener(type: string, fn: (e: { data: string }) => void): void;
  close(): void;
}

export interface LiveStreamOptions {
  /** The stream address, e.g. https://data.aretiafinance.org/stream. Empty: the stream is not used. */
  url: string;
  /** Called with each batch of updates (already checked to be about pools that were asked for). */
  onUpdates: (updates: LiveUpdate[]) => void;
  /** Called when the connection starts or stops delivering, so the page can say whether it is live. */
  onState?: (live: boolean) => void;
  /** Test seams. */
  open?: (url: string) => EventSourceLike;
  isHidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface LiveStream {
  /** The pools on screen now (pool keys such as `solana:<pool>` or `bnb:<pool>`). */
  setKeys(keys: readonly string[]): void;
  /** Tells the stream the tab was shown or hidden. */
  visibility(): void;
  stop(): void;
}

const KEY = /^(solana|ethereum|base|bnb|polygon|robinhood):[A-Za-z0-9]{20,90}$/;

/** The updates in an event's data, or none when it is not a list of them. */
export function parseUpdates(data: string, wanted: ReadonlySet<string>): LiveUpdate[] {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: LiveUpdate[] = [];
  for (const u of v) {
    if (typeof u !== 'object' || u === null) continue;
    const key = (u as { key?: unknown }).key;
    if (typeof key === 'string' && wanted.has(key) && typeof (u as { at?: unknown }).at === 'number') out.push(u as LiveUpdate);
  }
  return out;
}

/** The address of the stream for a set of pools. */
export const streamUrl = (base: string, keys: readonly string[]): string => `${base}${base.includes('?') ? '&' : '?'}keys=${encodeURIComponent(keys.join(','))}`;

export function createLiveStream(o: LiveStreamOptions): LiveStream {
  const open = o.open ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const hidden = o.isHidden ?? ((): boolean => typeof document !== 'undefined' && document.hidden);
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t: unknown): void => clearTimeout(t as ReturnType<typeof setTimeout>));

  let keys: string[] = [];
  let wanted = new Set<string>();
  let source: EventSourceLike | null = null;
  let timer: unknown = null;
  let failures = 0;
  let live = false;
  let stopped = false;

  const setLive = (v: boolean): void => {
    if (live === v) return;
    live = v;
    o.onState?.(v);
  };
  const close = (): void => {
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
      source = null;
    }
    setLive(false);
  };
  const cancelTimer = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const later = (ms: number): void => {
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      connect();
    }, ms);
  };

  function connect(): void {
    cancelTimer();
    close();
    if (stopped || !o.url || keys.length === 0 || hidden()) return;
    let es: EventSourceLike;
    try {
      es = open(streamUrl(o.url, keys));
    } catch {
      failures++;
      later(failures >= GIVE_UP_AFTER ? GIVE_UP_MS : RECONNECT_MS[Math.min(failures - 1, RECONNECT_MS.length - 1)]!);
      return;
    }
    source = es;
    es.onopen = () => {
      failures = 0;
      setLive(true);
    };
    es.addEventListener('u', (e) => {
      failures = 0;
      setLive(true);
      const list = parseUpdates(e.data, wanted);
      if (list.length > 0) o.onUpdates(list);
    });
    es.onerror = () => {
      // The browser would retry by itself, but a stream that keeps failing is given up on, and a closed one is reopened by us.
      setLive(false);
      failures++;
      close();
      later(failures >= GIVE_UP_AFTER ? GIVE_UP_MS : RECONNECT_MS[Math.min(failures - 1, RECONNECT_MS.length - 1)]!);
    };
  }

  return {
    setKeys(next) {
      const clean = [...new Set(next.filter((k) => KEY.test(k)))].slice(0, MAX_STREAM_KEYS).sort();
      if (clean.length === keys.length && clean.every((k, i) => k === keys[i])) return;
      keys = clean;
      wanted = new Set(clean);
      // A short pause, so a table that is being redrawn a few times in a row opens one connection, not several.
      failures = 0;
      later(SETTLE_MS);
    },
    visibility() {
      if (hidden()) {
        cancelTimer();
        close();
      } else if (!stopped && source === null && timer === null) {
        failures = 0;
        connect();
      }
    },
    stop() {
      stopped = true;
      cancelTimer();
      close();
    },
  };
}
