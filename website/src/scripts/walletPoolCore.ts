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
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, isSolanaAddress, toSmallestUnit } from './walletTools.js';
import { LAUNCH_FEE_ADDRESS } from './walletLaunchCore.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;

/**
 * What buyers pay with: the other side of the pool. SOL by default; USDC, or any other token whose mint the page has read from the
 * network (never one typed in without a read). The pool is single-sided either way: only the creator's tokens go in.
 */
export interface PoolQuote {
  mint: string;
  decimals: number;
  /** Shown to people: "SOL", "USDC", or a short form of the address for another token. */
  symbol: string;
  /** The token program that owns the mint: the classic one, or Token-2022. */
  program: string;
  /** Whether someone holds the power to create more of it, or to freeze balances of it. Read from the mint, shown before signing. */
  mintable: boolean;
  freezable: boolean;
}

export const SOL_QUOTE: PoolQuote = { mint: WSOL_MINT, decimals: SOL_DECIMALS, symbol: 'SOL', program: TOKEN_PROGRAM_ID, mintable: false, freezable: false };

export type QuoteChoice = 'SOL' | 'USDC' | 'custom';
export const QUOTE_CHOICES: readonly QuoteChoice[] = ['SOL', 'USDC', 'custom'];
/** The published USDC mint on Solana and the decimals it must read back with. A choice of USDC is accepted only if the network agrees. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;
/** The wrapped-SOL mint of Token-2022 (a different address from the classic one). The pool program does not accept it. */
export const NATIVE_MINT_2022 = '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';

/** What the network says about a quote mint: the account's owner and the mint's facts, as read. */
export interface QuoteRead {
  mint: string;
  program: string;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: readonly number[];
}

export const quoteOf = (config: Pick<PoolConfig, 'quote'>): PoolQuote => config.quote ?? SOL_QUOTE;

/** Aretia's flat fee for opening a pool: 0.05 SOL, to the same management-fee wallet as the token creation fee. */
export const POOL_FEE_LAMPORTS = 50_000_000n;
export const POOL_FEE_ADDRESS = LAUNCH_FEE_ADDRESS;

/** The trading fees a creator can pick, in basis points. */
export const POOL_TRADING_FEES_BPS = [25, 100] as const;

/** Token-2022 extension types a poolable token may carry: the metadata pointer (18) and the token metadata (19), which hold its name, symbol and link. */
export const ALLOWED_EXTENSIONS: readonly number[] = [18, 19];

/** Launch protection: the fee starts at 5% and falls in a straight line to the creator's fee over 10, 30 or 60 minutes. */
export const LAUNCH_PROTECTION_START_BPS = 500;
export const LAUNCH_PROTECTION_MINUTES = [10, 30, 60] as const;
/** Fifty equal steps: the window (600, 1800 or 3600 s) and the fee drop (475 or 400 bps) both divide by 50 exactly, so the fee ends exactly on the creator's fee. */
export const LAUNCH_PROTECTION_PERIODS = 50;

export interface LaunchProtection {
  startBps: number;
  minutes: number;
}

/** The fee-scheduler numbers (Meteora's units: fee numerators out of 1,000,000,000, seconds), worked out with no SDK. */
export function protectionSchedule(endBps: number, p: LaunchProtection): { cliff: bigint; periods: number; frequency: bigint; reduction: bigint } {
  const cliff = BigInt(p.startBps) * 100_000n;
  const end = BigInt(endBps) * 100_000n;
  const periods = LAUNCH_PROTECTION_PERIODS;
  return { cliff, periods, frequency: BigInt((p.minutes * 60) / periods), reduction: (cliff - end) / BigInt(periods) };
}

export interface PoolForm {
  mint: string;
  /** Whole tokens, commas allowed. */
  tokenAmount: string;
  /** SOL per one whole token, as a plain decimal. */
  price: string;
  /** What buyers pay with. */
  quote: QuoteChoice;
  /** The pair token's address, when `quote` is 'custom'. */
  quoteMint: string;
  tradingFeeBps: string;
  /** Launch protection on (the default) or off. */
  protection: boolean;
  protectionMinutes: string;
}

export const DEFAULT_POOL_FORM: PoolForm = { mint: '', tokenAmount: '', price: '', quote: 'SOL', quoteMint: '', tradingFeeBps: '25', protection: true, protectionMinutes: '30' };

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
  /** Normalised decimal text, in the pair token per token (SOL unless `quote` says otherwise). */
  price: string;
  /** What buyers pay with. Absent: SOL. */
  quote?: PoolQuote;
  /** The fee the pool settles on (and, without launch protection, the fee from the first trade). */
  tradingFeeBps: number;
  lockLiquidity: boolean;
  /** Absent or null: a flat fee from the first trade. */
  launchProtection?: LaunchProtection | null;
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

/**
 * Why a pair token cannot be the other side of a pool here. Empty means it can. A pair is accepted only from a real read of its mint:
 * the right program, initialised, with decimals the page knows. Token-2022 pair tokens may carry only the metadata extensions.
 */
