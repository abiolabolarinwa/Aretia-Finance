// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { insightsOf, openInsight, syncInsightChips } from './walletInsights';

function page(): HTMLElement {
  document.body.innerHTML = `<div class="wapp-mt__card">
    <div class="wapp-mt__stats"><div>24H VOLUME $37M</div></div>
    <div class="wapp-ov">
      <div class="wapp-ov__cards">
        <div class="wapp-ov__card"><p class="wapp-ov__title">Market mood</p><div class="wapp-ov__score">62</div></div>
        <div class="wapp-ov__card"><p class="wapp-ov__title">Rising or falling</p></div>
      </div>
      <div class="wapp-ov__lists"><div class="wapp-ov__panel"><p class="wapp-ov__ptitle">Top gainers</p></div></div>
    </div>
    <div class="wapp-mt__bar"></div>
    <div class="wapp-mt__main"></div>
  </div>`;
  return document.querySelector<HTMLElement>('.wapp-mt__card')!;
}

describe('the Markets overview on phones', () => {
  it('names each piece, the mood with its score', () => {
    expect(insightsOf(page()).map((i) => i.label)).toEqual(['24H activity', 'Market mood 62', 'Rising or falling', 'Top gainers']);
  });

  it('puts one chip per piece right after the tabs, and does not rebuild them when nothing changed', () => {
    const card = page();
    syncInsightChips();
    const row = card.querySelector('.wapp-ins')!;
    expect(row.previousElementSibling?.className).toBe('wapp-mt__bar');
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['24H activity', 'Market mood 62', 'Rising or falling', 'Top gainers']);
    const first = row.querySelector('button');
    syncInsightChips();
    expect(card.querySelector('.wapp-ins button')).toBe(first);
  });

  it('opens a piece in the sheet and puts it back in its place on close', () => {
    const card = page();
    syncInsightChips();
    const mood = card.querySelectorAll<HTMLElement>('.wapp-ov__card')[0]!;
    card.querySelectorAll<HTMLButtonElement>('.wapp-ins button')[1]!.click();
    const sheet = document.querySelector('.wapp-ins-sheet')!;
    expect(sheet.hasAttribute('open')).toBe(true);
    expect(sheet.querySelector('.wapp-ins-sheet__body')!.firstElementChild).toBe(mood);
    expect(sheet.querySelector('strong')!.textContent).toBe('Market mood 62');
    sheet.click(); // a tap outside the sheet (on its backdrop)
    expect(sheet.hasAttribute('open')).toBe(false);
    expect(card.querySelector('.wapp-ov__cards')!.firstElementChild).toBe(mood);
  });

  it('drops the old piece if the overview was redrawn while the sheet was open', () => {
    const card = page();
    const items = insightsOf(card);
    openInsight(items[1]!);
    card.querySelector('.wapp-ov')!.replaceWith(document.createElement('div'));
    document.querySelector<HTMLDialogElement>('.wapp-ins-sheet')!.click();
    expect(items[1]!.el.isConnected).toBe(false);
  });
});
