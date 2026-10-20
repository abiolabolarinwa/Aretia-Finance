/**
 * Pure helpers behind the dashboard's holdings: reading token accounts straight from the chain, merging that with
 * Jupiter's balance list, and deciding which holdings the table shows. No network and no DOM, so they can be tested.
 */

/** A balance for one mint before names and prices are looked up. */
export interface RawBalance {
  mint: string;
  /** Human amount (`uiAmount`). */
  amount: number;
  /** Exact balance in the smallest unit, when known. */
  raw: string | null;
  /** Decimal places, when known. */
  decimals: number | null;
}

/** The two programs that own token accounts: the original SPL Token program and Token-2022. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

interface ParsedTokenAccount {
  account?: { data?: { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown; uiAmountString?: unknown } } } } };
}

/**
 * Reads the `jsonParsed` answer of `getTokenAccountsByOwner` into one balance per mint. A wallet can hold several
 * token accounts for the same mint, so those are added together. Empty accounts and anything that is not a clean
 * number are left out.
 */
export function parseTokenAccountsResult(result: unknown): RawBalance[] {
  const accounts = (result as { value?: unknown } | null)?.value;
  if (!Array.isArray(accounts)) return [];
  const byMint = new Map<string, { raw: bigint; decimals: number; ui: number }>();
  for (const entry of accounts as ParsedTokenAccount[]) {
    const info = entry?.account?.data?.parsed?.info;
    const amount = info?.tokenAmount;
    if (typeof info?.mint !== 'string' || typeof amount?.amount !== 'string' || !/^\d+$/.test(amount.amount)) continue;
    if (typeof amount.decimals !== 'number') continue;
    const raw = BigInt(amount.amount);
    if (raw === 0n) continue;
    const ui = Number(typeof amount.uiAmountString === 'string' ? amount.uiAmountString : raw) ;
    if (!Number.isFinite(ui)) continue;
    const seen = byMint.get(info.mint);
    byMint.set(info.mint, { raw: (seen?.raw ?? 0n) + raw, decimals: amount.decimals, ui: (seen?.ui ?? 0) + ui });
  }
  return [...byMint].map(([mint, v]) => ({ mint, amount: v.ui, raw: v.raw.toString(), decimals: v.decimals }));
}

/** A SOL balance in lamports as a balance for the native mint. */
export function lamportsToBalance(nativeMint: string, lamports: unknown): RawBalance | null {
  if (typeof lamports !== 'number' || !Number.isFinite(lamports) || lamports <= 0) return null;
  return { mint: nativeMint, amount: lamports / 1_000_000_000, raw: String(lamports), decimals: 9 };
}

/**
 * Combines Jupiter's list with what was read from the chain, one entry per mint. A mint only one source knows is
 * kept as it is. When both know it, the larger amount wins: the chain read also counts token accounts that are not
 * the standard one, which Jupiter's list can leave out, and a source that is briefly behind never shrinks a balance.
 * Order: Jupiter's entries first (they are already in its order), then the ones only the chain knew.
 */
export function mergeBalances(jupiter: readonly RawBalance[], onChain: readonly RawBalance[]): RawBalance[] {
  const merged = new Map<string, RawBalance>();
  for (const b of jupiter) merged.set(b.mint, b);
  for (const b of onChain) {
    const existing = merged.get(b.mint);
    if (!existing) merged.set(b.mint, b);
    else if (b.amount > existing.amount) merged.set(b.mint, { ...b, decimals: b.decimals ?? existing.decimals });
    else if (existing.decimals === null && b.decimals !== null) merged.set(b.mint, { ...existing, decimals: b.decimals });
  }
  return [...merged.values()];
}

/**
 * Which holdings the table shows. Tokens with no price are usually airdropped spam or things nobody trades, so by
 * default they sit behind a toggle. Two exceptions keep the table from lying: the native coin is always shown, and if
 * nothing at all has a price (the price feeds are down) nothing is hidden, since "unpriced" would then mean "unknown".
 */
export function splitByPrice<T extends { mint: string; value: number | null }>(
  holdings: readonly T[],
  nativeMint: string | ((mint: string) => boolean),
  showUnpriced: boolean,
): { shown: T[]; hiddenUnpriced: T[] } {
  if (showUnpriced || !holdings.some((h) => h.value !== null)) return { shown: [...holdings], hiddenUnpriced: [] };
  const shown: T[] = [];
  const hiddenUnpriced: T[] = [];
  for (const h of holdings) (h.value !== null || (typeof nativeMint === 'string' ? h.mint === nativeMint : nativeMint(h.mint)) ? shown : hiddenUnpriced).push(h);
  return { shown, hiddenUnpriced };
}

// ---------------------------------------------------------------- prices from market feeds

/** Below this much money in the pool behind a price, the holding is not given a value at all: a dust pool can claim any price. */
export const MIN_PRICE_LIQUIDITY_USD = 1_000;
/** Below this, a price is shown but marked thin. */
export const THIN_LIQUIDITY_USD = 10_000;

export interface FeedPrice {
  price: number;
  thin: boolean;
}

/** A price with the liquidity behind it (null when the feed gives none): dropped under the floor, marked thin when shallow or unknown. */
export function priceWithLiquidity(price: number, liquidityUsd: number | null, quoteIsMajor = true): FeedPrice | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (liquidityUsd !== null && !(liquidityUsd >= MIN_PRICE_LIQUIDITY_USD)) return null;
  return { price, thin: liquidityUsd === null || liquidityUsd < THIN_LIQUIDITY_USD || !quoteIsMajor };
}

export interface DexPricePair {
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/**
 * Each mint's price from DexScreener's pairs: the pool paired with a major token (`majors`, lower-case) comes first, then depth, so a
 * pool against a made-up token that reports a huge liquidity cannot set the price. A price from a pool against an unknown token is
 * always marked thin.
 */
export function dexScreenerPrices(pairs: readonly DexPricePair[], majors: ReadonlySet<string>): Map<string, FeedPrice> {
  const best = new Map<string, { p: DexPricePair; major: boolean; liq: number }>();
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    if (!mint || !p.priceUsd) continue;
    const major = majors.has((p.quoteToken?.address ?? '').toLowerCase());
    const liq = typeof p.liquidity?.usd === 'number' && Number.isFinite(p.liquidity.usd) ? p.liquidity.usd : 0;
    const prev = best.get(mint);
    if (prev && ((prev.major && !major) || (prev.major === major && liq <= prev.liq))) continue;
    best.set(mint, { p, major, liq });
  }
  const out = new Map<string, FeedPrice>();
  for (const [mint, { p, major, liq }] of best) {
    const priced = priceWithLiquidity(Number(p.priceUsd), liq, major);
    if (priced) out.set(mint, priced);
  }
  return out;
}
