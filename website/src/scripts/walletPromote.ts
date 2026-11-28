/**
 * "Promote your token" inside the web wallet: a short guided dialog (choose what you want, give the details, see what happens next),
 * so nobody has to leave the wallet to ask. It checks the answers with src/lib/requests.ts, then posts them to the site's Formspree form.
 * It takes no payment: a request is a message, and any price is agreed in writing afterwards. Everything typed is shown with textContent.
 */
import { LINKS } from '../data/site';
import { CHAINS } from '../swings/core/types';
import { FEATURED_PRICE_NOTE } from '../lib/featured';
import { DURATIONS, EVM_NETWORKS, featuredWindow, guessNetwork, shortDay, tomorrow } from '../lib/promoteFlow';
import { REQUEST_LIMITS, hasErrors, validateRequest, type RequestFields, type RequestKind } from '../lib/requests';

const STYLE_ID = 'aretia-promote-style';
const CONTACT_KEY = 'aretia-promote-contact';
const CSS = `
.apr{width:min(32rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);padding:0;border:1px solid rgba(17,17,20,.12);border-radius:20px;color:#111114;background:#fff;box-shadow:0 24px 60px rgba(17,17,20,.3);overflow:auto;font-family:inherit}
.apr::backdrop{background:rgba(17,17,20,.45)}
.apr__body{padding:1.25rem 1.25rem 1.1rem}
.apr__top{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.9rem}
.apr__step{font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b6b73}
.apr__x{display:grid;place-items:center;width:44px;height:44px;margin:-.5rem -.6rem -.5rem 0;border:0;border-radius:50%;background:transparent;color:#111114;font-size:1.4rem;line-height:1;cursor:pointer}
.apr__x:hover{background:#f1f1f3}
.apr h2{margin:0 0 .25rem;color:#111114;font-size:1.3rem;letter-spacing:-.01em}
.apr p{margin:.3rem 0;font-size:.88rem;line-height:1.45;color:#55555d}
.apr :focus-visible{outline:2px solid var(--color-brand,#3b3a9e);outline-offset:2px}
.apr__cards{display:grid;gap:.6rem;margin:1rem 0 .4rem}
.apr__card{display:grid;gap:.15rem;width:100%;padding:.9rem 1rem;border:1.5px solid rgba(17,17,20,.14);border-radius:14px;background:#fff;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background-color .15s,transform .15s}
.apr__card:hover{border-color:var(--color-brand,#3b3a9e);background:#f7f7fd}
.apr__card b{font-size:1rem}
.apr__card span{font-size:.85rem;line-height:1.4;color:#55555d}
.apr__card em{font-style:normal;font-size:.78rem;font-weight:700;color:var(--color-brand,#3b3a9e)}
.apr__how{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin:1rem 0 0;padding:0;list-style:none;counter-reset:s}
.apr__how li{counter-increment:s;padding:.6rem .65rem;border-radius:12px;background:#f5f5f7;font-size:.78rem;line-height:1.35;color:#55555d}
.apr__how li::before{content:counter(s);display:grid;place-items:center;width:1.4rem;height:1.4rem;margin-bottom:.3rem;border-radius:50%;background:#111114;color:#fff;font-size:.72rem;font-weight:700}
.apr__back{margin:0 0 .5rem -.4rem;min-height:44px;padding:0 .5rem;border:0;background:none;color:#55555d;font:600 .85rem inherit;font-family:inherit;cursor:pointer}
.apr__back:hover{color:#111114}
.apr label,.apr fieldset{display:grid;gap:.3rem;margin:.8rem 0 0;padding:0;border:0;font-size:.84rem;font-weight:600}
.apr legend{padding:0;font-size:.84rem;font-weight:600}
.apr label small,.apr .apr__hint{font-weight:400;font-size:.78rem;color:#6b6b73}
.apr input{width:100%;min-height:46px;padding:.55rem .75rem;border:1px solid rgba(17,17,20,.25);border-radius:12px;font:1rem inherit;font-family:inherit;color:inherit;background:#fff}
.apr input[aria-invalid='true']{border-color:#b42318}
.apr__err{min-height:1em;margin:0;font-size:.76rem;font-weight:400;color:#b42318}
.apr__chips{display:flex;flex-wrap:wrap;gap:.4rem}
.apr__chip{display:inline-flex;align-items:center;gap:.4rem;min-height:44px;padding:0 .9rem;border:1.5px solid rgba(17,17,20,.2);border-radius:999px;background:#fff;color:inherit;font:600 .85rem inherit;font-family:inherit;cursor:pointer}
.apr__chip img{width:18px;height:18px;border-radius:50%}
.apr__chip[aria-pressed='true']{color:#fff;background:#111114;border-color:#111114}
.apr__row{display:grid;gap:0 .6rem;grid-template-columns:1fr}
.apr__count{justify-self:end;font-weight:400;font-size:.74rem;color:#6b6b73}
.apr__preview{margin:1rem 0 0;padding:.75rem .85rem;border:1px dashed rgba(17,17,20,.25);border-radius:14px;background:#fafafb}
.apr__preview>span{display:block;margin-bottom:.45rem;font-size:.68rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b6b73}
.apr__pcard{display:grid;gap:.15rem;padding:.7rem .8rem;border:1px solid rgba(17,17,20,.12);border-radius:14px;background:#fff}
.apr__pcard i{font-style:normal;font-size:.64rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b6b73}
.apr__pcard b{font-size:.95rem;overflow-wrap:anywhere}
.apr__pcard small{font-size:.82rem;line-height:1.35;color:#151518;overflow-wrap:anywhere}
.apr__pcard em{font-style:normal;font-size:.74rem;color:#6b6b73}
.apr__price{margin:.8rem 0 0;padding:.6rem .75rem;border-radius:12px;background:#f5f5f7;font-size:.82rem;line-height:1.4;color:#111114}
.apr__actions{display:flex;gap:.6rem;margin-top:1rem}
.apr__actions button{min-height:48px;padding:0 1.3rem;border-radius:999px;font:600 .95rem inherit;font-family:inherit;cursor:pointer;border:1px solid #111114}
.apr__send{flex:1;color:#fff;background:#111114}
.apr__send[disabled]{opacity:.6;cursor:default}
.apr__close{color:#111114;background:#fff}
.apr__status{min-height:1.2em;font-weight:600}
.apr__status.is-err{color:#b42318}
.apr__done{display:grid;gap:.4rem;justify-items:start}
.apr__tick{display:grid;place-items:center;width:3rem;height:3rem;margin-bottom:.2rem;border-radius:50%;background:#e6f4ec;color:#0f5c3a;font-size:1.5rem;font-weight:700}
.apr__sum{width:100%;margin:.6rem 0 0;padding:.6rem .8rem;border-radius:12px;background:#f5f5f7;font-size:.82rem;line-height:1.5;color:#111114;overflow-wrap:anywhere}
.apr__next{margin:.6rem 0 0;padding-left:1.1rem;font-size:.86rem;line-height:1.5;color:#55555d}
.apr--wide{width:min(58rem,calc(100vw - 2rem))}
.apr__top{position:sticky;top:0;z-index:2;margin:-1.25rem -1.25rem .9rem;padding:.75rem 1.25rem;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);border-bottom:1px solid rgba(17,17,20,.08)}
.apr .apr__lead{max-width:62ch;margin:.35rem 0 0;font-size:.9rem;line-height:1.5;color:#55555d}
.apr__layout{display:grid;gap:1.25rem;margin-top:1rem}
.apr__sec{display:grid;gap:.15rem;margin:0 0 .9rem!important;padding:1rem!important;border:1px solid rgba(17,17,20,.1)!important;border-radius:16px;background:#fff}
.apr__sec>legend{float:left;width:100%;display:flex;align-items:center;gap:.5rem;margin:0 0 .2rem;font-size:.92rem;font-weight:700;color:#111114}
.apr__sec>legend::before{content:attr(data-n);display:grid;place-items:center;width:1.5rem;height:1.5rem;border-radius:50%;background:#eef0ff;color:var(--color-brand,#3b3a9e);font-size:.75rem;font-weight:800}
.apr__sec>legend+*{clear:both}
.apr__sec label,.apr__sec fieldset{margin-top:.65rem}
.apr__when{display:grid;gap:.8rem;align-items:start}
.apr__when label{margin-top:0}
.apr__aside{display:grid;gap:.75rem;align-content:start}
.apr__panel{padding:.9rem 1rem;border-radius:16px;background:#f6f6f8}
.apr__panel>span{display:block;margin-bottom:.55rem;font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b6b73}
.apr__fcard{display:grid;grid-template-columns:auto 1fr;gap:.2rem .75rem;align-items:center;padding:.85rem .9rem;border:1px solid rgba(17,17,20,.1);border-radius:14px;background:#fff;box-shadow:0 6px 18px -10px rgba(17,17,20,.35)}
.apr__favatar{grid-row:span 2;display:grid;place-items:center;width:2.6rem;height:2.6rem;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#3730a3);color:#fff;font-size:.8rem;font-weight:800}
.apr__fcard b{font-size:.98rem;line-height:1.2;overflow-wrap:anywhere}
.apr__fbadge{justify-self:start;padding:.1rem .45rem;border-radius:999px;background:#fff4d6;color:#7a5200;font-size:.62rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.apr__fcard small{grid-column:1/-1;margin-top:.35rem;font-size:.84rem;line-height:1.4;color:#33333a;overflow-wrap:anywhere}
.apr__fmeta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.45rem}
.apr__fmeta em{font-style:normal;padding:.15rem .55rem;border-radius:999px;background:#f1f1f3;font-size:.72rem;font-weight:600;color:#55555d}
.apr__fcard.is-empty b,.apr__fcard.is-empty small{color:#9a9aa2}
.apr__steps{margin:0;padding:0;list-style:none;display:grid;gap:.5rem;counter-reset:s}
.apr__steps li{counter-increment:s;display:grid;grid-template-columns:1.4rem 1fr;gap:.55rem;font-size:.82rem;line-height:1.4;color:#44444b}
.apr__steps li::before{content:counter(s);display:grid;place-items:center;width:1.4rem;height:1.4rem;border-radius:50%;background:#111114;color:#fff;font-size:.7rem;font-weight:700}
.apr__safe{margin:0!important;font-size:.78rem!important;color:#6b6b73!important}
.apr__actions--sticky{position:sticky;bottom:0;z-index:2;margin:1rem -1.25rem -1.1rem;padding:.8rem 1.25rem;background:rgba(255,255,255,.96);backdrop-filter:blur(8px);border-top:1px solid rgba(17,17,20,.08);align-items:center}
.apr__actions--sticky .apr__status{flex:1;margin:0;font-size:.82rem}
.apr__actions--sticky .apr__send{flex:0 0 auto}
@media(min-width:760px){.apr__layout{grid-template-columns:minmax(0,1fr) 18rem;align-items:start}.apr__aside{position:sticky;top:4.5rem}.apr__when{grid-template-columns:auto minmax(9rem,1fr)}}
@media(min-width:520px){.apr__row{grid-template-columns:1fr 1fr}}
@media(prefers-reduced-motion:reduce){.apr__card{transition:none}}
`;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const COPY: Record<RequestKind, { title: string; lead: string; send: string; subject: string; category: string; next: string[] }> = {
  featured: {
    title: 'Featured spot',
    lead: 'Your token on a small card marked Featured, at the top of Markets and on the Launch page, for the days you choose. Featured is a placement, not a rating or an endorsement.',
    send: 'Send my request',
    subject: 'Request: Featured launch',
    category: 'Featured request',
    next: ['We read your request and look at the token. We reply by email, usually within a day or two.', 'If we can feature it, the reply has the price and how to pay. You pay only after you agree.', 'Your card goes live on your first day.'],
  },
  verify: {
    title: 'Verified by Aretia',
    lead: 'We run four checks on one day: fixed supply, special powers given up, the project link matches, and a locked pool exists. We tell you what we found, including a failure. It is not an audit or an endorsement, and asking does not get the badge.',
    send: 'Send my request',
    subject: 'Request: Verified by Aretia',
    category: 'Verification request',
    next: ['We run the four checks on your token.', 'We reply by email with what we found, including anything that failed.', 'If all four pass, the badge shows on your token.'],
  },
};

