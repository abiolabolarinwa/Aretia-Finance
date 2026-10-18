/**
 * The public token page (/token#/<chain>/<address>): its address scheme and the pure parts of what it shows.
 * Nothing here touches the network or the page, so every line is testable. The page itself is walletTokenPublic.ts.
 *
 * Honesty rule: a fact is either read from a chain (and said so) or marked as not read. Nothing is guessed.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { normalizeTokenRef } from '../swings/core/token.js';
import { fromSmallestUnit } from './walletTools.js';
import type { MintFacts } from './walletLaunchChain.js';
import { curveProgressPercent, priceText, type CurveState } from './walletCurveCore.js';
import { evmPriceText, type EvmCurveState } from './walletCurveEvmCore.js';

/** The networks a token page opens for. */
export const TOKEN_PAGE_CHAINS = ['solana', 'bnb', 'ethereum', 'polygon'] as const satisfies readonly ChainId[];
export type TokenPageChain = (typeof TOKEN_PAGE_CHAINS)[number];

export const TOKEN_PAGE_ORIGIN = 'https://aretiafinance.org';

export interface TokenPageRef {
  chain: TokenPageChain;
  address: string;
}

export const isTokenPageChain = (v: unknown): v is TokenPageChain => (TOKEN_PAGE_CHAINS as readonly unknown[]).includes(v);

/** "#/<chain>/<address>" to a token, or null for anything else. EVM addresses come back lower-case; Solana ones as written. */
export function parseTokenPageHash(hash: string): TokenPageRef | null {
  const m = /^#\/?([a-z]+)\/([A-Za-z0-9]+)\/?$/.exec(hash.trim());
  if (!m || !isTokenPageChain(m[1])) return null;
  const ref = normalizeTokenRef(m[1], m[2]);
  return ref ? { chain: m[1], address: ref.address } : null;
}

export const tokenPageHash = (chain: ChainId, address: string): string => `#/${chain}/${CHAINS[chain].kind === 'evm' ? address.toLowerCase() : address}`;

/** The shareable link for a token, with the site's address on the front. */
export const tokenPageUrl = (chain: ChainId, address: string, origin: string = TOKEN_PAGE_ORIGIN): string => `${origin}/token${tokenPageHash(chain, address)}`;

/** The path (relative) to open a token's page, for links inside the site. */
export const tokenPagePath = (chain: ChainId, address: string): string => `/token${tokenPageHash(chain, address)}`;

/** The wallet's swap screen with this token chosen as the one to receive: "/wallet#/swap/<chain>/<address>". */
export const swapPath = (chain: ChainId, address: string): string => `/wallet${swapHash(chain, address)}`;
export const swapHash = (chain: ChainId, address: string): string => `#/swap/${chain}/${CHAINS[chain].kind === 'evm' ? address.toLowerCase() : address}`;

/** "#/swap/<chain>/<address>" to the token it names, or null. Any chain the wallet knows is accepted. */
export function parseSwapHash(hash: string): { chain: ChainId; address: string } | null {
  const m = /^#\/swap\/([a-z]+)\/([A-Za-z0-9]+)\/?$/.exec(hash.trim());
  if (!m) return null;
  const ref = normalizeTokenRef(m[1], m[2]);
  return ref ? { chain: ref.chain, address: ref.address } : null;
}

export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** What the Share button sends. */
export function shareText(symbol: string, chain: ChainId): string {
  return `${symbol} on ${CHAINS[chain].name}: price, supply and the facts that can be read from the chain, on Aretia.`;
}

// ---------------------------------------------------------------- what the token itself says

export interface Fact {
  label: string;
  value: string;
  /** 'good' for a power given up, 'warn' for one still held, 'unknown' for what could not be read. */
  tone: 'good' | 'warn' | 'unknown' | 'plain';
  note?: string;
}

