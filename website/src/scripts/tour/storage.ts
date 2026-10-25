import type { TourConfig, TourRecord, TourStatus } from './types';

const PREFIX = 'aretia-tour:';

interface StoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface TourStorage {
  /** The saved record, or null when the tour was never seen or was saved for an older version. */
  read(tour: Pick<TourConfig, 'id' | 'version'>): TourRecord | null;
  write(tourId: string, record: TourRecord): void;
  clear(tourId: string): void;
}

function parse(raw: string | null): TourRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TourRecord> | null;
    if (!v || typeof v.version !== 'number' || typeof v.step !== 'number') return null;
    const status: TourStatus | null = v.status === 'in-progress' || v.status === 'skipped' || v.status === 'completed' ? v.status : null;
    return status ? { version: v.version, status, step: Math.max(0, Math.floor(v.step)) } : null;
  } catch {
    return null;
  }
}

function defaultStore(): StoreLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Remembers where each tour stands. localStorage can be missing or throw (private windows, blocked site data), so every
 * call is guarded and a copy lives in memory: the tour still works for the rest of the visit, it just is not remembered.
 */
export function createTourStorage(getStore: () => StoreLike | null = defaultStore): TourStorage {
  const memory = new Map<string, string>();
  return {
    read(tour) {
      const key = PREFIX + tour.id;
      let raw: string | null;
      try {
        raw = getStore()?.getItem(key) ?? null;
      } catch {
        raw = null;
      }
      const rec = parse(raw ?? memory.get(key) ?? null);
      return rec && rec.version === tour.version ? rec : null;
    },
    write(tourId, record) {
      const key = PREFIX + tourId;
      const raw = JSON.stringify(record);
      memory.set(key, raw);
      try {
        getStore()?.setItem(key, raw);
      } catch {
        /* kept in memory only */
      }
    },
    clear(tourId) {
      const key = PREFIX + tourId;
      memory.delete(key);
      try {
        getStore()?.removeItem?.(key);
      } catch {
        /* nothing to clear */
      }
    },
  };
}
