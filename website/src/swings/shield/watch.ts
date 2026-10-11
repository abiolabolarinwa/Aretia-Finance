/**
 * The watchlist: tokens, addresses and links a person wants to be told about. Shield re-checks them while the page is open and
 * says so, with the bell and its ring, only when something got WORSE: the colour moved toward red, a new problem appeared, or
 * liquidity that was locked no longer is. Better news is saved quietly. Nothing is checked, or sent, when the page is closed.
 */
import type { StorageLike } from '../history.js';
import { bandRank, type Band, type Verdict } from './types.js';

const KEY = 'aretia-shield-watch-v1';
export const WATCH_MAX = 30;

/** The part of a verdict worth comparing later. Small, so many can be kept. */
export interface Fingerprint {
  band: Band;
  /** Ids of every problem, caution and note found. */
  issues: string[];
  /** Whether a lock on the liquidity was found. */
  locked: boolean;
}

export interface WatchItem {
  /** What was pasted: an address, a token, or a link. */
  value: string;
  label: string | null;
  addedAt: number;
  checkedAt: number | null;
  last: Fingerprint | null;
}

export function fingerprintOf(v: Verdict): Fingerprint {
  return { band: v.band, issues: v.findings.filter((f) => f.severity === 'bad' || f.severity === 'warn' || f.severity === 'note').map((f) => f.id).sort(), locked: v.findings.some((f) => f.id === 'lock' && f.severity === 'ok') };
}

export interface Change {
  tone: 'down' | 'info';
  title: string;
  detail: string;
}

const COLOUR: Record<Band, string> = { green: 'green', yellow: 'yellow', orange: 'orange', red: 'red', grey: 'grey' };

/** What changed for the worse between two checks, or null if nothing did. */
export function worsened(prev: Fingerprint | null, next: Fingerprint, nextVerdict: Verdict): Change | null {
  if (!prev) return null;
  const reasons: string[] = [];
  if (bandRank(next.band) > bandRank(prev.band) && prev.band !== 'grey') reasons.push(`it went from ${COLOUR[prev.band]} to ${COLOUR[next.band]}`);
  const fresh = next.issues.filter((id) => !prev.issues.includes(id));
  const newBad = nextVerdict.findings.filter((f) => fresh.includes(f.id) && (f.severity === 'bad' || f.severity === 'warn'));
  for (const f of newBad.slice(0, 2)) reasons.push(f.title.replace(/\.$/, ''));
  if (prev.locked && !next.locked) reasons.push('the liquidity lock is no longer found');
  if (reasons.length === 0) return null;
  const name = nextVerdict.subject.label ?? `${nextVerdict.subject.value.slice(0, 6)}…${nextVerdict.subject.value.slice(-4)}`;
  return { tone: 'down', title: `${name}: Shield now says ${COLOUR[next.band]}`, detail: reasons.join('; ') };
}

function valid(v: unknown): v is WatchItem {
  if (!v || typeof v !== 'object') return false;
  const w = v as Partial<WatchItem>;
  return typeof w.value === 'string' && w.value.length > 0 && w.value.length <= 2048 && (w.label === null || typeof w.label === 'string') && typeof w.addedAt === 'number' && (w.checkedAt === null || typeof w.checkedAt === 'number') && (w.last === null || (typeof w.last === 'object' && typeof w.last.band === 'string' && Array.isArray(w.last.issues) && typeof w.last.locked === 'boolean'));
}

/** An Ethereum-style address is the same address in any letter case, so it is kept in one form: the Markets panel and a pasted address must be the same item. */
const norm = (value: string): string => (/^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value);

export class WatchStore {
  constructor(private readonly storage: StorageLike | null, private readonly now: () => number = Date.now) {}

  list(): WatchItem[] {
    try {
      const raw = this.storage?.getItem(KEY);
      const v: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter(valid).slice(0, WATCH_MAX) : [];
    } catch {
      return [];
    }
  }

  private write(items: WatchItem[]): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(items.slice(0, WATCH_MAX)));
    } catch {
      // not remembered
    }
  }

  has(value: string): boolean {
    const v = norm(value);
    return this.list().some((w) => norm(w.value) === v);
  }

  /** Starts watching, from the verdict the person is looking at now. Returns false when the list is full. */
  add(value: string, label: string | null, verdict: Verdict | null): boolean {
    const items = this.list();
    if (this.has(value)) return true;
    if (items.length >= WATCH_MAX) return false;
    items.unshift({ value: norm(value), label, addedAt: this.now(), checkedAt: verdict ? this.now() : null, last: verdict ? fingerprintOf(verdict) : null });
    this.write(items);
    return true;
  }

  remove(value: string): void {
    const v = norm(value);
    this.write(this.list().filter((w) => norm(w.value) !== v));
  }

  /** Saves the outcome of a re-check. */
  record(value: string, verdict: Verdict): void {
    const v = norm(value);
    this.write(this.list().map((w) => (norm(w.value) === v ? { ...w, checkedAt: this.now(), last: fingerprintOf(verdict), label: verdict.subject.label ?? w.label } : w)));
  }
}
