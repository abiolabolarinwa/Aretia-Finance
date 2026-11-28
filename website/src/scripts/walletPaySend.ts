/**
 * Phones: Pay > Send laid out the way people think about a payment: what (one coin button that opens a sheet of everything you hold,
 * network by network), how much (the dollar value beside it, 25% / 50% / Max, the network fee and what is left after), to whom (Paste,
 * saved recipients as chips, and a live check of the address), then Review, which only lights up once all of that is right.
 *
 * It sits on top of the form and drives the form's own fields (the network and asset boxes, the amount and recipient boxes), so the
 * checks, the review screen and the wallet's approval are exactly the ones the form already has. Wider screens keep the form as it is.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { loadBook, suitsNetwork, type SavedRecipient } from './walletAddressBook';
import { closeInsight, openInsight } from './walletInsights';
import { isSolanaAddress } from './walletTools';
import type { StorageLike } from '../swings/history.js';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SNS = /^[^\s@/:]+\.sol$|^[^\s@/:]+\.sns$/i;

export type RecipientCheck = { tone: 'ok' | 'warn' | 'bad' | 'none'; text: string };

/** What the page can say about a recipient before Review, for the chosen network. Pure. */
export function checkRecipient(value: string, network: string, own: readonly string[], saved: readonly string[]): RecipientCheck {
  const v = value.trim();
  if (v === '') return { tone: 'none', text: '' };
  const name = network === 'solana' ? 'Solana' : (CHAINS[network as ChainId]?.name ?? network);
  const evm = network !== 'solana';
  const lower = v.toLowerCase();
  if (own.some((o) => o && o.toLowerCase() === lower)) return { tone: 'bad', text: 'This is your own address.' };
  if (!evm && SNS.test(v)) return { tone: 'ok', text: 'A .sns name: the address it points to is shown at Review.' };
  const valid = evm ? EVM.test(v) : isSolanaAddress(v);
  if (!valid) return { tone: 'bad', text: evm ? `Not a ${name} address: it starts with 0x and has 42 characters.` : `Not a Solana address or .sns name.` };
  if (saved.some((s) => s.toLowerCase() === lower)) return { tone: 'ok', text: `A saved recipient · valid ${name} address.` };
  return { tone: 'warn', text: `Valid ${name} address. New recipient: check every character at Review.` };
}

/** A typed amount as a number, or null when it is not one. Pure. */
export function amountOf(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A token amount for a box: at most `decimals` places, no trailing zeros, no exponent. Pure. */
export function tokenText(n: number, decimals = 9): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const fixed = n.toFixed(Math.min(decimals, 9));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

const usd = (n: number): string => (n >= 1 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}` : `$${n.toPrecision(2)}`);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The network's logo; the name is looked up in Aretia's own list, never taken from the page as it is. */
function chainLogo(chain: string, cls: string): HTMLImageElement {
  const img = el('img', cls);
  const known = (Object.keys(CHAINS) as string[]).find((c) => c === chain) ?? 'solana';
  img.src = `/assets/chains/${known}.png`;
  img.alt = '';
  return img;
}

function coinPic(o: HTMLOptionElement | null, chain: string): HTMLElement {
  // Only a plain https picture address is used.
  let icon: string | null = null;
  try {
    const u = new URL(o?.dataset.icon ?? '');
    if (u.protocol === 'https:') icon = `https://${u.host}${u.pathname}${u.search}`;
  } catch {
    icon = null;
  }
  if (icon) {
    const img = el('img', 'wps-coin__pic');
    img.src = icon;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(el('span', 'wps-coin__pic', (o?.dataset.symbol ?? '?').slice(0, 2).toUpperCase())), { once: true });
    return img;
  }
  if (o?.dataset.native === '1') return chainLogo(chain, 'wps-coin__pic');
  return el('span', 'wps-coin__pic', (o?.dataset.symbol ?? '?').slice(0, 2).toUpperCase());
}

