import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToaster, TOAST_MS } from './walletToast.js';

/** A very small stand-in for the parts of the DOM the toaster touches. */
class Node_ {
  children: Node_[] = [];
  parent: Node_ | null = null;
  className = '';
  textContent = '';
  attrs: Record<string, string> = {};
  constructor(readonly tag: string) {}
  get isConnected(): boolean {
    const root = (n: Node_): Node_ => (n.parent ? root(n.parent) : n);
    return root(this).tag === 'body';
  }
  append(...kids: Node_[]): void {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
  }
  replaceChildren(...kids: Node_[]): void {
    this.children.forEach((c) => (c.parent = null));
    this.children = [];
    this.append(...kids);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
}

const fakeDoc = () => {
  const body = new Node_('body');
  const doc = { body, createElement: (t: string) => new Node_(t) };
  return { doc: doc as unknown as Document, body };
};
const shown = (body: Node_): Node_[] => (body.children[0]?.children ?? []);

describe('the price-alert pop-up', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays for exactly two seconds and is then gone at once', () => {
    const { doc, body } = fakeDoc();
    createToaster(doc).show({ title: 'HOODIE ▲ +6.0%', detail: '$1.06, was $1', tone: 'up' });
    expect(TOAST_MS).toBe(2000);
    expect(shown(body)).toHaveLength(1);
    vi.advanceTimersByTime(1999);
    expect(shown(body)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(shown(body)).toHaveLength(0);
  });

  it('shows queued alerts one at a time, two seconds each', () => {
    const { doc, body } = fakeDoc();
    const t = createToaster(doc);
    t.show({ title: 'A' });
    t.show({ title: 'B' });
    t.show({ title: 'C' });
    const titleOf = (): string | undefined => shown(body)[0]?.children[0]?.children[0]?.textContent;
    expect(titleOf()).toBe('A');
    vi.advanceTimersByTime(2000);
    expect(titleOf()).toBe('B');
    vi.advanceTimersByTime(2000);
    expect(titleOf()).toBe('C');
    vi.advanceTimersByTime(2000);
    expect(shown(body)).toHaveLength(0);
  });

  it('is announced politely to screen readers and starts again after it has emptied', () => {
    const { doc, body } = fakeDoc();
    const t = createToaster(doc);
    t.show({ title: 'A' });
    expect(body.children[0]!.attrs).toMatchObject({ role: 'status', 'aria-live': 'polite' });
    vi.advanceTimersByTime(2000);
    t.show({ title: 'B' });
    expect(shown(body)).toHaveLength(1);
  });
});
