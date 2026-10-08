/**
 * The Intent layer: a small, fixed grammar that turns a typed request ("move 50 usdc from ethereum to base") into a
 * structured Intent. There is no AI and no guessing: the same text always gives the same answer, anything it does not
 * recognise is refused with an example, and anything it cannot fill in is listed as MISSING for the user to supply.
 *
 * An intent is only a description of what the user asked. It never executes anything. It goes to the planner and the
 * quote engines, and the user still sees and signs every step.
 *
 * Text is treated as data: only the words the grammar recognises are used. Instructions hidden in the text do nothing.
 */
import { CHAIN_IDS, type ChainId } from '../core/types.js';

export interface TokenQuery {
  symbol: string;
  /** Only when the user typed an address. A symbol alone is never turned into an address here (symbols are not unique). */
  address: string | null;
}

export type Intent =
  | { kind: 'buy'; fiat: string | null; amount: number | null; token: TokenQuery; chain: ChainId | null }
  | { kind: 'sell'; fiat: string | null; amount: number | null; token: TokenQuery; chain: ChainId | null }
  | { kind: 'swap'; amount: string | null; from: TokenQuery; to: TokenQuery; chain: ChainId | null }
  | { kind: 'move'; amount: string | null; token: TokenQuery; fromChain: ChainId | null; toChain: ChainId | null };

export type ParseResult = { ok: true; intent: Intent; missing: string[]; notes: string[] } | { ok: false; reason: string };

export const EXAMPLES = ['buy 100 usd of usdc on base', 'sell 50 usdc on ethereum for eur', 'swap 1 sol to act', 'move 250 usdc from ethereum to base'];

