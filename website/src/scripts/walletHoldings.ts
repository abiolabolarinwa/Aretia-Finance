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
  nativeMint: string,
  showUnpriced: boolean,
): { shown: T[]; hiddenUnpriced: T[] } {
  if (showUnpriced || !holdings.some((h) => h.value !== null)) return { shown: [...holdings], hiddenUnpriced: [] };
  const shown: T[] = [];
  const hiddenUnpriced: T[] = [];
  for (const h of holdings) (h.value !== null || h.mint === nativeMint ? shown : hiddenUnpriced).push(h);
  return { shown, hiddenUnpriced };
}
