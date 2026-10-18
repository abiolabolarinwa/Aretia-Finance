/**
 * The Radar page of the wallet: look up a token, see what Aretia Radar found, and, if the person wants to act, open the
 * wallet's own swap screen. Radar only reads and explains; this page never quotes, signs or sends anything.
 *
 * It talks to /api/swings-radar (api/_radarProxy.ts), never to the Radar server directly. Everything the server says is
 * shown as it is: an unknown figure reads "Unknown", never as a zero, a pass or a good sign.
 */
import { searchTokens, type SearchHit } from '../swings/tokens/globalSearch.js';
import { OPEN_TOKEN_EVENT } from './walletSearch.js';
import { verifiedBadge } from '../lib/verifiedBadge';

const ENDPOINT = '/api/swings-radar';
const RECENT_KEY = 'aretia.radar.recent';
const RECENT_MAX = 6;

export type EvmChain = 'ethereum' | 'base' | 'bnb' | 'polygon';
export const EVM_CHAINS: { chain: EvmChain; label: string }[] = [
  { chain: 'ethereum', label: 'Ethereum' },
  { chain: 'base', label: 'Base' },
  { chain: 'bnb', label: 'BNB Chain' },
  { chain: 'polygon', label: 'Polygon' },
];

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const looksLikeEvmAddress = (input: string): boolean => EVM_ADDRESS.test(input.trim());

/** The Radar asset id for a pasted address: a Solana mint stands alone, an EVM address needs the chosen chain. */
export function assetIdFromInput(input: string, evmChain: EvmChain): string | null {
  const text = input.trim();
  if (EVM_ADDRESS.test(text)) return `${evmChain}:${text.toLowerCase()}`;
  return SOLANA_MINT.test(text) ? `solana:${text}` : null;
}

export type InputKind = { kind: 'address'; assetId: string } | { kind: 'name'; query: string } | { kind: 'invalid'; message: string };

/** What was typed: a token address, a name or symbol to search for, or something that can be neither. */
export function classifyInput(input: string, evmChain: EvmChain): InputKind {
  const text = input.trim();
  const assetId = assetIdFromInput(text, evmChain);
  if (assetId) return { kind: 'address', assetId };
  if (text.length < 2) return { kind: 'invalid', message: 'Type at least two letters of a name or symbol, or paste a token address.' };
  if (/^0x[0-9a-fA-F]*$/.test(text)) return { kind: 'invalid', message: 'That looks like an EVM address, but it is not 0x followed by 40 letters and numbers. Check that you copied all of it.' };
  if (text.length > 80) return { kind: 'invalid', message: 'That is too long to be a name or an address.' };
  return { kind: 'name', query: text };
}

/** The networks Radar can analyze. A token on any other network can be found by search but not analyzed. */
export const RADAR_CHAINS: ReadonlySet<string> = new Set(['solana', 'ethereum', 'base', 'bnb', 'polygon']);

/** The Radar asset id of a search result. EVM addresses are lower-cased, as everywhere else in Radar. */
export const assetIdOf = (chain: string, address: string): string => (chain === 'solana' ? `solana:${address}` : `${chain}:${address.toLowerCase()}`);

const resultKey = (h: Pick<SearchHit, 'chain' | 'address'>): string => assetIdOf(h.chain, h.address);

/** Symbols that more than one result in the list carries, with how many distinct tokens share each. Names are not unique. */
export function sharedSymbols(hits: Pick<SearchHit, 'chain' | 'address' | 'symbol'>[]): Map<string, number> {
  const bySymbol = new Map<string, Set<string>>();
  for (const h of hits) {
    const s = h.symbol.trim().toUpperCase();
    bySymbol.set(s, (bySymbol.get(s) ?? new Set()).add(resultKey(h)));
  }
  return new Map([...bySymbol].filter(([, ids]) => ids.size > 1).map(([s, ids]) => [s, ids.size]));
}

