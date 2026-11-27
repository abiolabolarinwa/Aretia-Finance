// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { balanceText, initTopBar } from './walletTopBar';

describe('the balance in the site bar', () => {
  it('shows the dashboard total, or a dash before it is known', () => {
    expect(balanceText('$1,240.55')).toBe('$1,240.55');
    expect(balanceText('—')).toBe('—');
    expect(balanceText('')).toBe('—');
    expect(balanceText(null)).toBe('—');
  });

  it('shows Connect before a wallet is connected, then the value and Deposit', async () => {
    document.body.innerHTML = `<header class="nav"><div class="nav__bar"><a class="nav__brand"></a></div></header>
      <div data-wapp data-connected="false"><div data-total>—</div><button data-connect></button></div>`;
    initTopBar();
    const [value, connect, deposit] = [...document.querySelectorAll<HTMLButtonElement>('.nav-balance button')];
    expect(connect!.hidden).toBe(false);
    expect(value!.hidden).toBe(true);
    document.querySelector<HTMLElement>('[data-wapp]')!.dataset.connected = 'true';
    document.querySelector('[data-total]')!.textContent = '$52.10';
    await new Promise((r) => setTimeout(r, 0));
    expect(value!.hidden).toBe(false);
    expect(deposit!.hidden).toBe(false);
    expect(connect!.hidden).toBe(true);
    expect(value!.textContent).toBe('$52.10');
  });
});