const CHAIN_WORDS: Readonly<Record<string, ChainId>> = {
  solana: 'solana', sol: 'solana', ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum', bnb: 'bnb', bsc: 'bnb', binance: 'bnb', polygon: 'polygon', matic: 'polygon', base: 'base', arbitrum: 'arbitrum', arb: 'arbitrum', optimism: 'optimism', op: 'optimism', avalanche: 'avalanche', avax: 'avalanche',
};
const FIAT_SYMBOLS: Readonly<Record<string, string>> = { $: 'usd', '€': 'eur', '£': 'gbp' };
const FIAT_CODES = new Set(['usd', 'eur', 'gbp', 'ngn', 'cad', 'aud', 'chf', 'jpy', 'inr', 'brl', 'mxn', 'zar', 'kes', 'ghs', 'try', 'sgd', 'hkd', 'nzd', 'sek', 'nok', 'dkk', 'pln']);

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(k)?`;
const EVM_ADDR = /^0x[0-9a-f]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function amountOf(text: string): { whole: number | null; decimal: string | null } {
  const m = new RegExp(`^${AMOUNT}$`).exec(text.trim());
  if (!m) return { whole: null, decimal: null };
  const base = (m[1] ?? '0').replace(/,/g, '') + (m[2] ?? '');
  const decimal = m[3] ? String(Number(base) * 1000) : base;
  const n = Number(decimal);
  return { whole: Number.isInteger(n) && n > 0 ? n : null, decimal: /^\d+(\.\d+)?$/.test(decimal) && n > 0 ? decimal : null };
}

function chainIn(text: string, prefix: RegExp): ChainId | null {
  const m = prefix.exec(text);
  const w = m?.[1];
  return w && CHAIN_WORDS[w] ? CHAIN_WORDS[w]! : null;
}

function tokenOf(word: string | undefined, original: string): TokenQuery | null {
  if (!word) return null;
  if (EVM_ADDR.test(word)) return { symbol: word.slice(0, 6), address: word };
  const raw = original.split(/\s+/).find((w) => w.toLowerCase() === word);
  if (raw && SOL_ADDR.test(raw) && raw.length >= 32) return { symbol: raw.slice(0, 4), address: raw };
  return /^[a-z][a-z0-9]{1,9}$/.test(word) ? { symbol: word.toUpperCase(), address: null } : null;
}

export function parseIntent(input: string): ParseResult {
  const original = input.trim().slice(0, 200);
  const text = original
    .toLowerCase()
    .replace(/([$€£])\s*(\d[\d,]*(?:\.\d+)?k?)/g, (_m, c: string, n: string) => `${n} ${FIAT_SYMBOLS[c]}`)
    .replace(/[$€£]/g, (c) => ` ${FIAT_SYMBOLS[c]} `)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { ok: false, reason: `Say what you want, for example: ${EXAMPLES[0]}` };
  const refuse = (): ParseResult => ({ ok: false, reason: `That is not something Aretia can read yet. Try: ${EXAMPLES.join(' · ')}` });
  const verb = /^(buy|purchase|sell|swap|convert|exchange|move|bridge)\b/.exec(text)?.[1];
  if (!verb) return refuse();
  const rest = text.slice(verb.length).trim();
  const missing: string[] = [];
  const notes: string[] = [];

  if (verb === 'move' || verb === 'bridge') {
    const m = new RegExp(`^${AMOUNT}\\s+([a-z0-9]+)\\s+from\\s+([a-z]+)\\s+to\\s+([a-z]+)$`).exec(rest);
    if (!m) return refuse();
    const amt = amountOf(`${m[1]}${m[2] ?? ''}${m[3] ?? ''}`);
    const token = tokenOf(m[4], original);
    const fromChain = CHAIN_WORDS[m[5]!] ?? null;
    const toChain = CHAIN_WORDS[m[6]!] ?? null;
    if (!token || token.symbol !== 'USDC') return { ok: false, reason: 'Only USDC can be moved between networks.' };
    if (!fromChain || !toChain) return { ok: false, reason: 'Name two networks Aretia supports, for example: from ethereum to base.' };
    if (fromChain === toChain) return { ok: false, reason: 'Moving needs two different networks. To change tokens on one network, use swap.' };
    if (amt.decimal === null) missing.push('amount');
    return { ok: true, intent: { kind: 'move', amount: amt.decimal, token, fromChain, toChain }, missing, notes };
  }

  if (verb === 'swap' || verb === 'convert' || verb === 'exchange') {
    const m = new RegExp(`^${AMOUNT}\\s+([a-z0-9]+)\\s+(?:to|for|into)\\s+([a-z0-9]+)(?:\\s+on\\s+([a-z]+))?$`).exec(rest);
    if (!m) return refuse();
    const amt = amountOf(`${m[1]}${m[2] ?? ''}${m[3] ?? ''}`);
    const from = tokenOf(m[4], original);
    const to = tokenOf(m[5], original);
    if (!from || !to) return refuse();
    if (from.symbol === to.symbol && from.address === to.address) return { ok: false, reason: 'That swaps a token for itself.' };
    const chain = m[6] ? (CHAIN_WORDS[m[6]] ?? null) : null;
    if (m[6] && !chain) return { ok: false, reason: `Aretia does not support the network "${m[6]}".` };
    if (amt.decimal === null) missing.push('amount');
    if (!chain) missing.push('network');
    if (!from.address) notes.push(`${from.symbol} is a name, not a unique token. Aretia will ask you to pick the exact token.`);
    if (!to.address) notes.push(`${to.symbol} is a name, not a unique token. Aretia will ask you to pick the exact token.`);
    return { ok: true, intent: { kind: 'swap', amount: amt.decimal, from, to, chain }, missing, notes };
  }

  // buy / sell: the amount is in the user's currency, because that is what a ramp takes.
  const side = verb === 'sell' ? 'sell' : 'buy';
  let fiat: string | null = null;
  let amount: number | null = null;
  let body = rest;
  const lead = new RegExp(`^${AMOUNT}\\s+(usd|eur|gbp|[a-z]{3})\\s+(?:worth\\s+)?(?:of\\s+)?`).exec(body);
  if (lead && FIAT_CODES.has(lead[4]!)) {
    fiat = lead[4]!;
    amount = amountOf(`${lead[1]}${lead[2] ?? ''}${lead[3] ?? ''}`).whole;
    body = body.slice(lead[0].length);
  }
  const tail = /\s+(?:with|for)\s+(?:(\d[\d,.]*k?)\s+)?([a-z]{3})$/.exec(body);
  if (tail && FIAT_CODES.has(tail[2]!)) {
    fiat = tail[2]!;
    if (tail[1]) amount = amountOf(tail[1]).whole;
    body = body.slice(0, tail.index);
  }
  const chain = chainIn(body, /\bon\s+([a-z]+)$/);
  if (/\bon\s+[a-z]+$/.test(body) && !chain) return { ok: false, reason: `Aretia does not support the network "${/\bon\s+([a-z]+)$/.exec(body)![1]}".` };
  body = body.replace(/\s*\bon\s+[a-z]+$/, '').trim();
  const cryptoAmt = new RegExp(`^${AMOUNT}\\s+([a-z0-9]+)$`).exec(body);
  let tokenWord: string | undefined = body;
  if (cryptoAmt) {
    tokenWord = cryptoAmt[4];
    notes.push(`You gave an amount of ${tokenWord!.toUpperCase()}. Buying and selling through a provider is priced in your currency, so give an amount in your currency instead.`);
  }
  const token = tokenOf(tokenWord, original);
  if (!token) return refuse();
  if (fiat === null) missing.push('currency');
  if (amount === null) missing.push('amount in your currency');
  if (!chain) missing.push('network');
  return { ok: true, intent: { kind: side, fiat, amount, token, chain }, missing, notes };
}

/** True when nothing more is needed from the user to go on to planning. */
export const isComplete = (r: ParseResult): boolean => r.ok && r.missing.length === 0;

export const SUPPORTED_CHAIN_WORDS = [...CHAIN_IDS];