/** A name or symbol search, limited to networks Radar covers, through the same search the wallet's top bar uses. */
export function searchForRadar(query: string, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<SearchHit[]> {
  return searchTokens(query, fetchImpl, signal, { accept: (h) => RADAR_CHAINS.has(h.chain), limit: 10 });
}

const CLASSIFICATION: Record<string, string> = {
  EARLY: 'Early',
  EMERGING: 'Emerging',
  MOMENTUM: 'Momentum',
  MATURE: 'Mature',
  OVEREXTENDED: 'Overextended',
  DECLINING: 'Declining',
  AVOID: 'Avoid',
  INSUFFICIENT_EVIDENCE: 'Not enough evidence',
};
export const classificationLabel = (c: unknown): string => (typeof c === 'string' ? (CLASSIFICATION[c] ?? 'Unknown') : 'Unknown');

const CHAIN_LABEL: Record<string, string> = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base', bnb: 'BNB Chain', polygon: 'Polygon' };
export const chainLabel = (c: unknown): string => (typeof c === 'string' ? (CHAIN_LABEL[c] ?? c) : 'Unknown');

/** A 0-100 score, or "Unknown" when Radar could not produce one. */
export const scoreText = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : 'Unknown');

export function usdText(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'Unknown';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`;
}

export function ageText(seconds: unknown): string {
  // A reading taken a moment after the server noted the time comes back a second or two negative: that is "just now".
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < -120) return 'unknown age';
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

const ERRORS: Record<string, string> = {
  'radar-not-configured': 'Radar is not switched on for this site yet.',
  'radar-unreachable': 'Could not reach Radar. Try again in a moment.',
  'radar-error': 'Radar had a problem. Try again shortly.',
  'radar-bad-answer': 'Radar sent an answer this page could not read.',
  'radar-busy': 'Radar is busy. Try again in a minute.',
  'rate-limit': 'Too many requests from this device. Try again in a minute.',
  'not-analyzed': 'Radar has not analyzed this token yet.',
  'bad-asset': 'That address is not one Radar can read.',
  origin: 'Radar is only available from the Aretia wallet page.',
};
export const radarErrorText = (code: unknown): string => (typeof code === 'string' && ERRORS[code] ? ERRORS[code]! : 'Radar could not answer. Try again shortly.');

// ---- what the page reads of an answer (all optional: the server's answer is data, not a promise) -------------------

interface Finding {
  id?: string;
  check?: string;
  status?: string;
  severity?: string;
  message?: string;
}
export interface RadarAsset {
  assetId?: string;
  chain?: string;
  symbol?: string | null;
  name?: string | null;
  opportunityScore?: number | null;
  riskScore?: number | null;
  confidenceScore?: number | null;
  dataCoverageScore?: number | null;
  classification?: string;
  whyWatching?: string[];
  mainConcern?: string | null;
  notices?: string[];
  risks?: { label?: string; message?: string }[];
  security?: { severity?: string; score?: number | null; findings?: Finding[] };
  jevDecision?: { engine?: string; riskLevel?: string; evidenceStrength?: string };
  metrics?: { priceUsd?: number | null; marketCapUsd?: number | null; liquidityUsd?: number | null; volume24hUsd?: number | null };
  unavailableCategories?: string[];
  dataFailures?: { provider?: string; kind?: string }[];
  disclaimer?: string;
}
export interface AssetAnswer {
  opportunity?: RadarAsset;
  dataAgeSeconds?: number;
  disclaimer?: string;
}
interface HomeAnswer {
  summary?: { assetsAnalyzed?: number };
  sections?: Record<string, RadarAsset[] | undefined>;
  lastCycleAt?: string | null;
  disclaimer?: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  smartWallet: 'smart-wallet activity',
  developer: 'developer activity',
  tokenomics: 'token supply and unlocks',
  narrative: 'social and narrative',
  fundamentals: 'project fundamentals',
  marketMomentum: 'market momentum',
  liquidityHealth: 'liquidity',
  security: 'contract security',
};
export const categoryLabel = (c: string): string => CATEGORY_LABEL[c] ?? c;

/** Chains the wallet's swap screen can open. A token on any other chain is shown, but has no swap button. */
const SWAPPABLE = new Set(['solana', 'ethereum']);

// ---- DOM helpers --------------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | null | false)[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (props.class) n.className = props.class;
  if (props.text !== undefined) n.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) n.setAttribute(k, v);
  for (const c of children) if (c) n.append(c);
  return n;
}

const pill = (text: string, kind: 'plain' | 'warn' | 'bad' = 'plain'): HTMLElement => el('span', { class: `wapp-rd__pill wapp-rd__pill--${kind}`, text });

async function call<T>(op: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const { query, ...rest } = init;
  const qs = new URLSearchParams({ op, ...(query ?? {}) });
  try {
    const res = await fetch(`${ENDPOINT}?${qs.toString()}`, { ...rest, headers: { accept: 'application/json', ...(rest.method === 'POST' ? { 'content-type': 'application/json' } : {}) } });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || data === null) return { ok: false, message: radarErrorText(data?.error) };
    return { ok: true, value: data };
  } catch {
    return { ok: false, message: radarErrorText('radar-unreachable') };
  }
}

function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function remember(assetId: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([assetId, ...readRecent().filter((x) => x !== assetId)].slice(0, RECENT_MAX)));
  } catch {
    // storage can be blocked: the list is a convenience only
  }
}

const shortId = (assetId: string): string => {
  const i = assetId.indexOf(':');
  const addr = assetId.slice(i + 1);
  return `${chainLabel(assetId.slice(0, i))} ${addr.slice(0, 6)}…${addr.slice(-4)}`;
};

// ---- rendering ----------------------------------------------------------------------------------------------------

const verifiedFor2 = (assetId: string, plain: boolean): HTMLElement | null => {
  const i = assetId.indexOf(':');
  return i < 0 ? null : verifiedBadge(assetId.slice(0, i), assetId.slice(i + 1), { plain });
};

function tile(label: string, value: string, note?: string): HTMLElement {
  return el('div', { class: 'wapp-rd__tile' }, [el('span', { class: 'wapp-rd__tile-label', text: label }), el('strong', { text: value }), note ? el('span', { class: 'wapp-rd__tile-note', text: note }) : null]);
}

export function renderAsset(answer: AssetAnswer, assetId: string): HTMLElement {
  const o = answer.opportunity ?? {};
  const chain = o.chain ?? assetId.slice(0, assetId.indexOf(':'));
  const card = el('div', { class: 'wapp__result wapp-rd__asset' });

  const title = el('div', { class: 'wapp-rd__head' }, [
    el('div', {}, [el('h3', { class: 'wapp-rd__title', text: o.symbol ?? 'Token' }), el('span', { class: 'wapp__fine', text: `${o.name ?? 'Unnamed token'} · ${chainLabel(chain)}` }), el('code', { class: 'wapp-mono wapp-rd__addr', text: assetId.slice(assetId.indexOf(':') + 1) })]),
    pill(classificationLabel(o.classification), o.classification === 'AVOID' ? 'bad' : o.classification === 'INSUFFICIENT_EVIDENCE' ? 'warn' : 'plain'),
  ]);
  card.append(title);
  const verified = verifiedFor2(assetId, false);
  if (verified) card.append(verified);
  card.append(
    el('div', { class: 'wapp-rd__tiles' }, [
      tile('Opportunity', scoreText(o.opportunityScore), o.opportunityScore == null ? 'Not enough data to score' : 'out of 100'),
      tile('Risk', scoreText(o.riskScore), 'higher means more concerns'),
      tile('Confidence', scoreText(o.confidenceScore), 'in this reading'),
      tile('Data coverage', scoreText(o.dataCoverageScore), 'share of evidence found'),
    ]),
  );

  const m = o.metrics ?? {};
  card.append(
    el('dl', { class: 'wapp-rd__kv' }, [
      el('dt', { text: 'Price' }),
      el('dd', { text: usdText(m.priceUsd) }),
      el('dt', { text: 'Market cap' }),
      el('dd', { text: usdText(m.marketCapUsd) }),
      el('dt', { text: 'Liquidity' }),
      el('dd', { text: usdText(m.liquidityUsd) }),
      el('dt', { text: '24h volume' }),
      el('dd', { text: usdText(m.volume24hUsd) }),
    ]),
  );

  for (const n of o.notices ?? []) card.append(el('div', { class: 'wapp-rd__banner wapp-rd__banner--warn', text: n }));
  if (o.mainConcern) card.append(el('div', { class: 'wapp-rd__banner', text: `Main concern: ${o.mainConcern}` }));

  const why = o.whyWatching ?? [];
  if (why.length > 0) card.append(el('div', {}, [el('span', { class: 'wapp__eyebrow', text: 'What Radar noticed' }), el('ul', { class: 'wapp__list' }, why.slice(0, 5).map((w) => el('li', { text: w })))]));

  const findings = o.security?.findings ?? [];
  const failed = findings.filter((f) => f.status === 'FAIL');
  const unknown = findings.filter((f) => f.status === 'UNKNOWN');
  const secHead = el('div', { class: 'wapp-rd__sec-head' }, [el('span', { class: 'wapp__eyebrow', text: 'Contract and market checks' }), pill(`Severity: ${o.security?.severity ?? 'Unknown'}`, failed.length > 0 ? 'warn' : 'plain')]);
  const secList = el('ul', { class: 'wapp__list' });
  for (const f of failed) secList.append(el('li', {}, [el('strong', { text: `${f.check ?? f.id ?? 'Check'} (${(f.severity ?? '').toLowerCase()}): ` }), document.createTextNode(f.message ?? '')]));
  if (failed.length === 0) secList.append(el('li', { text: findings.length === 0 ? 'No check results came back.' : 'No concern reported by the sources checked.' }));
  card.append(el('div', {}, [secHead, secList]));
  if (unknown.length > 0) card.append(el('p', { class: 'wapp__fine', text: `${unknown.length} check${unknown.length === 1 ? '' : 's'} had no data and are not counted as passed: ${unknown.map((f) => f.check ?? f.id ?? '').filter(Boolean).join(', ')}.` }));

  const gaps = (o.unavailableCategories ?? []).map(categoryLabel);
  const failures = o.dataFailures ?? [];
  if (gaps.length > 0 || failures.length > 0) {
    card.append(
      el('p', {
        class: 'wapp__fine',
        text: `${gaps.length > 0 ? `No data yet for: ${gaps.join(', ')}. ` : ''}${failures.length > 0 ? `${failures.length} data request${failures.length === 1 ? '' : 's'} failed this time (${[...new Set(failures.map((x) => x.provider ?? 'a source'))].join(', ')}).` : ''}`.trim(),
      }),
    );
  }

  const eng = o.jevDecision?.engine === 'jev-llm' ? 'Jev Intelligence' : 'baseline Aretia scoring';
  card.append(el('p', { class: 'wapp__fine', text: `Read by ${eng} · data ${ageText(answer.dataAgeSeconds)}` }));

  const actions = el('div', { class: 'wapp-rd__actions' });
  if (SWAPPABLE.has(chain)) {
    const btn = el('button', { class: 'wapp__btn wapp__btn--primary', text: `Open ${o.symbol ?? 'token'} in Swap`, attrs: { type: 'button' } });
    btn.addEventListener('click', () => {
      const i = assetId.indexOf(':');
      window.dispatchEvent(
        new CustomEvent(OPEN_TOKEN_EVENT, {
          detail: { chain: assetId.slice(0, i), address: assetId.slice(i + 1), symbol: o.symbol ?? '', name: o.name ?? '', icon: null, decimals: null, liquidityUsd: m.liquidityUsd ?? null, priceUsd: m.priceUsd ?? null, fresh: false, risk: null },
        }),
      );
    });
    actions.append(btn, el('span', { class: 'wapp__fine', text: 'Opens the normal swap screen. Nothing is sent until you review and confirm there.' }));
  } else actions.append(el('span', { class: 'wapp__fine', text: `The wallet cannot swap on ${chainLabel(chain)} yet, so Radar shows it for research only.` }));
  card.append(actions);

  card.append(el('p', { class: 'wapp__fine', text: answer.disclaimer ?? o.disclaimer ?? 'Radar is analysis, not advice or a forecast. It never trades for you.' }));
  return card;
}

function homeRow(a: RadarAsset, open: (assetId: string) => void): HTMLElement {
  const btn = el('button', { class: 'wapp-rd__row', attrs: { type: 'button' } }, [
    el('span', { class: 'wapp-rd__row-main' }, [el('strong', { text: a.symbol ?? 'Token' }), el('span', { class: 'wapp__fine', text: `${a.name ?? ''} ${a.name ? '· ' : ''}${chainLabel(a.chain)}`.trim() })]),
    el('span', { class: 'wapp-rd__row-nums' }, [el('span', { text: `Opportunity ${scoreText(a.opportunityScore)}` }), el('span', { text: `Risk ${scoreText(a.riskScore)}` })]),
    pill(classificationLabel(a.classification)),
  ]);
  const verified = a.assetId ? verifiedFor2(a.assetId, true) : null;
  if (verified) btn.querySelector('.wapp-rd__row-main')?.append(verified);
  if (a.assetId) btn.addEventListener('click', () => open(a.assetId!));
  return btn;
}

const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function hitLogo(h: SearchHit): HTMLElement {
  const letters = el('span', { class: 'wapp-avatar', text: h.symbol.slice(0, 2).toUpperCase() });
  if (!h.icon) return letters;
  const img = el('img', { class: 'wapp-avatar', attrs: { src: h.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', width: '32', height: '32' } });
  img.addEventListener('error', () => img.replaceWith(letters));
  return img;
}

/** The matches for a name, to choose from. Nothing is analyzed until one is picked: a name can belong to many tokens. */
export function renderSearchResults(hits: SearchHit[], query: string, pick: (h: SearchHit) => void): HTMLElement {
  const box = el('div', { class: 'wapp-rd__home' });
  if (hits.length === 0) {
    box.append(el('p', { class: 'wapp__fine', text: `No tokens found for "${query}" on the networks Radar covers (Solana, Ethereum, Base, BNB Chain, Polygon). Names are not unique, so pasting the token address is the sure way.` }));
    return box;
  }
  const shared = sharedSymbols(hits);
  box.append(el('span', { class: 'wapp__eyebrow', text: `Tokens matching "${query}"` }));
  box.append(el('div', { class: 'wapp-rd__banner wapp-rd__banner--warn', text: 'Anyone can create a token with any name, including a copy of a well-known one. The top match is not always the real token: check the address against the project\'s official source before relying on a result.' }));
  for (const h of hits) {
    const same = shared.get(h.symbol.trim().toUpperCase());
    const row = el('button', { class: 'wapp-rd__row', attrs: { type: 'button' } }, [
      hitLogo(h),
      el('span', { class: 'wapp-rd__row-main' }, [el('strong', { text: h.symbol }), el('span', { class: 'wapp__fine', text: `${h.name || 'No name'} · ${chainLabel(h.chain)} · ${shortAddress(h.address)}` })]),
      el('span', { class: 'wapp-rd__row-nums' }, [el('span', { text: h.liquidityUsd === null ? 'Liquidity unknown' : `Liquidity ${usdText(h.liquidityUsd)}` }), same ? el('span', { text: `${same} tokens use this symbol` }) : null]),
      h.fresh ? pill('New') : null,
    ]);
    const verified = verifiedBadge(h.chain, h.address, { plain: true });
    if (verified) row.querySelector('.wapp-rd__row-main')?.append(verified);
    row.addEventListener('click', () => pick(h));
    box.append(row);
  }
  return box;
}

const HOME_SECTIONS: { key: string; title: string }[] = [
  { key: 'emerging', title: 'Emerging' },
  { key: 'momentum', title: 'Momentum' },
  { key: 'riskAlerts', title: 'Risk alerts' },
];

export function renderHome(h: HomeAnswer, open: (assetId: string) => void): HTMLElement {
  const box = el('div', { class: 'wapp-rd__home' });
  const analyzed = h.summary?.assetsAnalyzed ?? 0;
  if (analyzed === 0) {
    box.append(el('p', { class: 'wapp__fine', text: 'Radar has not analyzed any tokens yet. Paste a token address above to analyze one.' }));
    return box;
  }
  box.append(el('p', { class: 'wapp__fine', text: `${analyzed} token${analyzed === 1 ? '' : 's'} analyzed${h.lastCycleAt ? '' : ' · no scan has completed yet'}.` }));
  let shown = 0;
  for (const s of HOME_SECTIONS) {
    const items = (h.sections?.[s.key] ?? []).slice(0, 5);
    if (items.length === 0) continue;
    shown += items.length;
    box.append(el('span', { class: 'wapp__eyebrow', text: s.title }), ...items.map((a) => homeRow(a, open)));
  }
  if (shown === 0) box.append(el('p', { class: 'wapp__fine', text: 'Nothing is in these lists right now.' }));
  return box;
}

// ---- wiring -------------------------------------------------------------------------------------------------------

export function initRadar(): void {
  const form = document.querySelector<HTMLFormElement>('[data-radar-form]');
  const input = document.querySelector<HTMLInputElement>('#radar-input');
  const chains = document.querySelector<HTMLElement>('[data-radar-chains]');
  const result = document.querySelector<HTMLElement>('[data-radar-result]');
  const home = document.querySelector<HTMLElement>('[data-radar-home]');
  const recent = document.querySelector<HTMLElement>('[data-radar-recent]');
  if (!form || !input || !chains || !result || !home || !recent) return;

  let evmChain: EvmChain = 'ethereum';
  let token = 0;
  let homeLoaded = false;
  // The last list of name matches, kept so a result can offer a way back to it.
  let lastResults: HTMLElement | null = null;

  const drawChains = (): void => {
    chains.hidden = !looksLikeEvmAddress(input.value);
    chains.replaceChildren(
      ...EVM_CHAINS.map((c) => {
        const b = el('button', { class: 'wapp-rd__chain', text: c.label, attrs: { type: 'button', 'aria-pressed': String(c.chain === evmChain) } });
        b.addEventListener('click', () => {
          evmChain = c.chain;
          drawChains();
        });
        return b;
      }),
    );
  };
  const drawRecent = (): void => {
    const ids = readRecent();
    recent.hidden = ids.length === 0;
    recent.replaceChildren(
      ...ids.map((id) => {
        const b = el('button', { class: 'wapp-rd__chain', text: shortId(id), attrs: { type: 'button' } });
        b.addEventListener('click', () => void show(id, false));
        return b;
      }),
    );
  };

  const show = async (assetId: string, fresh: boolean, fromSearch = false): Promise<void> => {
    const mine = ++token;
    result.replaceChildren(el('p', { class: 'wapp__fine', text: fresh ? 'Analyzing this token. This can take up to a minute…' : 'Loading…', attrs: { role: 'status' } }));
    let r = fresh ? await call<AssetAnswer>('analyze', { method: 'POST', body: JSON.stringify({ assetId }) }) : await call<AssetAnswer>('asset', { query: { assetId } });
    // A token Radar has not seen yet is analyzed on the spot instead of ending at a dead end.
    if (!fresh && !r.ok && r.message === radarErrorText('not-analyzed')) {
      result.replaceChildren(el('p', { class: 'wapp__fine', text: 'Radar has not seen this token yet. Analyzing it now (up to a minute)…', attrs: { role: 'status' } }));
      r = await call<AssetAnswer>('analyze', { method: 'POST', body: JSON.stringify({ assetId }) });
    }
    if (mine !== token) return; // a newer request has taken over the panel
    if (!r.ok) {
      result.replaceChildren(el('div', { class: 'wapp-rd__banner wapp-rd__banner--warn', text: r.message, attrs: { role: 'alert' } }));
      return;
    }
    remember(assetId);
    drawRecent();
    const card = renderAsset(r.value, assetId);
    const back = lastResults;
    if (fromSearch && back) {
      const b = el('button', { class: 'wapp-rd__chain', text: 'Back to the matches', attrs: { type: 'button' } });
      b.addEventListener('click', () => result.replaceChildren(back));
      card.prepend(b);
    }
    result.replaceChildren(card);
    homeLoaded = false; // the lists below now include this token
    void loadHome();
  };

  const loadHome = async (): Promise<void> => {
    if (homeLoaded) return;
    homeLoaded = true;
    const r = await call<HomeAnswer>('home');
    home.replaceChildren(r.ok ? renderHome(r.value, (id) => void show(id, false)) : el('p', { class: 'wapp__fine', text: r.message }));
    if (!r.ok) homeLoaded = false;
  };

  const search = async (query: string): Promise<void> => {
    const mine = ++token;
    result.replaceChildren(el('p', { class: 'wapp__fine', text: 'Searching…', attrs: { role: 'status' } }));
    let hits: SearchHit[];
    try {
      hits = await searchForRadar(query);
    } catch {
      if (mine === token) result.replaceChildren(el('div', { class: 'wapp-rd__banner wapp-rd__banner--warn', text: 'The search could not be reached. Try again in a moment, or paste the token address.', attrs: { role: 'alert' } }));
      return;
    }
    if (mine !== token) return; // a newer request has taken over the panel
    const list = renderSearchResults(hits, query, (h) => void show(assetIdOf(h.chain, h.address), true, true));
    lastResults = list;
    result.replaceChildren(list);
  };

  input.addEventListener('input', drawChains);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = classifyInput(input.value, evmChain);
    if (c.kind === 'address') {
      lastResults = null;
      void show(c.assetId, true);
    } else if (c.kind === 'name') void search(c.query);
    else result.replaceChildren(el('div', { class: 'wapp-rd__banner wapp-rd__banner--warn', text: c.message, attrs: { role: 'alert' } }));
  });

  const onRoute = (): void => {
    if (location.hash === '#/radar') void loadHome();
  };
  window.addEventListener('hashchange', onRoute);
  drawChains();
  drawRecent();
  onRoute();
}
