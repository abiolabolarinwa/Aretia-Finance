/**
 * The addresses a person knows: the ones they saved on purpose (trusted, with a name) and the ones they sent something to
 * (remembered, so a copy-cat of one can be spotted). Kept in this browser, one book per connected wallet, and never sent anywhere.
 */
import type { StorageLike } from '../history.js';
import type { KnownAddress } from './types.js';

const KEY = 'aretia-shield-book-v1:';
export const BOOK_MAX = 200;

const isEvm = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
const norm = (a: string): string => (isEvm(a) ? a.toLowerCase() : a);

function valid(v: unknown): v is KnownAddress {
  if (!v || typeof v !== 'object') return false;
  const k = v as Partial<KnownAddress>;
  return typeof k.address === 'string' && k.address.length >= 20 && k.address.length <= 64 && (k.label === null || (typeof k.label === 'string' && k.label.length <= 40)) && typeof k.trusted === 'boolean' && typeof k.lastUsed === 'number' && Number.isFinite(k.lastUsed);
}

/** A name safe to show: no control characters, trimmed, and not long. */
export const cleanLabel = (v: string): string => [...v].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 40);

export class AddressBook {
  constructor(private readonly storage: StorageLike | null, private readonly owner: string | null, private readonly now: () => number = Date.now) {}

  private key(): string | null {
    return this.owner ? KEY + norm(this.owner) : null;
  }

  list(): KnownAddress[] {
    const key = this.key();
    if (!key) return [];
    try {
      const raw = this.storage?.getItem(key);
      const v: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter(valid).slice(0, BOOK_MAX) : [];
    } catch {
      return [];
    }
  }

  private write(items: KnownAddress[]): void {
    const key = this.key();
    if (!key) return;
    // Trusted ones stay; the oldest remembered ones go first when the book is full.
    const kept = [...items].sort((a, b) => Number(b.trusted) - Number(a.trusted) || b.lastUsed - a.lastUsed).slice(0, BOOK_MAX);
    try {
      this.storage?.setItem(key, JSON.stringify(kept));
    } catch {
      // not remembered
    }
  }

  find(address: string): KnownAddress | null {
    const a = norm(address);
    return this.list().find((k) => norm(k.address) === a) ?? null;
  }

  /** Remembers an address the person sent to. A saved, named address keeps its name. */
  rememberSent(address: string): void {
    const a = norm(address);
    const items = this.list();
    const hit = items.find((k) => norm(k.address) === a);
    if (hit) hit.lastUsed = this.now();
    else items.push({ address: a, label: null, trusted: false, lastUsed: this.now() });
    this.write(items);
  }

  /** Saves an address on purpose, with a name. */
  trust(address: string, label: string): void {
    const a = norm(address);
    const name = cleanLabel(label) || null;
    const items = this.list().filter((k) => norm(k.address) !== a);
    items.push({ address: a, label: name, trusted: true, lastUsed: this.now() });
    this.write(items);
  }

  remove(address: string): void {
    const a = norm(address);
    this.write(this.list().filter((k) => norm(k.address) !== a));
  }
}
