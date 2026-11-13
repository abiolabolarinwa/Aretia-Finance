/**
 * The indexer as a long-running worker. No 45 second budget: each chain has its own loop, and inside a chain the adapters take turns
 * (the one that last succeeded longest ago goes first), each for a slice of `sliceMs`. Per-adapter checkpoints stay in the database
 * exactly as in the HTTP-triggered run, so the two can be swapped at any time and a crash loses nothing.
 *
 * Everything the loop needs from outside is injected (`DoSlice`, `sleep`, `log`), so tests run it with a fake clock and no network.
 */
import type { MiChain } from '../chains.js';

export interface WorkerTask {
  /** Stable name, used for logs and checkpoints (an adapter id, or `<adapter>:refresh` / `<adapter>:backfill`). */
  id: string;
  chain: MiChain;
  /** Tasks with the same lane take turns; a task with its own lane runs beside the others (default: the chain). */
  lane?: string;
  /** Wait after a slice that left this task caught up (default: the loop's idleMs). */
  idleMs?: number;
  /** Runs one slice. Returns whether the task is caught up (nothing more to do right now) or failed with a message. */
  run: (budgetMs: number) => Promise<{ ok: boolean; error?: string | null; caughtUp?: boolean }>;
}

export interface LoopOptions {
  sliceMs: number;
  /** Wait after a slice that left the task caught up. */
  idleMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}
export const DEFAULT_LOOP: LoopOptions = { sliceMs: 40_000, idleMs: 15_000, backoffBaseMs: 5_000, backoffMaxMs: 300_000 };

export interface LoopDeps {
  tasks: readonly WorkerTask[];
  options: LoopOptions;
  now: () => number;
  /** Resolves after ms, or early when the worker is stopping. */
  sleep: (ms: number) => Promise<void>;
  stopping: () => boolean;
  log: (line: string) => void;
  /** 0..1, for backoff jitter. */
  random?: () => number;
}

/** A coarse failure type, so the log has one line per kind of trouble and not one per attempt. */
export function failureType(message: string): string {
  const m = message.toLowerCase();
  if (/429|rate.?limit|too many requests|over rate|exceeded/.test(m)) return 'rate-limited';
  if (/timeout|timed out|aborted/.test(m)) return 'timeout';
  if (/changed while|reorg/.test(m)) return 'reorg';
  if (/postgrest|supabase|database|the store|pgrst|\b50[0-9]\b.*(rest|mi_)/.test(m)) return 'database';
  if (/transport|fetch failed|econn|enotfound|network|socket|502|503|504/.test(m)) return 'node-unreachable';
  if (/range|limit exceeded|too many|query returned more/.test(m)) return 'node-limit';
  return 'other';
}

interface FailureState {
  type: string;
  since: number;
  count: number;
  lastLogged: number;
  lastMessage: string;
}

/** One log line when a kind of failure starts, one summary every five minutes while it lasts, one line when it ends. */
export class FailureLog {
  private readonly active = new Map<string, FailureState>();
  constructor(private readonly log: (line: string) => void, private readonly summaryMs = 300_000) {}
  failed(id: string, message: string, now: number): string {
    const type = failureType(message);
    const cur = this.active.get(id);
    if (!cur || cur.type !== type) {
      this.active.set(id, { type, since: now, count: 1, lastLogged: now, lastMessage: message });
      this.log(`[${id}] failing (${type}): ${message.slice(0, 200)}`);
    } else {
      cur.count++;
      cur.lastMessage = message;
      if (now - cur.lastLogged >= this.summaryMs) {
        cur.lastLogged = now;
        this.log(`[${id}] still failing (${type}) ${cur.count} times since ${new Date(cur.since).toISOString()}`);
      }
    }
    return type;
  }
  recovered(id: string, now: number): void {
    const cur = this.active.get(id);
    if (!cur) return;
    this.active.delete(id);
    this.log(`[${id}] recovered after ${cur.count} failure(s) (${cur.type}) in ${Math.round((now - cur.since) / 1000)}s`);
  }
}

export const backoffMs = (failures: number, o: LoopOptions, random = 0.5): number => {
  const raw = Math.min(o.backoffMaxMs, o.backoffBaseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(raw * (0.8 + 0.4 * random));
};

interface TaskState {
  failures: number;
  nextAt: number;
  lastSuccessAt: number;
}

/** One loop per chain, all running side by side until `stopping()` turns true. Resolves when every loop has finished its current slice. */
export async function runWorker(d: LoopDeps): Promise<void> {
  const failures = new FailureLog(d.log);
  const laneOf = (t: WorkerTask): string => t.lane ?? t.chain;
  const lanes = [...new Set(d.tasks.map(laneOf))];
  await Promise.all(lanes.map((lane) => chainLoop(lane as MiChain, d.tasks.filter((t) => laneOf(t) === lane), d, failures)));
}

async function chainLoop(chain: MiChain, tasks: readonly WorkerTask[], d: LoopDeps, failures: FailureLog): Promise<void> {
  const state = new Map<string, TaskState>(tasks.map((t) => [t.id, { failures: 0, nextAt: 0, lastSuccessAt: 0 }]));
  while (!d.stopping()) {
    const now = d.now();
    const due = tasks.filter((t) => state.get(t.id)!.nextAt <= now).sort((a, b) => state.get(a.id)!.lastSuccessAt - state.get(b.id)!.lastSuccessAt);
    if (due.length === 0) {
      const next = Math.min(...tasks.map((t) => state.get(t.id)!.nextAt));
      await d.sleep(Math.max(250, next - now));
      continue;
    }
    // Fair share: the slice is the same for every task, and the least recently served goes first.
    const task = due[0]!;
    const s = state.get(task.id)!;
    let out: Awaited<ReturnType<WorkerTask['run']>>;
    try {
      out = await task.run(d.options.sliceMs);
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const t = d.now();
    if (out.ok) {
      failures.recovered(task.id, t);
      s.failures = 0;
      s.lastSuccessAt = t;
      s.nextAt = out.caughtUp ? t + (task.idleMs ?? d.options.idleMs) : t;
    } else {
      s.failures++;
      failures.failed(task.id, out.error ?? 'failed', t);
      s.nextAt = t + backoffMs(s.failures, d.options, (d.random ?? Math.random)());
    }
  }
  d.log(`[${chain}] loop stopped`);
}
