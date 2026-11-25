/**
 * One pool's dollar price read from the chain again and again, shared by everything on the page that shows it: the chart's last candle and the
 * token page's header ask for the same pool, and one loop (one read every `everyMs`) serves both. Each watcher gets the newest price at once
 * when it starts, then every change. The loop stops when the last watcher leaves, reads nothing while every watcher is hidden, and gives up
 * after several failed reads in a row (the watchers' other sources then carry on, as they did before).
 */
import { chainNativeUsd, createChainPricer, publicRpc, type ChainPriceDeps, type PriceReader } from './chainPrice.js';
import type { ChainId } from '../core/types.js';

export interface WatchOptions {
  chain: ChainId;
  pool: string;
  /** The token address whose price is wanted. */
  target: string;
  /** False while this watcher's view is not showing (nothing is read while all are hidden). */
  visible?: () => boolean;
}

export interface WatchEnv {
  deps: (chain: ChainId) => ChainPriceDeps;
  everyMs: number;
  maxFailures: number;
  isTabHidden: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

interface Watcher {
  onPrice: (usd: number) => void;
  visible: () => boolean;
}
interface Loop {
  watchers: Set<Watcher>;
  last: number | null;
  stop: () => void;
}

export const CHAIN_READ_MS = 400;

const defaultDeps = (): ((chain: ChainId) => ChainPriceDeps) => {
  const usdOf = chainNativeUsd((c) => publicRpc(c));
  const rpcs = new Map<ChainId, ChainPriceDeps['rpc']>();
  return (chain) => {
    let rpc = rpcs.get(chain);
    if (!rpc) {
      rpc = publicRpc(chain);
      rpcs.set(chain, rpc);
    }
    return { rpc, usdOf };
  };
};

/** The shared watcher: `watch` returns a function that stops this watcher. */
export function createChainWatch(env: Partial<WatchEnv> = {}): (o: WatchOptions, onPrice: (usd: number) => void) => () => void {
  const e: WatchEnv = {
    deps: env.deps ?? defaultDeps(),
    everyMs: env.everyMs ?? CHAIN_READ_MS,
    maxFailures: env.maxFailures ?? 8,
    isTabHidden: env.isTabHidden ?? ((): boolean => typeof document !== 'undefined' && document.hidden),
    setTimer: env.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms)),
    clearTimer: env.clearTimer ?? ((t): void => clearTimeout(t as ReturnType<typeof setTimeout>)),
  };
  const loops = new Map<string, Loop>();

  function start(o: WatchOptions, key: string): Loop {
    const loop: Loop = { watchers: new Set(), last: null, stop: () => undefined };
    let stopped = false;
    let timer: unknown = null;
    void createChainPricer({ chain: o.chain, pool: o.pool, target: o.target }, e.deps(o.chain)).then((read: PriceReader | null) => {
      if (!read || stopped) return;
      let failures = 0;
      const tick = async (): Promise<void> => {
        if (stopped) return;
        const shown = !e.isTabHidden() && [...loop.watchers].some((w) => w.visible());
        if (shown) {
          try {
            const p = await read();
            if (p !== null && !stopped) {
              failures = 0;
              loop.last = p;
              for (const w of [...loop.watchers]) w.onPrice(p);
            } else failures++;
          } catch {
            failures++;
          }
        }
        if (failures >= e.maxFailures || stopped) return;
        timer = e.setTimer(() => void tick(), e.everyMs);
      };
      void tick();
    });
    loop.stop = (): void => {
      stopped = true;
      if (timer !== null) e.clearTimer(timer);
      loops.delete(key);
    };
    return loop;
  }

  return (o, onPrice) => {
    const key = `${o.chain}:${o.chain === 'solana' ? o.pool : o.pool.toLowerCase()}:${o.target.toLowerCase()}`;
    let loop = loops.get(key);
    if (!loop) {
      loop = start(o, key);
      loops.set(key, loop);
    }
    const w: Watcher = { onPrice, visible: o.visible ?? ((): boolean => true) };
    loop.watchers.add(w);
    if (loop.last !== null) onPrice(loop.last);
    const mine = loop;
    return () => {
      mine.watchers.delete(w);
      if (mine.watchers.size === 0) mine.stop();
    };
  };
}

/** The page's shared watcher. */
export const watchChainPrice = createChainWatch();
