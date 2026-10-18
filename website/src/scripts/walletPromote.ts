/**
 * "Promote your token" inside the web wallet: a dialog with the two request forms (get featured, request the Verified by Aretia badge),
 * so nobody has to leave the wallet to ask. It checks the answers with src/lib/requests.ts, then posts them to the site's Formspree form.
 * It takes no payment: a request is a message, and any price is agreed in writing afterwards. Everything typed is shown with textContent.
 */
import { LINKS } from '../data/site';
import { FEATURED_PRICE_NOTE } from '../lib/featured';
import { REQUEST_LIMITS, hasErrors, validateRequest, type RequestFields, type RequestKind } from '../lib/requests';

const STYLE_ID = 'aretia-promote-style';
const CSS = `
.apr{width:min(30rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);padding:1.25rem;border:1px solid rgba(14,11,43,.15);border-radius:16px;color:#0e0b2b;background:#fff;box-shadow:0 24px 60px rgba(14,11,43,.3);overflow:auto;font-family:inherit}
.apr::backdrop{background:rgba(14,11,43,.45)}
.apr h2{margin:0 0 .3rem;font-size:1.15rem}
.apr p{margin:.3rem 0;font-size:.85rem;line-height:1.4;color:#4a4670}
.apr__tabs{display:flex;gap:.4rem;margin:.8rem 0}
.apr__tabs button{flex:1;min-height:44px;padding:.4rem .6rem;border:1px solid rgba(14,11,43,.2);border-radius:999px;background:#fff;color:inherit;font:600 .85rem inherit;font-family:inherit;cursor:pointer}
.apr__tabs button[aria-pressed='true']{color:#fff;background:#0e0b2b;border-color:#0e0b2b}
.apr label{display:grid;gap:.25rem;margin:.6rem 0 0;font-size:.82rem;font-weight:600}
.apr label small{font-weight:400;color:#4a4670}
.apr input,.apr select{width:100%;min-height:44px;padding:.55rem .7rem;border:1px solid rgba(14,11,43,.25);border-radius:10px;font:1rem inherit;font-family:inherit;color:inherit;background:#fff}
.apr input[aria-invalid='true'],.apr select[aria-invalid='true']{border-color:#b42318}
.apr .apr__err{min-height:1em;margin:0;font-size:.75rem;font-weight:400;color:#b42318}
.apr__row{display:grid;gap:0 .6rem;grid-template-columns:1fr}
.apr__actions{display:flex;gap:.6rem;margin-top:1rem}
.apr__actions button{min-height:46px;padding:0 1.2rem;border-radius:999px;font:600 .9rem inherit;font-family:inherit;cursor:pointer;border:1px solid #0e0b2b}
.apr__send{color:#fff;background:#0e0b2b}
.apr__send[disabled]{opacity:.6;cursor:default}
.apr__cancel{color:#0e0b2b;background:#fff}
.apr__status{min-height:1.2em;font-weight:600}
.apr__status.is-ok{color:#0f5c3a}.apr__status.is-err{color:#b42318}
  .apr__price{font-weight:600;color:#0e0b2b}
@media(min-width:520px){.apr__row{grid-template-columns:1fr 1fr}}
`;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const COPY: Record<RequestKind, { lead: string; send: string; subject: string; category: string }> = {
  featured: { lead: 'A small card marked Featured, in Markets and Launch, for dates we agree. We read the request and reply. Featured is a placement, not a rating or an endorsement.', send: 'Send featured request', subject: 'Request: Featured launch', category: 'Featured request' },
  verify: { lead: 'We run four checks on one day (fixed supply, special powers given up, project link matches, a locked pool exists) and tell you what we found, including a failure. It is not an audit or an endorsement, and asking does not get the badge.', send: 'Send verification request', subject: 'Request: Verified by Aretia', category: 'Verification request' },
};