type Step = 'choose' | 'form' | 'done';
interface Prefill {
  chain?: string;
  token?: string;
  title?: string;
  project?: string;
}

const readContact = (): string => {
  try {
    return localStorage.getItem(CONTACT_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveContact = (v: string): void => {
  try {
    localStorage.setItem(CONTACT_KEY, v);
  } catch {
    // the email is just not remembered
  }
};

/** Opens the dialog. `start` marks which choice is offered first; `prefill` fills in what the screen already knows. Safe from any wallet screen. */
export function openPromote(start: RequestKind = 'featured', prefill: Prefill = {}): void {
  if (!document.getElementById(STYLE_ID)) {
    const s = h('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.append(s);
  }
  let kind: RequestKind = start;
  let step: Step = 'choose';
  let sent: { title: string; lines: string[] } | null = null;
  // What has been typed so far survives going back and forth between the steps.
  const keep: Record<string, string> = { token: prefill.token ?? '', chain: prefill.chain ?? '', title: prefill.title ?? '', blurb: '', project: prefill.project ?? '', contact: readContact(), from: tomorrow(new Date()) };
  let days = 7;

  const dlg = h('dialog', 'apr');
  dlg.setAttribute('aria-label', 'Promote your token');
  const body = h('div', 'apr__body');
  dlg.append(body);

  const top = (label: string): HTMLElement => {
    const row = h('div', 'apr__top');
    const x = h('button', 'apr__x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => dlg.close());
    row.append(h('span', 'apr__step', label), x);
    return row;
  };

  function drawChoose(): void {
    body.append(top('Promote your token'), h('h2', '', 'How can we help your token?'), h('p', '', 'Pick one. It takes about a minute, and nothing is charged by this form.'));
    const cards = h('div', 'apr__cards');
    const order: RequestKind[] = start === 'verify' ? ['verify', 'featured'] : ['featured', 'verify'];
    for (const k of order) {
      const c = h('button', 'apr__card');
      c.type = 'button';
      c.append(h('b', '', COPY[k].title), h('span', '', k === 'featured' ? 'More people see your token: a card at the top of Markets and Launch.' : 'Four on-chain checks, reported honestly, and a badge if all four pass.'), h('em', '', k === 'featured' ? 'From $100 · pay only after we agree' : 'Free to request · the badge is not for sale'));
      c.addEventListener('click', () => {
        kind = k;
        step = 'form';
        draw();
      });
      cards.append(c);
    }
    const how = h('ol', 'apr__how');
    for (const t of ['You send a request.', 'We reply by email.', 'It goes live.']) how.append(h('li', '', t));
    body.append(cards, how);
  }

  function drawForm(): void {
    const back = h('button', 'apr__back', '← Back');
    back.type = 'button';
    back.addEventListener('click', () => {
      step = 'choose';
      draw();
    });
    body.append(top(`Step 2 of 2 · ${COPY[kind].title}`), back, h('h2', '', kind === 'featured' ? 'Tell us about your token' : 'Which token should we check?'), h('p', 'apr__lead', COPY[kind].lead));
    dlg.classList.add('apr--wide');

    const form = h('form');
    form.noValidate = true;
    const val = (n: string): string => (form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
    const errFor = (n: string): HTMLElement => {
      const e = h('span', 'apr__err');
      e.dataset.err = n;
      e.setAttribute('role', 'alert');
      return e;
    };
    const field = (name: string, label: string, opts: { type?: string; hint?: string; max?: number; placeholder?: string; autocomplete?: string; counter?: boolean } = {}): HTMLElement => {
      const wrap = h('label');
      wrap.append(document.createTextNode(label));
      if (opts.hint) wrap.append(h('small', '', opts.hint));
      const input = h('input');
      input.name = name;
      input.type = opts.type ?? 'text';
      input.value = keep[name] ?? '';
      if (opts.max) input.maxLength = opts.max;
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.setAttribute('autocomplete', opts.autocomplete ?? 'off');
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.addEventListener('input', () => {
        keep[name] = input.value;
      });
      wrap.append(input);
      if (opts.counter && opts.max) {
        const c = h('span', 'apr__count');
        const upd = (): void => {
          c.textContent = `${input.value.length} / ${opts.max}`;
        };
        input.addEventListener('input', upd);
        upd();
        wrap.append(c);
      }
      wrap.append(errFor(name));
      return wrap;
    };
    /** One numbered group of the form, so the person sees a few short steps instead of one long list. */
    const section = (n: number, title: string): HTMLFieldSetElement => {
      const f = h('fieldset', 'apr__sec');
      const l = h('legend', '', title);
      l.dataset.n = String(n);
      f.append(l);
      return f;
    };

    // 1. The token. The address comes first; the network is worked out from it, and only an 0x address needs a choice.
    const tokenSec = section(1, 'Your token');
    tokenSec.append(field('token', 'Token address', { hint: 'Paste it from the token page or your launch.', placeholder: 'Solana or 0x… address' }));
    const netBox = h('fieldset');
    const netLegend = h('legend', '', 'Which network?');
    netBox.append(netLegend);
    const chips = h('div', 'apr__chips');
    netBox.append(chips, errFor('chain'));
    tokenSec.append(netBox);
    const hid = h('input');
    hid.type = 'hidden';
    hid.name = 'chain';
    hid.value = keep.chain ?? '';
    tokenSec.append(hid);
    form.append(tokenSec);

    let drawPreview = (): void => undefined;

    const drawNetworks = (): void => {
      const tokenInput = form.elements.namedItem('token') as HTMLInputElement;
      const guess = guessNetwork(tokenInput.value);
      chips.textContent = '';
      if (guess === 'solana') hid.value = keep.chain = 'solana';
      else if (guess === null) hid.value = keep.chain = '';
      else if (!(EVM_NETWORKS as readonly string[]).includes(hid.value)) hid.value = keep.chain = '';
      netBox.hidden = guess === null;
      if (guess === null) return;
      const options = guess === 'solana' ? (['solana'] as const) : EVM_NETWORKS;
      netLegend.textContent = guess === 'solana' ? 'Network (found from the address)' : 'Which network is it on?';
      for (const id of options) {
        const b = h('button', 'apr__chip');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(hid.value === id));
        const img = h('img');
        img.src = `/assets/chains/${id}.png`;
        img.alt = '';
        img.width = 18;
        img.height = 18;
        b.append(img, document.createTextNode(CHAINS[id].name));
        b.addEventListener('click', () => {
          hid.value = keep.chain = id;
          drawNetworks();
          drawPreview();
        });
        chips.append(b);
      }
    };
    (form.elements.namedItem('token') as HTMLInputElement).addEventListener('input', () => {
      drawNetworks();
      drawPreview();
    });

    // The side column: the live card, the price, and what happens next. On a phone it follows the form.
    const aside = h('aside', 'apr__aside');
    aside.setAttribute('aria-label', 'Summary');

    if (kind === 'featured') {
      // 2. The card people will see.
      const cardSec = section(2, 'Your card');
      cardSec.append(
        field('title', 'Title', { hint: 'What people see first.', max: REQUEST_LIMITS.title, counter: true }),
        field('blurb', 'One line about it', { hint: 'Plain words, no promises.', max: REQUEST_LIMITS.blurb, counter: true }),
        field('project', 'Project link', { type: 'url', placeholder: 'https://', autocomplete: 'url', hint: 'Your website or page.' }),
      );
      form.append(cardSec);

      // 3. When: how long and from which day, side by side, with the dates it runs said in words.
      const whenSec = section(3, 'When it runs');
      const when = h('div', 'apr__when');
      const dur = h('fieldset');
      dur.append(h('legend', '', 'How long?'));
      const durChips = h('div', 'apr__chips');
      dur.append(durChips);
      const range = h('span', 'apr__hint');
      when.append(dur, field('from', 'Starts', { type: 'date' }));
      whenSec.append(when, range);
      form.append(whenSec);
      const drawDur = (): void => {
        durChips.textContent = '';
        for (const d of DURATIONS) {
          const b = h('button', 'apr__chip', `${d} days`);
          b.type = 'button';
          b.setAttribute('aria-pressed', String(days === d));
          b.addEventListener('click', () => {
            days = d;
            drawDur();
          });
          durChips.append(b);
        }
        const w = featuredWindow(val('from'), days);
        range.textContent = w ? `Runs ${shortDay(w.from)} to ${shortDay(w.to)}.` : 'Pick a start day.';
        drawPreview();
      };
      (form.elements.namedItem('from') as HTMLInputElement).addEventListener('input', drawDur);
      (form.elements.namedItem('from') as HTMLInputElement).min = tomorrow(new Date());

      // The live card, drawn the way it will look on Markets.
      const previewPanel = h('div', 'apr__panel');
      previewPanel.append(h('span', '', 'How your card will look'));
      const pc = h('div', 'apr__fcard');
      previewPanel.append(pc);
      drawPreview = (): void => {
        pc.textContent = '';
        const chain = val('chain');
        const title = val('title').trim();
        const blurb = val('blurb').trim();
        pc.classList.toggle('is-empty', !title && !blurb);
        const words = title.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        const letters = words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
        const meta = h('div', 'apr__fmeta');
        const name = chain && chain in CHAINS ? CHAINS[chain as keyof typeof CHAINS].name : '';
        if (name) meta.append(h('em', '', name));
        const w = featuredWindow(val('from'), days);
        meta.append(h('em', '', w ? `${shortDay(w.from)} to ${shortDay(w.to)}` : `${days} days`));
        pc.append(h('div', 'apr__favatar', letters), h('span', 'apr__fbadge', 'Featured'), h('b', '', title || 'Your title'), h('small', '', blurb || 'Your one line about the token.'), meta);
      };
      for (const n of ['title', 'blurb']) (form.elements.namedItem(n) as HTMLInputElement).addEventListener('input', drawPreview);
      const price = h('div', 'apr__panel');
      price.append(h('span', '', 'Price'), h('p', 'apr__safe', FEATURED_PRICE_NOTE));
      aside.append(previewPanel, price);
      drawDur();
    } else {
      const projSec = section(2, 'Your project');
      projSec.append(field('project', 'Project link', { type: 'url', placeholder: 'https://', autocomplete: 'url', hint: 'Your website or page. We check that it matches the token.' }));
      form.append(projSec);
    }

    // The last step: where we reply.
    const contactSec = section(kind === 'featured' ? 4 : 3, 'How we reply');
    contactSec.append(field('contact', 'Your email', { type: 'email', max: REQUEST_LIMITS.contact, autocomplete: 'email', hint: 'We reply here, usually within a day or two.' }), h('p', 'apr__safe', 'Never include a recovery phrase or private key. Aretia will never ask for one.'));
    form.append(contactSec);

    const next = h('div', 'apr__panel');
    const steps = h('ol', 'apr__steps');
    for (const t of COPY[kind].next) steps.append(h('li', '', t));
    next.append(h('span', '', 'What happens next'), steps);
    aside.append(next);

    // The send button stays in view at the bottom while the form scrolls.
    const status = h('p', 'apr__status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = h('div', 'apr__actions apr__actions--sticky');
    const send = h('button', 'apr__send', COPY[kind].send);
    send.type = 'submit';
    actions.append(status, send);
    form.append(actions);

    drawNetworks();
    drawPreview();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const w = kind === 'featured' ? featuredWindow(val('from'), days) : null;
      const f: RequestFields = { token: val('token'), chain: val('chain'), project: val('project'), contact: val('contact'), title: val('title'), blurb: val('blurb'), from: w?.from ?? '', to: w?.to ?? '' };
      const errors = validateRequest(kind, f);
      if (!f.chain && f.token.trim() && guessNetwork(f.token) === 'evm') errors.chain = 'Choose the network the token is on.';
      if (kind === 'featured' && !w) errors.from = 'Pick a start day.';
      for (const p of form.querySelectorAll<HTMLElement>('[data-err]')) {
        const n = p.dataset.err!;
        const msg = (errors as Record<string, string | undefined>)[n] ?? '';
        p.textContent = msg;
        (form.elements.namedItem(n) as HTMLElement | null)?.setAttribute('aria-invalid', String(Boolean(msg)));
      }
      if (hasErrors(errors)) {
        const first = Object.keys(errors)[0]!;
        const target = first === 'chain' ? chips.querySelector<HTMLElement>('button') : (form.elements.namedItem(first) as HTMLElement | null);
        target?.focus();
        return;
      }
      const data = new FormData();
      data.set('_subject', COPY[kind].subject);
      data.set('category', COPY[kind].category);
      for (const [k, v] of Object.entries(f)) if (v) data.set(k, v.trim());
      send.disabled = true;
      status.className = 'apr__status';
      status.textContent = 'Sending…';
      try {
        const res = await fetch(LINKS.contactForm, { method: 'POST', body: data, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(String(res.status));
        saveContact(f.contact.trim());
        const lines = [`${CHAINS[f.chain as keyof typeof CHAINS]?.name ?? f.chain}: ${f.token.trim()}`];
        if (kind === 'featured' && w) lines.push(`Featured ${shortDay(w.from)} to ${shortDay(w.to)}`, `“${f.title?.trim() ?? ''}”`);
        else lines.push('Verification request');
        lines.push(`Reply to ${f.contact.trim()}`);
        sent = { title: COPY[kind].title, lines };
        step = 'done';
        draw();
      } catch {
        status.classList.add('is-err');
        status.textContent = 'Something went wrong sending your request. Please try again, or reach us on Telegram.';
        send.disabled = false;
      }
    });
    const layout = h('div', 'apr__layout');
    layout.append(form, aside);
    body.append(layout);
  }

  function drawDone(): void {
    body.append(top('Request sent'));
    const box = h('div', 'apr__done');
    box.append(h('div', 'apr__tick', '✓'), h('h2', '', 'Thanks, we have your request'), h('p', '', 'Nothing has been charged. Here is what happens next.'));
    const sum = h('div', 'apr__sum');
    for (const [i, l] of (sent?.lines ?? []).entries()) {
      if (i > 0) sum.append(document.createElement('br'));
      sum.append(document.createTextNode(l));
    }
    const next = h('ol', 'apr__next');
    for (const t of COPY[kind].next) next.append(h('li', '', t));
    const close = h('button', 'apr__send', 'Done');
    close.type = 'button';
    close.addEventListener('click', () => dlg.close());
    const actions = h('div', 'apr__actions');
    actions.style.width = '100%';
    actions.append(close);
    box.append(sum, next, actions);
    body.append(box);
    close.focus();
  }

  function draw(): void {
    body.textContent = '';
    dlg.classList.remove('apr--wide');
    if (step === 'choose') drawChoose();
    else if (step === 'form') drawForm();
    else drawDone();
    dlg.scrollTop = 0;
  }

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener('close', () => dlg.remove());
  draw();
  document.body.append(dlg);
  dlg.showModal();
}

/** A small text button that opens the dialog, for the Markets and Launch screens. It is there whether or not anything is featured. */
export function promoteButton(label = 'Promote your token', kind: RequestKind = 'featured'): HTMLButtonElement {
  const b = h('button', 'lh-linkbtn wapp-promote', label);
  b.type = 'button';
  b.addEventListener('click', () => openPromote(kind));
  return b;
}
