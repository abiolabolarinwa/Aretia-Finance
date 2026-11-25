/**
 * Free token profiles in the wallet (docs/token-profiles.md): the block on a token's page in Markets, and the form a creator fills in.
 * The rules are in ../swings/profiles/core.ts and the server in api/_tokenProfiles.ts.
 *
 * Text only (textContent), links open in a new tab with no referrer, and the logo is drawn only from Aretia's own picture store.
 * Separate from the hand-checked "Verified by Aretia" badge (src/data/verified.ts): a profile says nothing about whether a token is safe.
 */
import { AccountClient, type Session, type Signer } from '../swings/account/client';
import { browserStorage } from '../swings/history.js';
import { checkImage } from '../swings/launchmeta/core.js';
import { EMPTY_PROFILE, PROFILE_LIMITS, familyOf, publicProfile, validateProfile, type ProfileFields, type ProfileIssue, type PublicProfile } from '../swings/profiles/core.js';
import type { ChainId } from '../swings/core/types.js';
import { LINK_ICONS, linkKind } from './walletLinkIcons.js';
import { createUploader, sha256Hex } from './walletLaunchMeta.js';

const API = '/api/swings-profiles';
const TTL_MS = 60_000;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------- reading

const memo = new Map<string, { at: number; p: Promise<PublicProfile | null> }>();

