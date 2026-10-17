/**
 * Aretia Launch on the web wallet: the rules for opening a liquidity pool for a token, with no network access and no keys.
 *
 * The pool is a Meteora DAMM v2 pool (the same program the Aretia treasury uses for the ACT pools, see scripts/launch-pool). It is
 * single-sided: only the creator's tokens go in, at a starting price the creator chooses, and nothing goes up the price curve
 * below that start. Buyers pay SOL, which builds the other side of the pool. The creator's own wallet is the pool's creator and
 * owner of the position, and no Aretia program is involved.
 *
 * Choices made here, on purpose:
 *  - Only fixed-supply Token-2022 tokens with no freeze power and none of the other extensions (transfer fee, hook, ...) qualify.
 *    That is exactly what the Launch page makes, so a pool opened here can never hold a token whose supply can grow or whose
 *    holders can be frozen. Anything else is refused with a plain reason.
 *  - Liquidity is ALWAYS locked for good: there is no option to keep it. A locked position cannot be withdrawn by anyone, the creator
 *    included; its trading fees can still be claimed. Aretia's promise to buyers is that no pool opened here can be pulled out.
 *    (The transaction builder and its inspector still handle an unlocked pool, so their tests keep covering both; the form never asks for one.)
 *  - Aretia charges one flat fee, paid in SOL in the same transaction. The pool's own trading fee goes to the creator's position.
 */
import { isSolanaAddress, toSmallestUnit } from './walletTools';
import { LAUNCH_FEE_ADDRESS } from './walletLaunchCore';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;

/** Aretia's flat fee for opening a pool: 0.05 SOL, to the same management-fee wallet as the token creation fee. */
export const POOL_FEE_LAMPORTS = 50_000_000n;
export const POOL_FEE_ADDRESS = LAUNCH_FEE_ADDRESS;

/** The trading fees a creator can pick, in basis points. */
export const POOL_TRADING_FEES_BPS = [25, 100] as const;

/** Token-2022 extension types a poolable token may carry: the metadata pointer (18) and the token metadata (19), which hold its name, symbol and link. */
export const ALLOWED_EXTENSIONS: readonly number[] = [18, 19];

export interface PoolForm {
  mint: string;
  /** Whole tokens, commas allowed. */
  tokenAmount: string;
  /** SOL per one whole token, as a plain decimal. */
  price: string;
  tradingFeeBps: string;
}

export const DEFAULT_POOL_FORM: PoolForm = { mint: '', tokenAmount: '', price: '', tradingFeeBps: '25' };

/** What is known about the token before a pool is opened. */
export interface PoolToken {
  mint: string;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: readonly number[];
  /** The creator's balance of it, in its smallest unit. */
  held: bigint;
}

export interface PoolConfig {
  creator: string;
  mint: string;
  decimals: number;
  tokenAmountRaw: bigint;
  /** Normalised decimal text, SOL per token. */
  price: string;
  tradingFeeBps: number;
  lockLiquidity: boolean;
}

export interface PoolIssue {
  field: keyof PoolForm | 'form';
  message: string;
}

/** Why a token cannot get a pool here. Empty means it can. */
export function tokenBlockers(t: PoolToken): string[] {
  const out: string[] = [];
  if (t.mintAuthority !== null) out.push('Someone can still create more of this token. Only fixed-supply tokens can get a pool here.');
  if (t.freezeAuthority !== null) out.push('Someone can freeze holders of this token. Tokens with a freeze power cannot get a pool here.');
  const extra = t.extensions.filter((e) => !ALLOWED_EXTENSIONS.includes(e));
  if (extra.length > 0) out.push('This token has features this page does not support in a pool (such as a transfer fee or a transfer hook).');
  return out;
}

/** "0.000001" -> normalised. Null unless a plain positive decimal with at most 12 places, no exponent, and above zero. */
export function normalisePrice(text: string): string | null {
  const m = /^(\d{1,9})(?:\.(\d{1,12}))?$/.exec(text.trim());
  if (!m) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (/^0*$/.test(whole) && frac === '') return null;
  return frac === '' ? whole : `${whole}.${frac}`;
}

export type PoolValidation = { ok: true; config: PoolConfig } | { ok: false; issues: PoolIssue[] };

export function validatePool(form: PoolForm, creator: string, token: PoolToken | null): PoolValidation {
  const issues: PoolIssue[] = [];
  const add = (field: PoolIssue['field'], message: string) => issues.push({ field, message });

  if (!isSolanaAddress(creator)) add('form', 'Connect a wallet first.');
  if (!isSolanaAddress(form.mint.trim())) add('mint', 'A valid token address.');
  else if (token === null) add('mint', 'This token could not be read from the network, or it is not a Token-2022 token.');
  else for (const b of tokenBlockers(token)) add('mint', b);

  let tokenAmountRaw = 0n;
  if (token !== null) {
    const raw = toSmallestUnit(form.tokenAmount.replace(/,/g, '').trim(), token.decimals);
    if (raw === null || BigInt(raw) <= 0n) add('tokenAmount', 'A number above zero, with no more decimal places than the token has.');
    else {
      tokenAmountRaw = BigInt(raw);
      if (tokenAmountRaw > token.held) add('tokenAmount', 'More than your wallet holds of this token.');
    }
  }

  const price = normalisePrice(form.price);
  if (price === null) add('price', 'A starting price in SOL per token, like 0.000001 (up to 12 decimal places).');

  const fee = Number(form.tradingFeeBps);
  if (!(POOL_TRADING_FEES_BPS as readonly number[]).includes(fee)) add('tradingFeeBps', 'Choose one of the listed trading fees.');

  if (issues.length > 0 || token === null || price === null) return { ok: false, issues };
  return {
    ok: true,
    config: { creator, mint: token.mint, decimals: token.decimals, tokenAmountRaw, price, tradingFeeBps: fee, lockLiquidity: true },
  };
}

export interface PoolCost {
  /** Aretia's flat fee. */
  aretiaFee: bigint;
  /** Everything else the transaction takes from the wallet: the network fee and the deposits that keep the pool's accounts alive. */
  network: bigint;
  total: bigint;
}

/**
 * Deposits and fees other than Aretia's, measured by simulating the real transaction (see walletPoolFlow.ts) with this as the
 * fallback when a simulation cannot report a balance. Deliberately on the high side.
 */
export const POOL_NETWORK_ESTIMATE_LAMPORTS = 30_000_000n;

export function poolCost(network: bigint): PoolCost {
  return { aretiaFee: POOL_FEE_LAMPORTS, network, total: POOL_FEE_LAMPORTS + network };
}

/** Plain-language consequences, shown before signing. Never says a pool is safe. */
export function poolDisclosures(config: PoolConfig): { severity: 'info' | 'caution'; text: string }[] {
  return [
    config.lockLiquidity
      ? { severity: 'info', text: 'The liquidity is locked for good. Nobody, you included, can take the tokens or the SOL back out of the pool. You can still claim its trading fees.' }
      : { severity: 'caution', text: 'The liquidity is not locked. You can remove it at any time, which would leave holders with no market.' },
    { severity: 'info', text: 'Only your tokens go in. Nobody can buy below the starting price, and buyers pay SOL that builds the other side of the pool.' },
    { severity: 'caution', text: 'The starting price is yours to choose and is not checked against any market. A price set far from what people will pay can leave the pool with no buyers.' },
    { severity: 'caution', text: 'This is on Solana mainnet. The transaction is real, the fees and deposits are paid in your SOL, and a pool cannot be deleted.' },
  ];
}
