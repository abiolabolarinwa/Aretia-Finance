// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applySteps, assignPages } from './launchSteps';

/** A create form shaped like walletLaunch.ts draws it. */
function form(): HTMLFormElement {
  const f = document.createElement('form');
  f.className = 'wapp__form wapp-ln__form';
  f.innerHTML = `<div class="wapp-ln__row wapp-ln__row--wide"><input id="launch-name"><input id="launch-symbol"></div>
    <section class="lh-det"></section>
    <div class="wapp-ln__field"><input id="launch-supply"></div>
    <div class="wapp-ln__row"><input id="launch-creatorPct"></div>
    <details class="lh-adv"></details>
    <ul class="lh-promises"></ul>
    <div class="lh-check-host"></div>
    <button type="submit">Review</button>`;
  document.body.replaceChildren(f);
  return f;
}

describe('the Create a token steps', () => {
  it('puts name and symbol first, the picture and links second, supply and options third, the checklist and Review last', () => {
    expect(assignPages([...form().children])).toEqual([1, 2, 3, 3, 3, 3, 4, 4]);
  });
  it('leaves other forms alone', () => {
    const f = document.createElement('form');
    f.innerHTML = '<div><input id="pool-amount"></div><button>Go</button>';
    expect(assignPages([...f.children])).toBeNull();
  });
  it('shows one step at a time with Back and Next, and Review only on the last step', () => {
    const f = form();
    applySteps(f, true);
    expect(f.dataset.lnStep).toBe('1');
    const [back, next] = [...f.querySelectorAll<HTMLButtonElement>('.lh-steps-nav button')];
    expect(back!.hidden).toBe(true);
    next!.click();
    expect(f.dataset.lnStep).toBe('2');
    expect(f.querySelector('.lh-steps-head')!.textContent).toContain('Step 2 of 4');
    next!.click();
    next!.click();
    expect(f.dataset.lnStep).toBe('4');
    expect(next!.hidden).toBe(true);
    back!.click();
    expect(f.dataset.lnStep).toBe('3');
  });
  it('opens on the step with a field marked wrong', () => {
    const f = form();
    f.querySelector('#launch-supply')!.setAttribute('aria-invalid', 'true');
    applySteps(f, true);
    expect(f.dataset.lnStep).toBe('3');
  });
  it('shows the whole form on wider screens', () => {
    const f = form();
    applySteps(f, true);
    applySteps(f, false);
    expect(f.hasAttribute('data-ln-step')).toBe(false);
    expect(f.querySelector('[data-ln-page], .lh-steps-nav, .lh-steps-head')).toBeNull();
  });
});