/** The live profile of a token, or null. Asked at most once a minute per token. Never throws. */
export function fetchProfile(chain: ChainId, address: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<PublicProfile | null> {
  const key = `${chain}:${address}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = fetchImpl(`${API}?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`)
    .then(async (r) => (r.ok ? publicProfile(((await r.json()) as { profile?: unknown }).profile ?? null) : null))
    .catch(() => null);
  memo.set(key, { at: Date.now(), p });
  return p;
}
const forget = (chain: ChainId, address: string): void => void memo.delete(`${chain}:${address}`);

// ---------------------------------------------------------------- showing

const LINKS: [keyof Pick<PublicProfile, 'website' | 'x' | 'telegram' | 'discord'>, string][] = [
  ['website', 'Website'],
  ['x', 'X'],
  ['telegram', 'Telegram'],
  ['discord', 'Discord'],
];

/** The profile block for the token page. */
export function profileBlock(p: PublicProfile): HTMLElement {
  const box = el('div', 'wapp-mp__group wapp-tp');
  box.append(el('h4', 'wapp-mp__h', 'Profile from the creator'));
  const top = el('div', 'wapp-tp__top');
  if (p.logo) {
    const img = el('img', 'wapp-tp__logo');
    img.src = p.logo;
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    top.append(img);
  }
  if (p.description) top.append(el('p', 'wapp-tp__desc', p.description));
  if (top.childElementCount > 0) box.append(top);
  const links = el('div', 'wapp-mp__links');
  for (const [k, label] of LINKS) {
    const url = p[k];
    if (!url) continue;
    const a = el('a', 'wapp-mp__icon wapp-mp__icon--link');
    a.innerHTML = LINK_ICONS[k === 'website' ? 'website' : linkKind(url, label)];
    a.title = `${label}: ${url}`;
    a.setAttribute('aria-label', label);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow ugc';
    links.append(a);
  }
  if (links.childElementCount > 0) box.append(links);
  box.append(
    el(
      'p',
      'wapp-mp__tiny',
      `${p.proof === 'authority' ? 'Published by the wallet that controls this token.' : 'Approved by Aretia after a check by hand of who sent it.'} Written by the creator; Aretia does not check what it says. Profiles are free and never change where a token ranks.`,
    ),
  );
  return box;
}

// ---------------------------------------------------------------- editing

interface CheckAnswer {
  exists: boolean;
  controls: 'authority' | 'review' | 'wrong-family';
  hasController: boolean;
  blocked: boolean;
  live: unknown;
  pending: Record<string, unknown> | null;
}

export interface EditorOptions {
  chain: ChainId;
  address: string;
  symbol: string;
  /** The wallet that would sign for this token's network, or null when none is connected. */
  signer(family: 'solana' | 'evm'): Signer | null;
  /** Called after a profile was published or sent, so the page can draw it again. */
  onDone(): void;
  onClose(): void;
}

const FIELDS: [keyof Omit<ProfileFields, 'logo'>, string, string][] = [
  ['website', 'Website', 'https://…'],
  ['x', 'X', 'https://x.com/…'],
  ['telegram', 'Telegram', 'https://t.me/…'],
  ['discord', 'Discord', 'https://discord.gg/…'],
];

const fieldsFrom = (v: unknown): ProfileFields => {
  const r = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const s = (x: unknown): string => (typeof x === 'string' ? x : '');
  return { description: s(r.description), website: s(r.website), x: s(r.x), telegram: s(r.telegram), discord: s(r.discord), logo: s(r.logo) };
};

/** The form a token's creator fills in. Signs in with one free message (no transaction), then asks the server who controls the token. */
export function profileEditor(o: EditorOptions): HTMLElement {
  const box = el('div', 'wapp-mp__group wapp-tp wapp-tp--edit');
  const account = new AccountClient(browserStorage());
  const family = familyOf(o.chain);
  const status = el('p', 'wapp__fine', '');
  status.setAttribute('role', 'status');
  let values: ProfileFields = { ...EMPTY_PROFILE };
  let session: Session | null = null;

  const head = el('div', 'wapp-tp__bar');
  const close = el('button', 'wapp__btn wapp__btn--ghost', 'Close');
  close.type = 'button';
  close.addEventListener('click', o.onClose);
  head.append(el('h4', 'wapp-mp__h', `Free profile for ${o.symbol}`), close);
  box.append(head, el('p', 'wapp__fine', 'Add a description, links and a logo to this token’s page. It is free, and it never changes where the token ranks.'), status);

  const signIn = async (): Promise<Session> => {
    const signer = o.signer(family);
    if (!signer) throw new Error(family === 'solana' ? 'Connect a Solana wallet first.' : 'Connect an Ethereum-style wallet first.');
    session = account.session(signer.family, signer.address) ?? (await account.signIn(signer));
    return session;
  };

  const form = el('form', 'wapp-tp__form');
  form.noValidate = true;
  const marks = new Map<keyof ProfileFields, HTMLElement>();
  const inputs = new Map<keyof ProfileFields, HTMLInputElement | HTMLTextAreaElement>();
  const field = (key: keyof ProfileFields, label: string, control: HTMLInputElement | HTMLTextAreaElement): void => {
    const id = `tp-${key}-${Math.random().toString(36).slice(2, 8)}`;
    control.id = id;
    control.className = 'wapp__input';
    const l = el('label', 'wapp-tp__label', label);
    l.htmlFor = id;
    const err = el('span', 'wapp-tp__err');
    marks.set(key, err);
    inputs.set(key, control);
    control.addEventListener('input', () => {
      values = { ...values, [key]: control.value };
    });
    form.append(l, control, err);
  };
  const desc = el('textarea');
  desc.rows = 4;
  desc.maxLength = PROFILE_LIMITS.descriptionMax;
  desc.placeholder = 'What is this token about? Plain text.';
  field('description', 'Description', desc);
  for (const [key, label, ph] of FIELDS) {
    const i = el('input');
    i.type = 'url';
    i.inputMode = 'url';
    i.autocomplete = 'off';
    i.spellcheck = false;
    i.maxLength = PROFILE_LIMITS.urlMax;
    i.placeholder = ph;
    field(key, label, i);
  }
  const logoRow = el('div', 'wapp-tp__logorow');
  const logoPreview = el('img', 'wapp-tp__logo');
  logoPreview.alt = '';
  logoPreview.width = 40;
  logoPreview.height = 40;
  logoPreview.hidden = true;
  const file = el('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/gif';
  file.id = `tp-logo-${Math.random().toString(36).slice(2, 8)}`;
  const logoLabel = el('label', 'wapp-tp__label', 'Logo (JPG, PNG or GIF)');
  logoLabel.htmlFor = file.id;
  const logoErr = el('span', 'wapp-tp__err');
  marks.set('logo', logoErr);
  logoRow.append(logoPreview, file);
  form.append(logoLabel, logoRow, logoErr);
  const submit = el('button', 'wapp__btn wapp__btn--primary', 'Publish profile');
  submit.type = 'submit';
  form.append(submit);

  const showLogo = (url: string): void => {
    logoPreview.hidden = url === '';
    if (url) logoPreview.src = url;
  };
  const fill = (v: ProfileFields): void => {
    values = { ...v };
    for (const [k, c] of inputs) c.value = v[k];
    showLogo(v.logo);
  };
  const showIssues = (issues: readonly ProfileIssue[]): void => {
    for (const [k, m] of marks) {
      const i = issues.find((x) => x.field === k);
      m.textContent = i?.message ?? '';
      inputs.get(k)?.setAttribute('aria-invalid', String(!!i));
    }
  };
  const say = (m: string): void => void (status.textContent = m);

  const uploader = createUploader(() => o.signer(family));
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    void (async () => {
      logoErr.textContent = '';
      const bytes = new Uint8Array(await f.arrayBuffer());
      const ok = checkImage({ size: f.size }, bytes.subarray(0, 16));
      if (!ok.ok) {
        logoErr.textContent = ok.message;
        return;
      }
      say('Uploading the logo…');
      try {
        if (!(await uploader.status())) throw new Error('Image upload is not set up yet.');
        const url = await uploader.put({ kind: 'image', contentType: ok.type, sha256: await sha256Hex(bytes) }, bytes, ok.type);
        values = { ...values, logo: url };
        showLogo(url);
        say('Logo uploaded. Publish to save it.');
      } catch (e) {
        logoErr.textContent = e instanceof Error ? e.message : 'The logo could not be uploaded.';
        say('');
      }
    })();
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = validateProfile(values);
    showIssues(v.ok ? [] : v.issues);
    if (!v.ok) return;
    submit.disabled = true;
    say('Saving…');
    void (async () => {
      try {
        const s = session ?? (await signIn());
        const out = await account.call<{ status: string; message: string }>(s, { op: 'submit', chain: o.chain, address: o.address, profile: v.value }, API);
        forget(o.chain, o.address);
        say(out.message);
        o.onDone();
      } catch (e) {
        say(e instanceof Error ? e.message : 'The profile could not be saved.');
      }
      submit.disabled = false;
    })();
  });

  // First: sign in (one free message) and ask who controls the token, so the person knows what will happen before typing.
  const start = el('button', 'wapp__btn wapp__btn--primary', 'Sign in to start');
  start.type = 'button';
  box.append(start);
  start.addEventListener('click', () => {
    start.disabled = true;
    say('Signing in… This is a free message, not a transaction.');
    void (async () => {
      try {
        const s = await signIn();
        const c = await account.call<CheckAnswer>(s, { op: 'check', chain: o.chain, address: o.address }, API);
        start.remove();
        if (!c.exists) return say('No token was found at this address on this network.');
        if (c.blocked) return say('Aretia removed this token’s profile. It cannot have a new one for now.');
        if (c.controls === 'wrong-family') return say(family === 'solana' ? 'Sign in with a Solana wallet for a Solana token.' : 'Sign in with an Ethereum-style wallet for this token.');
        say(
          c.controls === 'authority'
            ? 'This wallet controls the token, so your profile is published as soon as you save it.'
            : c.hasController
              ? 'This wallet does not control the token. Your profile is sent to Aretia, and shows once it is approved. Signing in with the wallet that controls the token publishes at once.'
              : 'Nobody controls this token any more (normal for pump.fun tokens). Your profile is sent to Aretia, and shows once it is approved.',
        );
        fill(c.pending ? fieldsFrom(c.pending) : c.live ? fieldsFrom(c.live) : { ...EMPTY_PROFILE });
        if (c.controls === 'review') submit.textContent = c.pending ? 'Update request' : 'Send for review';
        box.append(form);
      } catch (e) {
        start.disabled = false;
        say(e instanceof Error ? (/reject|declin|denied/i.test(e.message) ? 'The sign-in was declined.' : e.message) : 'Signing in did not work.');
      }
    })();
  });
  return box;
}
