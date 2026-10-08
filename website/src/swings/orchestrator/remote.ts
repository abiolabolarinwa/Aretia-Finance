/**
 * Optional recovery copies on Aretia's server (api/swings-records.ts). Off unless the user turns it on, because a record
 * holds the move's two wallet addresses. The record's long random id is the only key to it, so it doubles as the
 * recovery code the user keeps.
 *
 * The local copy is always the working one. The server copy is best-effort: a failed upload never stops or changes an
 * execution, it only means the recovery copy may be behind, and the screen says so.
 */
import { SwingsError } from '../core/types.js';
import { encode, decode } from '../plan/store.js';
import type { ExecutionRecord } from './states.js';
import type { ExecutionStore } from './store.js';

/** A random id that cannot be guessed: 128 bits from the platform's secure generator. */
export function secureId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export type MirrorResult = 'saved' | 'conflict' | 'unavailable';

export class RecordMirror {
  constructor(
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly base = '/api/swings-records',
  ) {}

  /** Uploads one version of a record. `expectedVersion` is the version the server should currently hold (0 = new). */
  async push(kind: 'settlement' | 'plan', record: { id: string; version: number }, expectedVersion: number): Promise<MirrorResult> {
    try {
      const res = await this.fetchImpl(this.base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, record: JSON.parse(encode(record)), expectedVersion }) });
      if (res.status === 409) return 'conflict';
      return res.ok ? 'saved' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /** The server's copy for a recovery code, or null if there is none or it cannot be reached. */
  async pull<T>(id: string): Promise<T | null> {
    try {
      const res = await this.fetchImpl(`${this.base}?id=${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { record?: unknown };
      return body.record ? decode<T>(JSON.stringify(body.record)) : null;
    } catch {
      return null;
    }
  }
}

export interface MirrorStatus {
  /** Records whose latest version is on the server. */
  saved: number;
  /** Uploads that failed, so the recovery copy is behind. */
  behind: number;
}

/** An execution store that also sends each new version to the server, when the user has switched that on. Never blocks. */
export function mirroredExecutionStore(inner: ExecutionStore, mirror: RecordMirror, enabled: () => boolean, onResult?: (r: MirrorResult, id: string) => void): ExecutionStore {
  const send = (saved: ExecutionRecord, expected: number): void => {
    if (!enabled()) return;
    void mirror.push('settlement', saved, expected).then((r) => onResult?.(r, saved.id));
  };
  return {
    get: (id) => inner.get(id),
    list: () => inner.list(),
    restore: inner.restore?.bind(inner),
    create: async (r) => {
      const saved = await inner.create(r);
      send(saved, 0);
      return saved;
    },
    update: async (r, v) => {
      const saved = await inner.update(r, v);
      send(saved, v);
      return saved;
    },
  };
}

/** Brings a record back from its recovery code into local storage, keeping its version. Never overwrites a newer local copy. */
export async function restoreFromCode(code: string, mirror: RecordMirror, store: ExecutionStore): Promise<ExecutionRecord> {
  const id = code.trim();
  if (!/^[a-z0-9_]{24,72}$/.test(id)) throw new SwingsError('invalid', 'That is not a recovery code.');
  if (!store.restore) throw new SwingsError('invalid', 'This browser cannot restore records.');
  const local = await store.get(id);
  const remote = await mirror.pull<ExecutionRecord>(id);
  if (!remote) throw new SwingsError('invalid', 'No recovery copy was found for that code, or the service could not be reached.');
  if (local && local.version >= remote.version) return local;
  return store.restore(remote);
}
