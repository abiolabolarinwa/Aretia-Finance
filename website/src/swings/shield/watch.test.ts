import { describe, expect, it } from 'vitest';
import { AddressBook, BOOK_MAX, cleanLabel } from './addressBook.js';
import { fingerprintOf, WATCH_MAX, WatchStore, worsened } from './watch.js';
import { buildVerdict } from './verdict.js';
import type { Finding, Subject, Verdict } from './types.js';
import type { StorageLike } from '../history.js';

const memory = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const subject: Subject = { kind: 'solana-token', chain: 'solana', value: 'Tok3nTok3nTok3nTok3nTok3nTok3nTok3nTok3nTok3', label: 'ABC', icon: null };
const f = (id: string, severity: Finding['severity']): Finding => ({ id, severity, title: `title ${id}`, detail: 'd' });
const verdict = (...findings: Finding[]): Verdict => buildVerdict({ subject, findings, couldNot: [], now: 1 });

describe('the address book', () => {
  const A = 'GkXn6PUubyYHHE1h7tVd9bGswwSKoLaGBdBr4eDUdaWa';
  const B = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  it('keeps a book for each wallet, apart', () => {
    const m = memory();
    new AddressBook(m, 'OWNER1').trust(A, 'Mum');
    expect(new AddressBook(m, 'OWNER1').list()).toHaveLength(1);
    expect(new AddressBook(m, 'OWNER2').list()).toEqual([]);
    expect(new AddressBook(m, null).list()).toEqual([]);
  });
  it('remembers a recipient once, keeps the name of a saved one, and finds EVM addresses in any letter case', () => {
    const book = new AddressBook(memory(), 'O');
    book.trust(A, 'Mum');
    book.rememberSent(A);
    book.rememberSent(B);
    book.rememberSent(B.toLowerCase());
    expect(book.list()).toHaveLength(2);
    expect(book.find(A)).toMatchObject({ label: 'Mum', trusted: true });
    expect(book.find(B.toUpperCase().replace('0X', '0x'))).toMatchObject({ trusted: false, label: null });
    book.remove(A);
    expect(book.find(A)).toBeNull();
  });
  it('cleans a name, caps the book, and ignores damaged storage', () => {
    expect(cleanLabel('  Mum\u0000\u0007 ' + 'x'.repeat(100))).toHaveLength(40);
    const m = memory();
    const book = new AddressBook(m, 'O');
    for (let i = 0; i < BOOK_MAX + 20; i++) book.rememberSent('0x' + i.toString(16).padStart(40, '0'));
    expect(book.list()).toHaveLength(BOOK_MAX);
    m.data.set('aretia-shield-book-v1:O', '{oops');
    expect(book.list()).toEqual([]);
    m.data.set('aretia-shield-book-v1:O', JSON.stringify([{ address: 'x' }, null]));
    expect(book.list()).toEqual([]);
  });
});

describe('watching', () => {
  it('fingerprints the problems, cautions and notes, and whether a lock was found', () => {
    const fp = fingerprintOf(verdict(f('mint', 'warn'), f('lock', 'ok'), f('passed', 'ok'), f('age', 'note')));
    expect(fp).toEqual({ band: 'orange', issues: ['age', 'mint'], locked: true });
  });
  it('says nothing when it is the same, or better', () => {
    const before = verdict(f('mint', 'warn'));
    const same = worsened(fingerprintOf(before), fingerprintOf(before), before);
    expect(same).toBeNull();
    const better = verdict(f('passed', 'ok'));
    expect(worsened(fingerprintOf(before), fingerprintOf(better), better)).toBeNull();
  });
  it('says so when the colour gets worse, and what changed', () => {
    const before = verdict(f('passed', 'ok'));
    const after = verdict(f('passed', 'ok'), f('owner', 'bad'));
    const change = worsened(fingerprintOf(before), fingerprintOf(after), after)!;
    expect(change.tone).toBe('down');
    expect(change.title).toBe('ABC: Shield now says red');
    expect(change.detail).toMatch(/green to red/);
    expect(change.detail).toMatch(/title owner/);
  });
  it('says so when a new caution appears without the colour moving, and when a lock disappears', () => {
    const before = verdict(f('a', 'warn'), f('lock', 'ok'));
    const after = verdict(f('a', 'warn'), f('b', 'warn'));
    const change = worsened(fingerprintOf(before), fingerprintOf(after), after)!;
    expect(change.detail).toMatch(/title b/);
    expect(change.detail).toMatch(/lock is no longer found/);
  });
  it('does not alarm on a first check, or when the earlier colour was grey', () => {
    const v = verdict(f('a', 'bad'));
    expect(worsened(null, fingerprintOf(v), v)).toBeNull();
    const grey = verdict();
    expect(worsened(fingerprintOf(grey), fingerprintOf(v), v)?.detail).not.toMatch(/went from grey/);
  });
  it('keeps a list: add, no duplicates, a limit, remove, and record the latest check', () => {
    const store = new WatchStore(memory(), () => 100);
    const v = verdict(f('a', 'note'));
    expect(store.add('X', 'Xtoken', v)).toBe(true);
    expect(store.add('X', null, null)).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.has('X')).toBe(true);
    store.record('X', verdict(f('a', 'bad')));
    expect(store.list()[0]!.last!.band).toBe('red');
    for (let i = 0; i < WATCH_MAX + 3; i++) store.add(`v${i}`, null, null);
    expect(store.list()).toHaveLength(WATCH_MAX);
    expect(store.add('another', null, null)).toBe(false);
    store.remove('X');
    expect(store.has('X')).toBe(false);
  });
  it('ignores damaged storage', () => {
    const m = memory();
    m.data.set('aretia-shield-watch-v1', '{oops');
    expect(new WatchStore(m).list()).toEqual([]);
    m.data.set('aretia-shield-watch-v1', JSON.stringify([{ value: '' }, { value: 'ok', label: null, addedAt: 1, checkedAt: null, last: null }]));
    expect(new WatchStore(m).list().map((w) => w.value)).toEqual(['ok']);
  });
});

describe('the guard for Pay', () => {
  const MINE = 'GkXn6PUubyYHHE1h7tVd9bGswwSKoLaGBdBr4eDUdaWa';
  const FAKE = MINE.slice(0, 4) + 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' + MINE.slice(-4);
  const known = [{ address: MINE, label: 'Mum', trusted: true, lastUsed: 1 }];
  it('is calm for an address you saved, and for your own wallet', async () => {
    const { guardRecipient } = await import('./guard.js');
    expect(guardRecipient(MINE, known, null)).toMatchObject({ needsAck: false, findings: [{ id: 'trusted', severity: 'ok' }] });
    expect(guardRecipient(MINE, [], MINE).findings[0]!.id).toBe('own');
  });
  it('blocks until acknowledged when the address imitates one you know', async () => {
    const { guardRecipient } = await import('./guard.js');
    const g = guardRecipient(FAKE, known, null);
    expect(g.needsAck).toBe(true);
    expect(g.findings[0]).toMatchObject({ id: 'lookalike', severity: 'bad' });
    expect(g.findings[0]!.title).toMatch(/Mum/);
  });
  it('notes a first payment to a stranger, without blocking', async () => {
    const { guardRecipient } = await import('./guard.js');
    const g = guardRecipient('9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT', known, null);
    expect(g).toMatchObject({ needsAck: false, findings: [{ id: 'first-time', severity: 'note' }] });
  });
});
