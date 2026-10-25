import type { TourConfig, TourRecord, TourStatus } from './types';
import type { TourStorage } from './storage';

/**
 * The tour's state machine, with no DOM in it. The host supplies `prepare`, which gets a step ready (opens its page,
 * waits for its target) and says whether it can be shown. A step that cannot be shown is skipped, so a missing or hidden
 * target never traps anyone.
 */
export type Prepare = (index: number) => Promise<boolean>;

export interface SessionState {
  status: 'idle' | TourStatus;
  /** Index into the tour's steps. */
  index: number;
}

export class TourSession {
  private st: SessionState = { status: 'idle', index: 0 };
  private busy = false;
  /** Bumped whenever the person leaves, so a step that finishes loading afterwards is dropped. */
  private epoch = 0;

  constructor(
    readonly tour: TourConfig,
    private readonly storage: TourStorage,
    private readonly prepare: Prepare,
    private readonly onChange: (s: SessionState) => void = () => {},
  ) {}

  get state(): SessionState {
    return { ...this.st };
  }

  get active(): boolean {
    return this.st.status === 'in-progress';
  }

  /** The saved copy; null if never seen or saved for an older version. */
  saved(): TourRecord | null {
    return this.storage.read(this.tour);
  }

  /** True when the person has never seen this version, so an automatic tour may start. */
  isFresh(): boolean {
    return this.saved() === null;
  }

  /** A tour left part-way that can be picked up again. */
  canResume(): boolean {
    const r = this.saved();
    return !!r && r.status !== 'completed' && r.step > 0 && r.step < this.tour.steps.length;
  }

  /** Starts from the first step that can be shown. Returns false when none can. */
  async start(): Promise<boolean> {
    this.st = { status: 'idle', index: 0 };
    return this.seek(0, 1);
  }

  async resume(): Promise<boolean> {
    const r = this.saved();
    this.st = { status: 'idle', index: 0 };
    return this.seek(r && r.status !== 'completed' ? r.step : 0, 1);
  }

  /** Moves on; after the last shown step the tour completes. */
  async next(): Promise<void> {
    if (!this.active || this.busy) return;
    if (!(await this.seek(this.st.index + 1, 1))) this.complete();
  }

  /** Moves back; if no earlier step can be shown the current one stays. */
  async back(): Promise<void> {
    if (!this.active || this.busy) return;
    await this.seek(this.st.index - 1, -1);
  }

  /** Leaves mid-tour and remembers the step, so "Resume tour" can be offered. */
  skip(): void {
    this.epoch++;
    if (!this.active) return;
    this.set({ status: 'skipped', index: this.st.index });
  }

  complete(): void {
    this.epoch++;
    if (this.st.status === 'completed') return;
    this.set({ status: 'completed', index: this.tour.steps.length - 1 });
  }

  private async seek(from: number, dir: 1 | -1): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const epoch = ++this.epoch;
    try {
      for (let i = from; i >= 0 && i < this.tour.steps.length; i += dir) {
        let ok = false;
        try {
          ok = await this.prepare(i);
        } catch {
          ok = false;
        }
        if (epoch !== this.epoch) return true; // the person left while this step loaded
        if (ok) {
          this.set({ status: 'in-progress', index: i });
          return true;
        }
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  private set(s: SessionState): void {
    this.st = s;
    this.storage.write(this.tour.id, { version: this.tour.version, status: s.status as TourStatus, step: s.index });
    this.onChange(this.state);
  }
}