/** Opens the dialog on the chosen request. Safe to call from any wallet screen. */
export function openPromote(start: RequestKind = 'featured'): void {
  if (!document.getElementById(STYLE_ID)) {
    const s = h('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.append(s);
  }
  let kind: RequestKind = start;
  const dlg = h('dialog', 'apr');
  dlg.setAttribute('aria-label', 'Promote your token');
  const body = h('div');
  dlg.append(body);

  const field = (name: string, label: string, opts: { type?: string; hint?: string; max?: number; placeholder?: string; autocomplete?: string } = {}): HTMLElement => {
    const wrap = h('label');
    wrap.append(document.createTextNode(label));
    if (opts.hint) wrap.append(h('small', '', ` ${opts.hint}`));
    const input = h('input');
    input.name = name;
    input.type = opts.type ?? 'text';
    if (opts.max) input.maxLength = opts.max;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.setAttribute('autocomplete', opts.autocomplete ?? 'off');
    input.autocapitalize = 'off';
    input.spellcheck = false;
    const err = h('span', 'apr__err');
    err.dataset.err = name;
    wrap.append(input, err);
    return wrap;
  };

  function draw(): void {
    body.textContent = '';
    body.append(h('h2', '', 'Promote your token'));
    const tabs = h('div', 'apr__tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'What to ask for');
    for (const [k, label] of [['featured', 'Get featured'], ['verify', 'Request verification']] as const) {
      const b = h('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(kind === k));
      b.addEventListener('click', () => {
        kind = k;
        draw();
      });
      tabs.append(b);
    }
    body.append(tabs, h('p', '', COPY[kind].lead));
    if (kind === 'featured') body.append(h('p', 'apr__price', FEATURED_PRICE_NOTE));

    const form = h('form');
    form.noValidate = true;
    const chainWrap = h('label');
    chainWrap.append(document.createTextNode('Network'));
    const chain = h('select');
    chain.name = 'chain';
    for (const [v, t] of [['', 'Choose one'], ['solana', 'Solana'], ['bnb', 'BNB Chain'], ['ethereum', 'Ethereum'], ['polygon', 'Polygon']] as const) {
      const o = h('option', '', t);
      o.value = v;
      chain.append(o);
    }
    const chainErr = h('span', 'apr__err');
    chainErr.dataset.err = 'chain';
    chainWrap.append(chain, chainErr);
    form.append(chainWrap, field('token', 'Token address'));
    if (kind === 'featured') {
      form.append(field('title', 'Title', { hint: `(up to ${REQUEST_LIMITS.title} characters)`, max: REQUEST_LIMITS.title }), field('blurb', 'One line about it', { hint: `(up to ${REQUEST_LIMITS.blurb} characters)`, max: REQUEST_LIMITS.blurb }));
      const row = h('div', 'apr__row');
      row.append(field('from', 'First day', { type: 'date', hint: '(optional)' }), field('to', 'Last day', { type: 'date', hint: '(optional)' }));
      form.append(row);
    }
    form.append(field('project', 'Project link', { type: 'url', placeholder: 'https://', autocomplete: 'url' }), field('contact', 'Your email', { type: 'email', max: REQUEST_LIMITS.contact, autocomplete: 'email' }));
    form.append(h('p', '', 'Never include a recovery phrase or private key; Aretia will never ask for one.'));
    const status = h('p', 'apr__status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = h('div', 'apr__actions');
    const send = h('button', 'apr__send', COPY[kind].send);
    send.type = 'submit';
    const cancel = h('button', 'apr__cancel', 'Close');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    actions.append(send, cancel);
    form.append(status, actions);

    const val = (n: string): string => (form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f: RequestFields = { token: val('token'), chain: val('chain'), project: val('project'), contact: val('contact'), title: val('title'), blurb: val('blurb'), from: val('from'), to: val('to') };
      const errors = validateRequest(kind, f);
      for (const p of form.querySelectorAll<HTMLElement>('[data-err]')) {
        const n = p.dataset.err!;
        p.textContent = (errors as Record<string, string | undefined>)[n] ?? '';
        (form.elements.namedItem(n) as HTMLElement | null)?.setAttribute('aria-invalid', String(Boolean((errors as Record<string, string | undefined>)[n])));
      }
      if (hasErrors(errors)) {
        (form.elements.namedItem(Object.keys(errors)[0]!) as HTMLElement | null)?.focus();
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
        form.reset();
        status.classList.add('is-ok');
        status.textContent = 'Thanks. Your request has been sent. We will reply by email. Nothing has been charged.';
      } catch {
        status.classList.add('is-err');
        status.textContent = 'Something went wrong sending your request. Please try again, or reach us on Telegram.';
      } finally {
        send.disabled = false;
      }
    });
    body.append(form);
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
