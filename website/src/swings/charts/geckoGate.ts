/**
 * Spaces out the page's direct reads of GeckoTerminal.
 *
 * GeckoTerminal's free API allows about 30 requests a minute per visitor, and it also turns away requests that arrive too
 * close together: the refusal carries no CORS headers, so the browser reports it as a plain failed fetch. The chart makes
 * several reads in a burst (a new timeframe, its retries, the live poll, the trades table), and when they land a second or
 * two apart they all fail, which leaves the chart with no candles.
 *
 * Every direct read goes through this gate instead. Reads start one at a time, at least `GAP_MS` apart (about 28 a minute,
 * inside the allowance). The first read after a quiet spell starts at once. A read with a higher priority goes ahead of
 * waiting reads with a lower one, so the chart's candles are never held up behind the trades table; reads of the same
 * priority start in the order they were asked for.
 */

/** The least time between the starts of two direct reads. */
export const GAP_MS = 2_100;

interface Job {
  priority: number;
  start: () => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

let gapMs = GAP_MS;
let lastStart = Number.NEGATIVE_INFINITY;
let holdUntil = Number.NEGATIVE_INFINITY;
let waiting: Job[] = [];
let pumping = false;
/** Wakes the line from a wait when a more important read arrives. */
let wake: (() => void) | null = null;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The read to start next: the highest priority, and among equals the one asked for earliest (the list is in asking order). */
function pick(): Job {
  let best = waiting[0]!;
  for (const job of waiting) if (job.priority > best.priority) best = job;
  return best;
}

/** Starts waiting reads one by one, each after the gap, the most important first. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (waiting.length > 0) {
      const next = pick();
      const now = next.now();
      // A lower-priority read also stays back while a chart is opening (see holdLowPriority); a priority one does not.
      const wait = Math.max(lastStart + gapMs - now, next.priority > 0 ? 0 : holdUntil - now);
      if (wait > 0) {
        await Promise.race([next.sleep(wait), new Promise<void>((resolve) => (wake = resolve))]);
        wake = null;
        // Something more important may have been asked for while this waited; look again.
        if (pick() !== next) continue;
      }
      waiting.splice(waiting.indexOf(next), 1);
      lastStart = next.now();
      next.start();
    }
  } finally {
    pumping = false;
  }
}

/** Runs `task` once it is its turn: reads start one at a time, never closer together than the gap. */
export function spaced<T>(task: () => Promise<T>, opts: { priority?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const priority = opts.priority ?? 0;
    waiting.push({ priority, now: opts.now ?? Date.now, sleep: opts.sleep ?? realSleep, start: () => task().then(resolve, reject) });
    if (priority > 0) wake?.();
    void pump();
  });
}

/**
 * Holds lower-priority reads back for a moment. Opening a chart calls this first: the chart asks for its candles a second or
 * two later (it has to load first), and if a table read had gone out in the meantime the chart would have to wait out the
 * gap behind it. The chart's own read cuts the hold short.
 */
export function holdLowPriority(ms: number, now: () => number = Date.now): void {
  holdUntil = Math.max(holdUntil, now() + ms);
}

/** For tests: changes the gap (0 turns spacing off) and clears the line. */
export function setGeckoGap(ms: number): void {
  gapMs = ms;
  lastStart = Number.NEGATIVE_INFINITY;
  holdUntil = Number.NEGATIVE_INFINITY;
  waiting = [];
}

/** For tests: back to the real gap. */
export function resetGeckoGap(): void {
  setGeckoGap(GAP_MS);
}
