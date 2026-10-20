/** An in-memory LaunchStore for tests. Same rules as the real one: inserting a token that exists changes nothing. */
import { tokenKey, type LaunchChain, type LaunchRecord } from './core.js';
import { MissingTableError, type CursorRow, type LaunchStore, type StoredLaunch } from './store.js';

export class FakeLaunchStore implements LaunchStore {
  rows = new Map<string, StoredLaunch>();
  cursorRows = new Map<LaunchChain, CursorRow>();
  /** Set to make every call fail the way a missing table does. */
  missing = false;
  /** Set to make every call fail with a plain error (the database is down). */
  down = false;

  private check(): void {
    if (this.missing) throw new MissingTableError();
    if (this.down) throw new Error('The Launch Box database answered 503.');
  }

  async getCursor(chain: LaunchChain): Promise<CursorRow | null> {
    this.check();
    return this.cursorRows.get(chain) ?? null;
  }
  async cursors(): Promise<CursorRow[]> {
    this.check();
    return [...this.cursorRows.values()];
  }
  async setCursor(chain: LaunchChain, cursor: string | null, now: number, stats: Record<string, unknown> | null): Promise<void> {
    this.check();
    this.cursorRows.set(chain, { chain, cursor, updatedAt: now, stats });
  }
  async insertNew(records: readonly LaunchRecord[], now: number): Promise<number> {
    this.check();
    let added = 0;
    for (const r of records) {
      const key = tokenKey(r.chain, r.address);
      if (this.rows.has(key)) continue;
      this.rows.set(key, { ...r, address: r.chain === 'solana' ? r.address : r.address.toLowerCase(), indexedAt: now, poolDex: null, poolAddress: null, poolUrl: null, poolSeenAt: null, curveAddress: null });
      added++;
    }
    return added;
  }
  async existing(chain: LaunchChain, addresses: readonly string[]): Promise<Set<string>> {
    this.check();
    return new Set(addresses.filter((a) => this.rows.has(tokenKey(chain, a))).map((a) => (chain === 'solana' ? a : a.toLowerCase())));
  }
  async count(chain: LaunchChain): Promise<number> {
    this.check();
    return [...this.rows.values()].filter((r) => r.chain === chain).length;
  }
  async list(limit: number): Promise<StoredLaunch[]> {
    this.check();
    return [...this.rows.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.indexedAt - a.indexedAt).slice(0, limit);
  }
  async patch(chain: LaunchChain, address: string, fields: Parameters<LaunchStore['patch']>[2]): Promise<void> {
    this.check();
    const key = tokenKey(chain, address);
    const row = this.rows.get(key);
    if (!row) return;
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) (row as unknown as Record<string, unknown>)[k] = v;
  }
  async remove(chain: LaunchChain, address: string): Promise<void> {
    this.check();
    this.rows.delete(tokenKey(chain, address));
  }
}
