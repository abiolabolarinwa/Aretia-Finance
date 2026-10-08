/**
 * Where executions are kept between page loads. Holds public information only (quotes, transaction hashes, states),
 * never keys. Writes are checked against a version so two tabs cannot overwrite each other, and a damaged entry is
 * skipped and reported, not trusted.
 */
import { SwingsError } from '../core/types.js';
import type { KeyValueStorage } from '../wallet/sessionManager.js';
import { parseRecord, serializeRecord, type ExecutionRecord } from './states.js';

export interface ExecutionStore {
  get(id: string): Promise<ExecutionRecord | null>;
  /** Fails if the id already exists. */
  create(record: ExecutionRecord): Promise<ExecutionRecord>;
  /** Writes `record` only if the stored version is `expectedVersion`; returns the saved record with a new version. */
  update(record: ExecutionRecord, expectedVersion: number): Promise<ExecutionRecord>;
  list(): Promise<ExecutionRecord[]>;
}

const clone = (r: ExecutionRecord): ExecutionRecord => parseRecord(serializeRecord(r));

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly items = new Map<string, string>();

  async get(id: string): Promise<ExecutionRecord | null> {
    const s = this.items.get(id);
    return s ? parseRecord(s) : null;
  }

  async create(record: ExecutionRecord): Promise<ExecutionRecord> {
    if (this.items.has(record.id)) throw new SwingsError('invalid', 'That execution already exists.');
    const saved = { ...clone(record), version: 1 };
    this.items.set(record.id, serializeRecord(saved));
    return clone(saved);
  }

  async update(record: ExecutionRecord, expectedVersion: number): Promise<ExecutionRecord> {
    const current = this.items.get(record.id);
    if (!current) throw new SwingsError('invalid', 'That execution does not exist.');
    if (parseRecord(current).version !== expectedVersion) throw new SwingsError('invalid', 'This execution was changed elsewhere. Reload it and try again.');
    const saved = { ...clone(record), version: expectedVersion + 1 };
    this.items.set(record.id, serializeRecord(saved));
    return clone(saved);
  }

  async list(): Promise<ExecutionRecord[]> {
    const out: ExecutionRecord[] = [];
    for (const s of this.items.values()) {
      try {
        out.push(parseRecord(s));
      } catch {
        // skipped: a damaged entry is never trusted
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}

const KEY = 'aretia-swings-executions';

/** The same store, kept in the browser's storage. Storage can be blocked or full, in which case writes fail loudly. */
export class StorageExecutionStore implements ExecutionStore {
  constructor(private readonly storage: KeyValueStorage) {}

  private load(): Record<string, string> {
    try {
      const raw = this.storage.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as { version?: number; items?: Record<string, string> }) : null;
      return parsed?.version === 1 && parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
    } catch {
      return {};
    }
  }

  private save(items: Record<string, string>): void {
    try {
      this.storage.setItem(KEY, JSON.stringify({ version: 1, items }));
    } catch {
      throw new SwingsError('failed', 'This browser would not save the execution record. Do not continue: progress could be lost.');
    }
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const s = this.load()[id];
    return s ? parseRecord(s) : null;
  }

  async create(record: ExecutionRecord): Promise<ExecutionRecord> {
    const items = this.load();
    if (items[record.id]) throw new SwingsError('invalid', 'That execution already exists.');
    const saved = { ...clone(record), version: 1 };
    items[record.id] = serializeRecord(saved);
    this.save(items);
    return clone(saved);
  }

  async update(record: ExecutionRecord, expectedVersion: number): Promise<ExecutionRecord> {
    const items = this.load();
    const current = items[record.id];
    if (!current) throw new SwingsError('invalid', 'That execution does not exist.');
    if (parseRecord(current).version !== expectedVersion) throw new SwingsError('invalid', 'This execution was changed elsewhere. Reload it and try again.');
    const saved = { ...clone(record), version: expectedVersion + 1 };
    items[record.id] = serializeRecord(saved);
    this.save(items);
    return clone(saved);
  }

  async list(): Promise<ExecutionRecord[]> {
    const out: ExecutionRecord[] = [];
    for (const s of Object.values(this.load())) {
      try {
        out.push(parseRecord(s));
      } catch {
        // skipped
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
