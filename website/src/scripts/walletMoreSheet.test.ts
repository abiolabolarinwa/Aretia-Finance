// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { initMoreSheet } from './walletMoreSheet';

function page(): HTMLElement {
  document.body.innerHTML = `<div data-wapp><nav class="wapp__nav"><button data-nav="dashboard"></button><button data-nav="radar"></button>
    <button data-more aria-expanded="false"><span data-more-label>More</span></button></nav><div data-more-scrim hidden></div></div>`;
  const root = document.querySelector<HTMLElement>('[data-wapp]')!;
  initMoreSheet(root);
  return root;
}

describe('the More sheet', () => {
  it('opens and closes from the More button', () => {
    const root = page();
    const more = root.querySelector<HTMLButtonElement>('[data-more]')!;
    more.click();
    expect(root.hasAttribute('data-more-open')).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-more-label]')!.textContent).toBe('Close');
    expect(root.querySelector<HTMLElement>('[data-more-scrim]')!.hidden).toBe(false);
    more.click();
    expect(root.hasAttribute('data-more-open')).toBe(false);
    expect(root.querySelector('[data-more-label]')!.textContent).toBe('More');
  });
  it('closes when a section is picked, the scrim is tapped or Escape is pressed', () => {
    const root = page();
    const more = root.querySelector<HTMLButtonElement>('[data-more]')!;
    more.click();
    root.querySelector<HTMLButtonElement>('[data-nav="radar"]')!.click();
    expect(root.hasAttribute('data-more-open')).toBe(false);
    more.click();
    root.querySelector<HTMLElement>('[data-more-scrim]')!.click();
    expect(root.hasAttribute('data-more-open')).toBe(false);
    more.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.hasAttribute('data-more-open')).toBe(false);
  });
});