const WHOLE = (raw: bigint, decimals: number): string => {
  const t = fromSmallestUnit(raw, decimals);
  const [w, f] = t.split('.');
  const grouped = w!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${grouped}.${f.slice(0, 4)}` : grouped;
};
export const formatSupply = WHOLE;

const TRANSFER_FEE_EXTENSION = 1;

/**
 * Facts from a Solana mint account (SPL Token or Token-2022). Whether the supply is fixed is "mint authority given up",
 * which is exactly what the chain records; "freeze" likewise.
 */
export function solanaMintFacts(m: MintFacts): Fact[] {
  const out: Fact[] = [{ label: 'Total supply', value: WHOLE(m.supply, m.decimals), tone: 'plain' }];
  out.push(
    m.mintAuthority === null
      ? { label: 'Supply', value: 'Fixed: the mint power is given up, so no more can ever be created', tone: 'good' }
      : { label: 'Supply', value: `Not fixed: ${shortAddress(m.mintAuthority)} can still create more`, tone: 'warn' },
  );
  out.push(
    m.freezeAuthority === null
      ? { label: 'Freeze power', value: 'Given up: no one can freeze holders', tone: 'good' }
      : { label: 'Freeze power', value: `Held by ${shortAddress(m.freezeAuthority)}, who can freeze a holder’s tokens`, tone: 'warn' },
  );
  if (m.extensions.includes(TRANSFER_FEE_EXTENSION)) out.push({ label: 'Transfer fee', value: 'This token takes a fee on every transfer (set by the token itself)', tone: 'warn' });
  out.push({ label: 'Decimals', value: String(m.decimals), tone: 'plain' });
  return out;
}

/** An unreadable mint, said plainly. */
export const solanaMintUnreadable = (): Fact[] => [{ label: 'Supply and powers', value: 'Could not be read from the chain just now', tone: 'unknown' }];

export function evmTokenFacts(totalSupply: bigint | null, decimals: number): Fact[] {
  return [
    totalSupply === null ? { label: 'Total supply', value: 'Could not be read', tone: 'unknown' } : { label: 'Total supply', value: WHOLE(totalSupply, decimals), tone: 'plain' },
    { label: 'Mint and freeze powers', value: 'Not checked on this network: a contract can hide them in code the page does not read. Use Shield before you buy.', tone: 'unknown' },
    { label: 'Decimals', value: String(decimals), tone: 'plain' },
  ];
}

// ---------------------------------------------------------------- an Aretia Curve

export type CurveStatusName = 'trading' | 'soldOut' | 'migrated' | 'aborted';

export const CURVE_STATUS_TEXT: Readonly<Record<CurveStatusName, string>> = {
  trading: 'Open: buying and selling on the curve',
  soldOut: 'Sold out: waiting to move to a normal pool',
  migrated: 'Finished: moved to a normal pool',
  aborted: 'Unwound: holders can sell back',
};

export interface CurveView {
  status: CurveStatusName;
  statusText: string;
  /** Whole percent of the curve’s tokens sold. */
  percent: number;
  raised: string;
  target: string;
  coin: string;
  priceNow: string;
  creator: string;
}

/** Marginal price, trimmed to something readable without inventing digits: the first 6 significant ones. */
export function trimPrice(text: string): string {
  const [w, f = ''] = text.split('.');
  if (w !== '0') return f ? `${w}.${f.slice(0, 4)}` : w!;
  const lead = f.match(/^0*/)![0].length;
  return `0.${f.slice(0, lead + 6)}`;
}

export function solanaCurveView(c: CurveState, decimals: number): CurveView {
  return {
    status: c.status,
    statusText: CURVE_STATUS_TEXT[c.status],
    percent: c.status === 'trading' || c.status === 'soldOut' ? curveProgressPercent(c) : 100,
    raised: fromSmallestUnit(c.realSol, 9),
    target: fromSmallestUnit(c.target, 9),
    coin: 'SOL',
    priceNow: trimPrice(priceText(c, decimals)),
    creator: c.creator,
  };
}

export function evmCurveView(c: EvmCurveState, decimals: number, coin: string): CurveView | null {
  if (c.status === 'none') return null;
  return {
    status: c.status,
    statusText: CURVE_STATUS_TEXT[c.status],
    percent: c.status === 'trading' || c.status === 'soldOut' ? curveProgressPercent(c) : 100,
    raised: fromSmallestUnit(c.realSol, 18),
    target: fromSmallestUnit(c.target, 18),
    coin,
    priceNow: trimPrice(evmPriceText(c, decimals)),
    creator: c.creator,
  };
}

/** What the Buy button should do for a token, given where it can trade. A curve that is still open cannot be bought through the swap. */
export function buyRoute(view: CurveView | null, chainSwapsOn: boolean): 'swap' | 'curve' | 'off' {
  if (view && (view.status === 'trading' || view.status === 'soldOut')) return 'curve';
  return chainSwapsOn ? 'swap' : 'off';
}
