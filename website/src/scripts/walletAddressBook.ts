/**
 * Saved recipients for Pay > Send: a short list of labelled addresses kept in this browser only (never sent anywhere), chosen from a menu
 * under the recipient box. Choosing one only fills the box: the usual checks, the full address on the review screen and the wallet's own
 * approval all still apply. Pure list functions first, then the small piece of page that uses them.
 */
import type { StorageLike } from '../swings/history.js';
import { isSolanaAddress } from './walletTools';

export interface SavedRecipient {
  label: string;
  address: string;
  /** 'solana' for a Solana address or a .sns name, 'evm' for a 0x address (it works on every Ethereum-style network). */
  kind: 'solana' | 'evm';
}

export const BOOK_KEY = 'aretia-pay-address-book';
export const MAX_SAVED = 50;

const EVM = /^0x[0-9a-fA-F]{40}$/;
const NAME = /^[^\s@/:]+\.[a-z][a-z0-9-]*$/i;

/** What kind of recipient this is, or null when it is neither an address nor a name worth saving. */
export function recipientKind(value: string): SavedRecipient['kind'] | null {
  const v = value.trim();
  if (EVM.test(v)) return 'evm';
  if (isSolanaAddress(v) || (NAME.test(v) && !/^0x/i.test(v))) return 'solana';
  return null;
}

/** A label cleaned for display: no control characters, no line breaks, at most 30 characters. */
export function cleanLabel(v: string): string {
  return [...v].filter((c) => c.charCodeAt(0) > 31 && c !== '\u007f').join('').replace(/\s+/g, ' ').trim().slice(0, 30);
}

export function loadBook(store: StorageLike | null): SavedRecipient[] {
  if (!store) return [];
  try {
    const raw: unknown = JSON.parse(store.getItem(BOOK_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const out: SavedRecipient[] = [];
    for (const r of raw) {
      const x = r as Partial<SavedRecipient> | null;
      if (!x || typeof x.label !== 'string' || typeof x.address !== 'string') continue;
      const kind = recipientKind(x.address);
      if (kind === null) continue;
      out.push({ label: cleanLabel(x.label), address: x.address.trim(), kind });
    }
    return out.slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

function persist(store: StorageLike | null, book: readonly SavedRecipient[]): void {
  try {
    store?.setItem(BOOK_KEY, JSON.stringify(book));
  } catch {
    // Storage full or blocked: the list simply is not kept.
  }
}

/** Adds (or renames, when the address is already saved) a recipient. Returns the new list, or a plain reason it was not saved. */
export function saveRecipient(store: StorageLike | null, label: string, address: string): { book: SavedRecipient[] } | { problem: string } {
  const kind = recipientKind(address);
  const name = cleanLabel(label);
  if (kind === null) return { problem: 'That is not a Solana address, a .sns name or an Ethereum-style address.' };
  if (!name) return { problem: 'Give it a name you will recognise.' };
  const book = loadBook(store);
  const same = (a: string): boolean => (kind === 'evm' ? a.toLowerCase() === address.trim().toLowerCase() : a === address.trim());
  const at = book.findIndex((r) => same(r.address));
  const entry: SavedRecipient = { label: name, address: address.trim(), kind };
  if (at >= 0) book[at] = entry;
  else if (book.length >= MAX_SAVED) return { problem: `You can keep ${MAX_SAVED} saved recipients. Remove one first.` };
  else book.push(entry);
  persist(store, book);
  return { book };
}

export function removeRecipient(store: StorageLike | null, address: string): SavedRecipient[] {
  const book = loadBook(store).filter((r) => r.address !== address);
  persist(store, book);
  return book;
}

/** The saved recipients that suit the network now chosen: Solana ones on Solana, 0x ones on an Ethereum-style network. */
export function suitsNetwork(book: readonly SavedRecipient[], network: string): SavedRecipient[] {
  return book.filter((r) => (network === 'solana' ? r.kind === 'solana' : r.kind === 'evm'));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Puts the saved-recipients row under the recipient box of the Send form: a menu of saved ones, and a Save button that asks for a name.
 * It never fills anything but the box, and never sends.
 */
export function mountAddressBook(store: StorageLike | null): void {
  const to = document.querySelector<HTMLInputElement>('[data-send-to]');
  if (!to || to.dataset.book === '1') return;
  to.dataset.book = '1';
  const net = (): string => document.querySelector<HTMLSelectElement>('[data-send-network]')?.value ?? 'solana';
  const row = el('div', 'wapp-book');
  const pick = el('select', 'wapp__input wapp-book__pick');
  pick.setAttribute('aria-label', 'Saved recipients');
  const save = el('button', 'wapp__btn wapp__btn--ghost', 'Save');
  save.type = 'button';
  save.title = 'Save the address in the box under a name you choose. It is kept in this browser only.';
  const del = el('button', 'wapp__btn wapp__btn--ghost', 'Remove');
  del.type = 'button';
  del.hidden = true;
  const ask = el('div', 'wapp-book__ask');
  ask.hidden = true;
  const name = el('input', 'wapp__input');
  name.type = 'text';
  name.maxLength = 30;
  name.placeholder = 'Name, such as Mum or Rent';
  name.setAttribute('aria-label', 'Name for this recipient');
  const ok = el('button', 'wapp__btn wapp__btn--primary', 'Save recipient');
  ok.type = 'button';
  const note = el('p', 'wapp__fine wapp-book__note');
  note.setAttribute('role', 'status');
  ask.append(name, ok);
  row.append(pick, save, del);
  to.insertAdjacentElement('afterend', row);
  row.insertAdjacentElement('afterend', ask);
  ask.insertAdjacentElement('afterend', note);

  const draw = (): void => {
    const list = suitsNetwork(loadBook(store), net());
    pick.replaceChildren();
    pick.append(Object.assign(el('option', '', list.length > 0 ? 'Saved recipients…' : 'No saved recipients yet'), { value: '' }));
    for (const r of list) pick.append(Object.assign(el('option', '', `${r.label} · ${r.address.length > 16 ? `${r.address.slice(0, 6)}…${r.address.slice(-4)}` : r.address}`), { value: r.address }));
    pick.disabled = list.length === 0;
    del.hidden = pick.value === '';
  };
  pick.addEventListener('change', () => {
    del.hidden = pick.value === '';
    if (pick.value) {
      to.value = pick.value;
      to.dispatchEvent(new Event('input', { bubbles: true }));
    }
    note.textContent = '';
  });
  save.addEventListener('click', () => {
    note.textContent = '';
    if (recipientKind(to.value) === null) {
      note.textContent = 'Type or paste an address or .sns name in the box first.';
      return;
    }
    ask.hidden = false;
    name.focus();
  });
  const commit = (): void => {
    const r = saveRecipient(store, name.value, to.value);
    if ('problem' in r) {
      note.textContent = r.problem;
      return;
    }
    name.value = '';
    ask.hidden = true;
    note.textContent = 'Saved in this browser.';
    draw();
  };
  ok.addEventListener('click', commit);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  });
  del.addEventListener('click', () => {
    removeRecipient(store, pick.value);
    note.textContent = 'Removed.';
    draw();
  });
  document.querySelector('[data-send-network]')?.addEventListener('change', draw);
  draw();
}