export function initPaySend(store: StorageLike | null): void {
  if (typeof window === 'undefined' || !window.matchMedia('(max-width: 720px)').matches) return;
  const form = document.querySelector<HTMLFormElement>('[data-send-form]');
  const hero = form?.querySelector<HTMLElement>('.wapp-pay__hero');
  const toBox = form?.querySelector<HTMLElement>('.wapp-pay__to');
  const asset = form?.querySelector<HTMLSelectElement>('[data-send-asset]');
  const amount = form?.querySelector<HTMLInputElement>('[data-send-amount]');
  const to = form?.querySelector<HTMLInputElement>('[data-send-to]');
  if (!form || !hero || !toBox || !asset || !amount || !to || form.dataset.wps === '1') return;
  form.dataset.wps = '1';
  form.classList.add('wps');
  const network = form.querySelector<HTMLSelectElement>('[data-send-network]');
  const net = (): string => network?.value ?? 'solana';
  const chosen = (): HTMLOptionElement | null => (asset.disabled || !asset.value ? null : asset.selectedOptions[0] ?? null);
  const held = (): number | null => {
    const a = Number(chosen()?.dataset.amount);
    return Number.isFinite(a) ? a : null;
  };
  const price = (): number | null => {
    const p = Number(chosen()?.dataset.price);
    return chosen()?.dataset.price && Number.isFinite(p) && p > 0 ? p : null;
  };

  // ---- 1. What: one coin button, a sheet of networks and coins
  const coin = el('button', 'wps-coin');
  coin.type = 'button';
  coin.setAttribute('aria-label', 'Choose what to send');
  hero.prepend(coin);
  const drawCoin = (): void => {
    const o = chosen();
    const chain = net();
    const pic = el('span', 'wps-coin__pics');
    pic.append(coinPic(o, chain), chainLogo(chain, 'wps-coin__net'));
    const text = el('span', 'wps-coin__text');
    if (o) text.append(el('strong', '', o.dataset.symbol ?? o.text), el('small', '', `${chain === 'solana' ? 'Solana' : CHAINS[chain as ChainId]?.name ?? chain} · balance ${o.dataset.amountText ?? ''}`));
    else text.append(el('strong', '', 'Choose a coin'), el('small', '', asset.selectedOptions[0]?.text ?? ''));
    coin.replaceChildren(pic, text, el('span', 'wps-coin__chev', '⌄'));
  };

  const sheet = el('div', 'wps-sheet');
  const drawSheet = (): void => {
    sheet.replaceChildren();
    if (network) {
      const nets = el('div', 'wps-sheet__nets');
      for (const o of [...network.options]) {
        const b = el('button', 'wps-net');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(o.value === network.value));
        b.append(chainLogo(o.value, 'wps-net__logo'), el('span', '', o.text));
        b.addEventListener('click', () => {
          if (network.value === o.value) return;
          network.value = o.value;
          network.dispatchEvent(new Event('change', { bubbles: true }));
          drawSheet();
        });
        nets.append(b);
      }
      sheet.append(nets);
    }
    const list = el('ul', 'wps-sheet__list');
    const options = [...asset.options].filter((o) => o.value);
    if (asset.disabled || options.length === 0) list.append(el('li', 'wps-sheet__note', asset.options[0]?.text ?? 'Nothing to send here yet.'));
    for (const o of options) {
      const li = el('li');
      const b = el('button', 'wps-row');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(o.value === asset.value));
      const value = Number(o.dataset.value);
      b.append(coinPic(o, net()), el('span', 'wps-row__names'), el('span', 'wps-row__side'));
      b.children[1]!.append(el('strong', '', o.dataset.symbol ?? o.text), el('small', '', o.dataset.name ?? ''));
      b.children[2]!.append(el('strong', '', o.dataset.value && Number.isFinite(value) ? usd(value) : '—'), el('small', '', o.dataset.amountText ?? ''));
      b.addEventListener('click', () => {
        asset.value = o.value;
        asset.dispatchEvent(new Event('change', { bubbles: true }));
        closeInsight();
        refresh();
      });
      li.append(b);
      list.append(li);
    }
    sheet.append(list);
  };
  coin.addEventListener('click', () => {
    drawSheet();
    openInsight({ label: 'Send what', el: sheet });
  });

  // ---- 2. How much: dollar value, quick shares, fee and what is left
  const usdIn = el('input', 'wapp__input wps-usd');
  usdIn.inputMode = 'decimal';
  usdIn.autocomplete = 'off';
  usdIn.placeholder = '$0.00';
  usdIn.setAttribute('aria-label', 'Amount in US dollars');
  usdIn.hidden = true;
  amount.after(usdIn);
  let inUsd = false;
  const line = el('div', 'wps-line');
  const flip = el('button', 'wps-flip');
  flip.type = 'button';
  const lineText = el('span', 'wps-line__text');
  line.append(lineText, flip);
  const shares = el('div', 'wps-shares');
  for (const [label, pct] of [['25%', 0.25], ['50%', 0.5], ['Max', 1]] as const) {
    const b = el('button', 'wps-share', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      // Max is the form's own (it leaves room for the network fee); the others are a share of the balance.
      if (pct === 1) form.querySelector<HTMLButtonElement>('[data-send-max]')?.click();
      else {
        const h = held();
        if (h === null) return;
        amount.value = tokenText(h * pct, Number(chosen()?.dataset.decimals ?? 9));
      }
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      window.setTimeout(refresh, 400);
    });
    shares.append(b);
  }
  const fee = el('p', 'wps-fee');
  const amountBox = hero.querySelector('.wapp__amount');
  amountBox?.after(line, shares, fee);
  flip.addEventListener('click', () => {
    if (price() === null) return;
    inUsd = !inUsd;
    const a = amountOf(amount.value);
    usdIn.value = inUsd && a !== null ? (a * price()!).toFixed(2) : '';
    refresh();
    (inUsd ? usdIn : amount).focus();
  });
  usdIn.addEventListener('input', () => {
    const d = amountOf(usdIn.value);
    const p = price();
    amount.value = d !== null && p !== null ? tokenText(d / p, Number(chosen()?.dataset.decimals ?? 9)) : '';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ---- 3. To whom: Paste, saved recipients, a live check
  const paste = el('button', 'wps-paste', 'Paste');
  paste.type = 'button';
  paste.setAttribute('aria-label', 'Paste an address');
  // The box and its Paste button share a frame, so Paste sits inside the box.
  const field = el('div', 'wps-field');
  to.before(field);
  field.append(to, paste);
  paste.addEventListener('click', async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) {
        to.value = t.slice(0, 120);
        to.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    } catch {
      // The phone did not let the page read the clipboard: a long press in the box offers its own Paste.
    }
    to.focus();
    check.textContent = 'Press and hold in the box, then choose Paste.';
    check.dataset.tone = 'none';
  });
  const people = el('div', 'wps-people');
  people.setAttribute('aria-label', 'Saved recipients');
  const check = el('p', 'wps-check');
  check.setAttribute('aria-live', 'polite');
  toBox.querySelector('label')?.after(people);
  toBox.append(check);
  const saved = (): SavedRecipient[] => suitsNetwork(loadBook(store), net());
  const drawPeople = (): void => {
    people.replaceChildren();
    // No row at all until someone is saved; a new valid address offers Save under the box instead.
    people.hidden = saved().length === 0;
    for (const r of saved().slice(0, 12)) {
      const b = el('button', 'wps-person');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(to.value.trim() === r.address));
      b.append(el('span', 'wps-person__dot', r.label.slice(0, 1).toUpperCase()), el('span', 'wps-person__name', r.label));
      b.addEventListener('click', () => {
        to.value = r.address;
        to.dispatchEvent(new Event('input', { bubbles: true }));
      });
      people.append(b);
    }
    const add = el('button', 'wps-person wps-person--add');
    add.type = 'button';
    add.append(el('span', 'wps-person__dot', '+'), el('span', 'wps-person__name', 'Save'));
    add.title = 'Save the address in the box under a name (kept on this phone only)';
    add.addEventListener('click', () => toBox.querySelector<HTMLButtonElement>('.wapp-book > .wapp__btn')?.click());
    people.append(add);
  };
  const saveLink = el('button', 'wps-save', 'Save this recipient');
  saveLink.type = 'button';
  saveLink.hidden = true;
  saveLink.addEventListener('click', () => toBox.querySelector<HTMLButtonElement>('.wapp-book > .wapp__btn')?.click());

  // ---- 4. Review lights up when everything is right
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const refresh = (): void => {
    drawCoin();
    const o = chosen();
    const p = price();
    const a = amountOf(amount.value);
    const h = held();
    const sym = o?.dataset.symbol ?? '';
    amount.hidden = inUsd;
    usdIn.hidden = !inUsd;
    flip.hidden = p === null;
    flip.textContent = inUsd ? `Type in ${sym || 'coins'}` : 'Type in $';
    if (inUsd) lineText.textContent = a !== null ? `≈ ${tokenText(a, 6)} ${sym}` : `≈ 0 ${sym}`;
    else lineText.textContent = p !== null ? (a !== null ? `≈ ${usd(a * p)}` : '≈ $0.00') : o ? 'No dollar price for this token' : '';
    const over = a !== null && h !== null && a > h;
    const feeText = net() === 'solana' ? 'Network fee about 0.000005 SOL' : `Network fee in ${CHAINS[net() as ChainId]?.nativeSymbol ?? 'the coin'}, shown at Review`;
    fee.textContent = !o ? '' : over ? `More than your balance (${o.dataset.amountText ?? ''} ${sym}).` : `${feeText}${a !== null && h !== null ? ` · left after: ${tokenText(h - a, 6)} ${sym}` : ''}`;
    fee.dataset.tone = over ? 'bad' : '';
    const own = (form.dataset.own ?? '').split(',');
    const c = checkRecipient(to.value, net(), own, saved().map((r) => r.address));
    check.textContent = c.text;
    check.dataset.tone = c.tone;
    saveLink.hidden = c.tone !== 'warn';
    if (!saveLink.isConnected) check.after(saveLink);
    paste.hidden = to.value.trim() !== '';
    people.querySelectorAll<HTMLButtonElement>('.wps-person:not(.wps-person--add)').forEach((b, i) => b.setAttribute('aria-pressed', String(saved()[i]?.address === to.value.trim())));
    const ready = !!o && a !== null && a > 0 && !over && (c.tone === 'ok' || c.tone === 'warn');
    form.classList.toggle('is-ready', ready);
    if (submit) submit.textContent = ready ? `Review sending ${sym}` : !o ? 'Choose a coin' : a === null || a <= 0 ? 'Enter an amount' : over ? 'Not enough balance' : 'Add a recipient';
  };
  for (const n of [amount, to]) n.addEventListener('input', refresh);
  asset.addEventListener('change', () => {
    inUsd = false;
    refresh();
  });
  network?.addEventListener('change', () => {
    drawPeople();
    refresh();
  });
  new MutationObserver(() => {
    refresh();
    if (sheet.isConnected) drawSheet();
  }).observe(asset, { childList: true, attributes: true, attributeFilter: ['disabled'] });
  // A recipient saved through the form's own Save shows as a chip straight away.
  toBox.addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest?.('.wapp-book__ask .wapp__btn--primary')) window.setTimeout(drawPeople, 0);
  });
  toBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as Element | null)?.closest?.('.wapp-book__ask')) window.setTimeout(drawPeople, 0);
  });

  // ---- 5. The checks from "Before you send" appear on the review screen itself, where the send is confirmed
  const review = form.parentElement?.querySelector<HTMLElement>('[data-send-review]');
  const tips = [...document.querySelectorAll('[data-pay-tips-card] li')].map((li) => li.textContent ?? '').filter(Boolean).slice(0, 3);
  if (review && tips.length > 0)
    new MutationObserver(() => {
      if (review.childElementCount === 0 || review.querySelector('.wps-tips')) return;
      const box = el('details', 'wps-tips');
      box.append(el('summary', '', 'Before you confirm'));
      const ul = el('ul');
      for (const t of tips) ul.append(el('li', '', t));
      box.append(ul);
      review.append(box);
    }).observe(review, { childList: true });

  drawPeople();
  refresh();
}
