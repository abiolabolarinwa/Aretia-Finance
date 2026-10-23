/**
 * The "Token details" part of the Launch forms (picture, description, website, X, Telegram) and the "before you sign" checklist, drawn
 * with textContent only. The state is in walletLaunchMeta.ts, the rules in ../swings/launchmeta/core.ts and the checklist text in
 * walletLaunchChecklist.ts. The same two functions serve the Solana and the Ethereum-style forms.
 */
import { DETAIL_LIMITS, IMAGE_RULES, type DetailIssue, type LaunchDetails } from '../swings/launchmeta/core.js';
import { NOT_SET_UP, chooseImage, clearImage, detailsState, setDetails, type LaunchUploader } from './walletLaunchMeta';
import type { Checklist } from './walletLaunchChecklist';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export interface DetailsOptions {
  idPrefix: string;
  issues: readonly DetailIssue[];
  /** Null where a picture cannot be stored (a test network, or a network with no way to prove who created the token). */
  uploader: LaunchUploader | null;
  /** Why the picture is not offered, when `uploader` is null. */
  noImageReason?: string;
  /** One line about when the picture is published, shown under the picker. */
  imageNote?: string;
}

export function detailsFields(o: DetailsOptions): HTMLElement {
  const st = detailsState();
  const box = h('section', 'lh-det');
  box.append(h('span', 'wapp__eyebrow', 'Token details (optional)'));

  const top = h('div', 'lh-det__top');
  // ---- picture
  const pick = h('div', 'lh-det__pick');
  const thumb = h('div', 'lh-det__thumb');
  thumb.setAttribute('aria-hidden', 'true');
  if (st.image) {
    const img = h('img');
    img.alt = '';
    img.src = st.image.previewUrl;
    thumb.append(img);
  } else thumb.textContent = 'Image';
  const input = h('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/gif';
  input.id = `${o.idPrefix}-image`;
  input.className = 'lh-det__file';
  const label = h('label', 'wapp__btn wapp__btn--ghost lh-det__choose', st.image ? 'Change image' : 'Choose image');
  label.htmlFor = input.id;
  const note = h('p', 'wapp__fine', `JPG, PNG or GIF, up to ${IMAGE_RULES.maxBytes / 1024 / 1024} MB. A square picture looks best: it is shown as a circle.`);
  const status = h('p', 'wapp__fine lh-det__status');
  status.setAttribute('role', 'status');
  const problem = st.imageProblem ?? o.issues.find((i) => i.field === 'image')?.message;
  if (problem) {
    status.textContent = problem;
    status.classList.add('is-bad');
    status.setAttribute('role', 'alert');
  } else if (st.image) status.textContent = `${st.image.size < 1024 * 1024 ? `${Math.max(1, Math.round(st.image.size / 1024))} KB` : `${(st.image.size / 1024 / 1024).toFixed(1)} MB`} ${st.image.type.replace('image/', '').toUpperCase()}. ${o.imageNote ?? ''}`.trim();
  const remove = h('button', 'wapp__btn wapp__btn--ghost lh-det__remove', 'Remove');
  remove.type = 'button';
  remove.hidden = !st.image;
  remove.addEventListener('click', clearImage);
  if (!o.uploader) {
    input.disabled = true;
    label.classList.add('is-disabled');
    status.textContent = o.noImageReason ?? NOT_SET_UP;
  } else {
    // Asked once; until the answer is in, the picker is usable so a fast click is not lost.
    void o.uploader.status().then((ok) => {
      if (ok || !input.isConnected) return;
      input.disabled = true;
      label.classList.add('is-disabled');
      status.classList.add('is-bad');
      status.textContent = NOT_SET_UP + '. Everything else on this page still works.';
      if (detailsState().image) clearImage();
    });
  }
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void chooseImage(file);
  });
  const row = h('div', 'lh-det__buttons');
  row.append(label, remove);
  pick.append(thumb, input);
  const side = h('div', 'lh-det__side');
  side.append(row, note, status);
  const picker = h('div', 'lh-det__picker');
  picker.append(pick, side);
  top.append(picker);

  // ---- description
  const descWrap = h('div', 'wapp-ln__field');
  const dl = h('label', 'wapp__eyebrow', 'Description');
  dl.htmlFor = `${o.idPrefix}-description`;
  const ta = h('textarea', 'wapp__input lh-det__desc');
  ta.id = `${o.idPrefix}-description`;
  ta.rows = 3;
  ta.maxLength = DETAIL_LIMITS.descriptionMax + 200;
  ta.value = st.details.description;
  ta.placeholder = 'What is this token for?';
  const count = h('p', 'wapp__fine', `${[...ta.value].length}/${DETAIL_LIMITS.descriptionMax}`);
  ta.addEventListener('input', () => {
    count.textContent = `${[...ta.value].length}/${DETAIL_LIMITS.descriptionMax}`;
    setDetails({ description: ta.value });
  });
  descWrap.append(dl, ta);
  const dIssue = o.issues.find((i) => i.field === 'description');
  if (dIssue) {
    ta.setAttribute('aria-invalid', 'true');
    const p = h('p', 'wapp-ln__problem', dIssue.message);
    p.setAttribute('role', 'alert');
    descWrap.append(p);
  } else descWrap.append(count);
  top.append(descWrap);
  box.append(top);

  // ---- links
  const links = h('div', 'lh-det__links');
  const link = (field: keyof Pick<LaunchDetails, 'website' | 'x' | 'telegram'>, text: string, placeholder: string): void => {
    const wrap = h('div', 'wapp-ln__field');
    const lab = h('label', 'wapp__eyebrow', text);
    lab.htmlFor = `${o.idPrefix}-${field}`;
    const el = h('input', 'wapp__input wapp-mono');
    el.id = `${o.idPrefix}-${field}`;
    el.type = 'url';
    el.inputMode = 'url';
    el.autocomplete = 'off';
    el.spellcheck = false;
    el.placeholder = placeholder;
    el.value = detailsState().details[field];
    el.addEventListener('input', () => setDetails({ [field]: el.value } as Partial<LaunchDetails>));
    wrap.append(lab, el);
    const issue = o.issues.find((i) => i.field === field);
    if (issue) {
      el.setAttribute('aria-invalid', 'true');
      const p = h('p', 'wapp-ln__problem', issue.message);
      p.setAttribute('role', 'alert');
      wrap.append(p);
    }
    links.append(wrap);
  };
  link('website', 'Website', 'https://…');
  link('x', 'X', 'https://x.com/…');
  link('telegram', 'Telegram', 'https://t.me/…');
  box.append(links);
  box.append(h('p', 'wapp__fine', 'Public for good once the token exists: anyone can read the picture, description and links. Only https links are kept. Aretia stores the picture and a small details file for you; the name, symbol and supply are on the token itself.'));
  return box;
}

/** The "before you sign" checklist: three short lists and the cost, with the total last. */
export function checklistBox(c: Checklist, heading = 'Before you sign'): HTMLElement {
  const box = h('section', 'lh-check');
  box.setAttribute('aria-label', heading);
  box.append(h('h3', 'lh-check__h', heading));
  const group = (title: string, items: string[], cls: string): void => {
    const ul = h('ul', `lh-check__list ${cls}`);
    for (const t of items) ul.append(h('li', '', t));
    box.append(h('span', 'lh-check__t', title), ul);
  };
  group('Locked for good', c.locked, 'is-locked');
  const dl = h('dl', 'lh-check__cost');
  for (const l of c.cost) {
    const d = h('div', l.total ? 'is-total' : '');
    d.append(h('dt', '', l.label), h('dd', '', l.value));
    dl.append(d);
  }
  box.append(h('span', 'lh-check__t', 'What it costs'), dl, h('p', 'lh-check__fine', c.costNote));
  group('What you keep', c.keeps, 'is-keep');
  box.append(h('p', 'lh-check__fine', 'This is a list of what the transaction does, not a promise about any token. Aretia has not audited or endorsed it.'));
  return box;
}
