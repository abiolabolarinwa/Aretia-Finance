/**
 * The Radar page of the wallet: look up a token, see what Aretia Radar found, and, if the person wants to act, open the
 * wallet's own swap screen. Radar only reads and explains; this page never quotes, signs or sends anything.
 *
 * It talks to /api/swings-radar (api/_radarProxy.ts), never to the Radar server directly. Everything the server says is
 * shown as it is: an unknown figure reads "Unknown", never as a zero, a pass or a good sign.
 */
import { OPEN_TOKEN_EVENT } from './walletSearch.js';

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

function tile(label: string, value: string, note?: string): HTMLElement {
  return el('div', { class: 'wapp-rd__tile' }, [el('span', { class: 'wapp-rd__tile-label', text: label }), el('strong', { text: value }), note ? el('span', { class: 'wapp-rd__tile-note', text: note }) : null]);
}

export function renderAsset(answer: AssetAnswer, assetId: string): HTMLElement {
  const o = answer.opportunity ?? {};
  const chain = o.chain ?? assetId.slice(0, assetId.indexOf(':'));
  const card = el('div', { class: 'wapp__result wapp-rd__asset' });

  const title = el('div', { class: 'wapp-rd__head' }, [
    el('div', {}, [el('h3', { class: 'wapp-rd__title', text: o.symbol ?? 'Token' }), el('span', { class: 'wapp__fine', text: `${o.name ?? 'Unnamed token'} · ${chainLabel(chain)}` })]),
    pill(classificationLabel(o.classification), o.classification === 'AVOID' ? 'bad' : o.classification === 'INSUFFICIENT_EVIDENCE' ? 'warn' : 'plain'),
  ]);
  card.append(title);
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
  if (a.assetId) btn.addEventListener('click', () => open(a.assetId!));
  return btn;
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

  const show = async (assetId: string, fresh: boolean): Promise<void> => {
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
    result.replaceChildren(renderAsset(r.value, assetId));
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

  input.addEventListener('input', drawChains);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = assetIdFromInput(input.value, evmChain);
    if (!id) {
      result.replaceChildren(el('div', { class: 'wapp-rd__banner wapp-rd__banner--warn', text: 'Paste a token address: Solana (32-44 letters and numbers) or EVM (0x followed by 40 letters and numbers).', attrs: { role: 'alert' } }));
      return;
    }
    void show(id, true);
  });

  const onRoute = (): void => {
    if (location.hash === '#/radar') void loadHome();
  };
  window.addEventListener('hashchange', onRoute);
  drawChains();
  drawRecent();
  onRoute();
}