export function quoteBlockers(read: QuoteRead | null, choice: QuoteChoice, tokenMint: string): string[] {
  if (choice === 'SOL') return [];
  if (read === null) return ['The pair token could not be read from the network, so it cannot be used.'];
  const out: string[] = [];
  if (read.mint === tokenMint) out.push('The pair token cannot be the token itself.');
  if (read.mint === WSOL_MINT || read.mint === NATIVE_MINT_2022) out.push('To pair with SOL, choose SOL.');
  if (read.program !== TOKEN_PROGRAM_ID && read.program !== TOKEN_2022_PROGRAM_ID) out.push('The pair token is not a standard token.');
  if (!Number.isInteger(read.decimals) || read.decimals < 0 || read.decimals > 12) out.push('The pair token has a number of decimals this page does not support.');
  if (choice === 'USDC' && (read.mint !== USDC_MINT || read.decimals !== USDC_DECIMALS)) out.push('That is not USDC as the network reports it.');
  if (read.program === TOKEN_2022_PROGRAM_ID && read.extensions.some((e) => !ALLOWED_EXTENSIONS.includes(e)))
    out.push('The pair token has features (such as a transfer fee or a transfer hook) that this page does not support in a pool.');
  return out;
}

/** The quote a read describes, with the symbol people will see. */
export function quoteFromRead(read: QuoteRead, choice: QuoteChoice): PoolQuote {
  return {
    mint: read.mint,
    decimals: read.decimals,
    symbol: choice === 'USDC' ? 'USDC' : `${read.mint.slice(0, 4)}…${read.mint.slice(-4)}`,
    program: read.program,
    mintable: read.mintAuthority !== null,
    freezable: read.freezeAuthority !== null,
  };
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

export function validatePool(form: PoolForm, creator: string, token: PoolToken | null, quoteRead: QuoteRead | null = null): PoolValidation {
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

  // What buyers pay with. SOL needs no read; USDC and any other token are accepted only from a read of their mint.
  const choice: QuoteChoice = QUOTE_CHOICES.includes(form.quote) ? form.quote : 'SOL';
  let quote: PoolQuote | undefined;
  if (choice === 'custom' && !isSolanaAddress(form.quoteMint.trim())) add('quoteMint', 'A valid token address for the pair token.');
  else if (choice !== 'SOL') {
    const blockers = quoteBlockers(quoteRead, choice, form.mint.trim());
    for (const b of blockers) add(choice === 'custom' ? 'quoteMint' : 'quote', b);
    if (blockers.length === 0 && quoteRead) quote = quoteFromRead(quoteRead, choice);
  }
  const pairName = quote?.symbol ?? (choice === 'SOL' ? 'SOL' : 'the pair token');

  const price = normalisePrice(form.price);
  if (price === null) add('price', `A starting price in ${pairName} per token, like 0.000001 (up to 12 decimal places).`);

  const fee = Number(form.tradingFeeBps);
  if (!(POOL_TRADING_FEES_BPS as readonly number[]).includes(fee)) add('tradingFeeBps', 'Choose one of the listed trading fees.');

  const minutes = Number(form.protectionMinutes);
  if (form.protection && !(LAUNCH_PROTECTION_MINUTES as readonly number[]).includes(minutes)) add('protectionMinutes', 'Choose one of the listed windows.');

  if (issues.length > 0 || token === null || price === null) return { ok: false, issues };
  return {
    ok: true,
    config: { creator, mint: token.mint, decimals: token.decimals, tokenAmountRaw, price, ...(quote ? { quote } : {}), tradingFeeBps: fee, lockLiquidity: true, launchProtection: form.protection ? { startBps: LAUNCH_PROTECTION_START_BPS, minutes } : null },
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
  const q = quoteOf(config);
  return [
    config.lockLiquidity
      ? { severity: 'info', text: `The liquidity is locked for good. Nobody, you included, can take the tokens or the ${q.symbol} back out of the pool. You can still claim its trading fees.` }
      : { severity: 'caution', text: 'The liquidity is not locked. You can remove it at any time, which would leave holders with no market.' },
    { severity: 'info', text: `Only your tokens go in. Nobody can buy below the starting price, and buyers pay ${q.symbol} that builds the other side of the pool.` },
    ...(q.mint === WSOL_MINT
      ? []
      : [
          {
            severity: 'caution' as const,
            text: `The other side of the pool is ${q.symbol === 'USDC' ? 'USDC' : `the token ${q.mint}`}, not SOL. ${q.mintable ? 'Someone holds the power to create more of it. ' : ''}${q.freezable ? 'Someone holds the power to freeze balances of it, which would affect buyers and sellers in this pool. ' : ''}Its price is set by its own market, and nothing here checks it.`,
          },
        ]),
    ...(config.launchProtection
      ? [
          {
            severity: 'info' as const,
            text: `Launch protection is on. For the first ${config.launchProtection.minutes} minutes the trading fee starts at ${config.launchProtection.startBps / 100}% and falls in a straight line to ${config.tradingFeeBps / 100}%. That makes sniping the first block expensive, but it also means the first buyers pay more: a trade at the very start costs ${config.launchProtection.startBps / 100}% in fees instead of ${config.tradingFeeBps / 100}%. Those fees are paid to you, the owner of the position. After the window the fee stays at ${config.tradingFeeBps / 100}%.`,
          },
        ]
      : [{ severity: 'caution' as const, text: `Launch protection is off. The fee is ${config.tradingFeeBps / 100}% from the first trade, so a bot that buys the moment the pool opens pays no extra.` }]),
    { severity: 'caution', text: 'The starting price is yours to choose and is not checked against any market. A price set far from what people will pay can leave the pool with no buyers.' },
    { severity: 'caution', text: 'This is on Solana mainnet. The transaction is real, the fees and deposits are paid in your SOL, and a pool cannot be deleted.' },
  ];
}
