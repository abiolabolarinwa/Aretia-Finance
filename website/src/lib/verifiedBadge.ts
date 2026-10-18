/**
 * The "Verified by Aretia" badge as a DOM element, for the wallet, Radar, the Launch screens and the token page.
 *
 *   import { verifiedBadge } from '../lib/verifiedBadge';
 *   const badge = verifiedBadge('solana', mint);      // an HTMLElement, or null when the token is not on the list
 *   if (badge) row.append(badge);
 *
 * The badge is a button: a tooltip on hover, and a dialog on click or tap that says exactly what was checked and what it is not
 * (the wording is in src/lib/verified.ts and website/docs/verified-badge.md). It styles itself, so it needs no stylesheet from the
 * page it is put in. Everything is set with textContent.
 */
import { VERIFIED } from '../data/verified';
import { CHECKS, DEFINITION, SHORT_DEFINITION, dateText, verifiedFor, type VerifiedEntry } from './verified';

const STYLE_ID = 'aretia-verified-style';
const CSS = `
.avb{display:inline-flex;align-items:center;gap:.3em;margin:0;padding:.18em .6em .18em .45em;border:1px solid currentColor;border-radius:999px;font:600 .72rem/1.2 inherit;font-family:inherit;color:var(--color-brand,#0f5c3a);background:transparent;cursor:default;white-space:nowrap;vertical-align:middle}
button.avb{cursor:pointer}
.avb:focus-visible{outline:2px solid var(--color-brand-bright,#2a9d6b);outline-offset:2px}
.avb svg{width:.95em;height:.95em;flex:none}
.avb-dlg{width:min(34rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);padding:1.25rem 1.25rem 1rem;border:1px solid rgba(14,11,43,.15);border-radius:16px;color:#0e0b2b;background:#fff;box-shadow:0 24px 60px rgba(14,11,43,.3);overflow:auto}
.avb-dlg::backdrop{background:rgba(14,11,43,.45)}
.avb-dlg h2{margin:0 0 .4rem;font-size:1.15rem}
.avb-dlg h3{margin:1rem 0 .3rem;font-size:.8rem;letter-spacing:.04em;text-transform:uppercase;color:#4a4670}
.avb-dlg p,.avb-dlg li{font-size:.9rem;line-height:1.45}
.avb-dlg ul{margin:.2rem 0;padding-left:1.1rem}
.avb-dlg li span{display:block;color:#4a4670;font-size:.82rem}
.avb-dlg .avb-close{margin-top:1rem;padding:.55rem 1.1rem;border:0;border-radius:999px;font:600 .9rem inherit;font-family:inherit;color:#fff;background:#0e0b2b;cursor:pointer}
.avb-dlg a{color:inherit;text-decoration:underline;text-underline-offset:2px}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};

function tick(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M3 8.5l3.2 3.2L13 4.8');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

/** The dialog for one entry: what was checked, when, the evidence, and what the badge is not. */
export function verifiedDialog(entry: VerifiedEntry): HTMLDialogElement {
  const dlg = el('dialog');
  dlg.className = 'avb-dlg';
  dlg.setAttribute('aria-label', DEFINITION.title);
  dlg.append(el('h2', DEFINITION.title), el('p', `${DEFINITION.does} This token was checked on ${dateText(entry.date)}.`));
  dlg.append(el('h3', 'What was checked'));
  const checks = el('ul');
  for (const c of CHECKS) {
    const li = el('li', c.label);
    li.append(el('span', c.how));
    checks.append(li);
  }
  dlg.append(checks);
  dlg.append(el('h3', 'What it is not'));
  const nots = el('ul');
  for (const t of DEFINITION.doesNot) nots.append(el('li', t));
  dlg.append(nots, el('p', DEFINITION.paid));
  const ev = el('p');
  const a = el('a', 'See the evidence');
  a.href = entry.evidence;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  ev.append(a, document.createTextNode(' · '));
  const full = el('a', 'Full definition');
  full.href = '/verified';
  ev.append(full);
  dlg.append(ev);
  const close = el('button', 'Close');
  close.type = 'button';
  close.className = 'avb-close';
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.append(close);
  return dlg;
}

/**
 * The badge for a token, or null when the token is not on the verified list. By default it is a button that opens the dialog.
 * Inside a row that is itself a button or a link, pass `{ plain: true }`: it is then a non-interactive label (still with the tooltip),
 * because a button inside a button is not valid; the dialog is one tap away on the token's own page.
 * `list` and `now` are for tests.
 */
export function verifiedBadge(chain: string, token: string, opts: { plain?: boolean; list?: readonly VerifiedEntry[]; now?: number } = {}): HTMLElement | null {
  const entry = verifiedFor(opts.list ?? VERIFIED, chain, token, opts.now ?? Date.now());
  if (!entry) return null;
  ensureStyle();
  const tip = `${SHORT_DEFINITION} Checked ${dateText(entry.date)}.`;
  if (opts.plain) {
    const s = el('span');
    s.className = 'avb';
    s.title = tip;
    s.append(tick(), document.createTextNode('Verified by Aretia'));
    return s;
  }
  const b = el('button');
  b.type = 'button';
  b.className = 'avb';
  b.title = tip;
  b.setAttribute('aria-haspopup', 'dialog');
  b.append(tick(), document.createTextNode('Verified by Aretia'));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const dlg = verifiedDialog(entry);
    document.body.append(dlg);
    dlg.showModal();
  });
  return b;
}
