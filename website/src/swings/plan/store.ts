/**
 * Version-checked storage for any record with an `id` and a `version`, with bigint-safe JSON. Used for plans. Public
 * information only; never keys. A damaged entry is skipped, a write against an old version is refused, and a full or
 * blocked browser store fails loudly rather than losing progress quietly.
 */
import { SwingsError } from '../core/types.js';
import type { KeyValueStorage } from '../wallet/sessionManager.js';

const TAG = '$bigint';
export const encode = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { [TAG]: x.toString() } : x));
export const decode = <T>(s: string): T => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof (x as Record<string, unknown>)[TAG] === 'string' ? BigInt((x as Record<string, string>)[TAG]!) : x)) as T;

export interface Versioned {
  id: string;
  version: number;
}

export class JsonVersionedStore<T extends Versioned> {
  private memory = new Map<string, string>();

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly key: string,
    private readonly valid: (v: unknown) => v is T,
  ) {}

  private load(): Map<string, string> {
    if (!this.storage) return this.memory;
    try {
      const raw = this.storage.getItem(this.key);
      const parsed = raw ? (JSON.parse(raw) as { version?: number; items?: Record<string, string> }) : null;
      return new Map(parsed?.version === 1 && parsed.items ? Object.entries(parsed.items) : []);
    } catch {
      return new Map();
    }
  }

  private save(items: Map<string, string>): void {
    if (!this.storage) {
      this.memory = items;
      return;
    }
    try {
      this.storage.setItem(this.key, JSON.stringify({ version: 1, items: Object.fromEntries(items) }));
    } catch {
      throw new SwingsError('failed', 'This browser would not save your progress. Do not continue: it could be lost.');
    }
  }

  private read(s: string): T | null {
    try {
      const v = decode<unknown>(s);
      return this.valid(v) ? v : null;
    } catch {
      return null;
    }
  }

  async get(id: string): Promise<T | null> {
    const s = this.load().get(id);
    return s ? this.read(s) : null;
  }

  async create(record: T): Promise<T> {
    const items = this.load();
    if (items.has(record.id)) throw new SwingsError('invalid', 'That record already exists.');
    const saved = { ...record, version: 1 };
    items.set(record.id, encode(saved));
    this.save(items);
    return decode<T>(encode(saved));
  }

  async update(record: T, expectedVersion: number): Promise<T> {
    const items = this.load();
    const current = items.get(record.id);
    const existing = current ? this.read(current) : null;
    if (!existing) throw new SwingsError('invalid', 'That record does not exist.');
    if (existing.version !== expectedVersion) throw new SwingsError('invalid', 'This was changed elsewhere. Reload it and try again.');
    const saved = { ...record, version: expectedVersion + 1 };
    items.set(record.id, encode(saved));
    this.save(items);
    return decode<T>(encode(saved));
  }

  async list(): Promise<T[]> {
    const out: T[] = [];
    for (const s of this.load().values()) {
      const v = this.read(s);
      if (v) out.push(v);
    }
    return out;
  }
}
