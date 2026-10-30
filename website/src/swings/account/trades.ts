/**
 * Reads what a wallet bought and sold from the chain.
 *
 * A Solana transaction records, for every account it touched, the balance before and after. Subtracting the two for the
 * connected wallet gives what it gained and what it spent, whatever program (Jupiter, Raydium, Orca...) moved it. Those two
 * sides are the trade: what the wallet spent is what it paid, what it gained is what it got, and the price is one divided by
 * the other. Nothing here is a guess about a market: the price is the one this wallet actually got.
 *
 * Pure functions only (no network, no storage), so they are tested against real transaction shapes.
 */

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Dollar stablecoins on Solana. A leg in one of these is already a dollar amount. */
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]);
export const isStableMint = (mint: string): boolean => STABLE_MINTS.has(mint);

export interface Amount {
  mint: string;
  /** Always positive: the direction is which list it is in. */
  amount: number;
}

export interface ParsedTx {
  signature: string;
  /** Unix seconds. */
  time: number | null;
  ok: boolean;
  /** What the wallet gained and what it spent in this transaction (SOL already net of the network fee and account deposits). */
  gained: Amount[];
  spent: Amount[];
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { uiAmountString?: string; uiAmount?: number | null };
}
/** The part of `getTransaction` (jsonParsed) that is read here. */
export interface RawTx {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: { message?: { accountKeys?: (string | { pubkey?: string })[] } };
}

/** Below this much SOL a change is the network's own noise (a tip, a rounding), not part of a trade. */
const SOL_DUST = 0.001;

const num = (b: TokenBalance | undefined): number => {
  const s = b?.uiTokenAmount?.uiAmountString;
  const n = s !== undefined ? Number(s) : Number(b?.uiTokenAmount?.uiAmount ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What the wallet gained and spent in one transaction, or null when there is nothing to read (the node did not have it).
 * Native SOL and wrapped SOL are one asset here: a swap through Jupiter wraps and unwraps SOL, and that must not look like a trade.
 */
export function parseSolanaTx(signature: string, tx: RawTx | null, wallet: string): ParsedTx | null {
  if (!tx || !tx.meta) return null;
  const m = tx.meta;
  const ok = m.err === null || m.err === undefined;
  const base: ParsedTx = { signature, time: tx.blockTime ?? null, ok, gained: [], spent: [] };
  if (!ok) return base;

  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : (k.pubkey ?? '')));
  const idx = keys.indexOf(wallet);
  const pre = m.preBalances ?? [];
  const post = m.postBalances ?? [];

  const mine = (list: TokenBalance[] | undefined) => (list ?? []).filter((b) => b.owner === wallet);
  const preTok = mine(m.preTokenBalances);
  const postTok = mine(m.postTokenBalances);

  const delta = new Map<string, number>();
  const add = (mint: string, n: number) => delta.set(mint, (delta.get(mint) ?? 0) + n);
  for (const b of postTok) add(b.mint, num(b));
  for (const b of preTok) add(b.mint, -num(b));

  // Native SOL: the balance change, with the network fee put back if this wallet paid it, and the deposits for token accounts
  // opened (or returned for ones closed) taken out, because those are not part of the price.
  let sol = idx >= 0 ? ((post[idx] ?? 0) - (pre[idx] ?? 0)) / 1e9 : 0;
  if (idx === 0) sol += (m.fee ?? 0) / 1e9;
  const preIdx = new Set(preTok.map((b) => b.accountIndex));
  const postIdx = new Set(postTok.map((b) => b.accountIndex));
  for (const b of postTok) {
    if (preIdx.has(b.accountIndex)) continue;
    const deposit = (post[b.accountIndex] ?? 0) / 1e9 - (b.mint === SOL_MINT ? num(b) : 0);
    sol += deposit;
  }
  for (const b of preTok) {
    if (postIdx.has(b.accountIndex)) continue;
    const deposit = (pre[b.accountIndex] ?? 0) / 1e9 - (b.mint === SOL_MINT ? num(b) : 0);
    sol -= deposit;
  }
  add(SOL_MINT, sol);

  const legs: Amount[] = [];
  for (const [mint, d] of delta) {
    // A token's own decimals bound what is real; float noise from subtracting two balances is not a change.
    if (Math.abs(d) < (mint === SOL_MINT ? 1e-6 : 1e-9)) continue;
    legs.push({ mint, amount: d });
  }
  // When the tokens already make a trade (two or more legs besides SOL), a small SOL change is a tip or fee, not a leg.
  const others = legs.filter((l) => l.mint !== SOL_MINT);
  const kept = others.length >= 2 ? legs.filter((l) => l.mint !== SOL_MINT || Math.abs(l.amount) >= SOL_DUST) : legs;
  return {
    ...base,
    gained: kept.filter((l) => l.amount > 0).map((l) => ({ mint: l.mint, amount: l.amount })),
    spent: kept.filter((l) => l.amount < 0).map((l) => ({ mint: l.mint, amount: -l.amount })),
  };
}

export type TradeKind = 'bought' | 'sold' | 'swapped' | 'received' | 'sent' | 'other';

export interface Classified {
  kind: TradeKind;
  /** The asset that was bought or sold (or, for a plain transfer, the one that moved). */
  token: Amount | null;
  /** What it was paid for with, or what was got for it. */
  quote: Amount | null;
}

/**
 * Says what the two sides of a transaction were. Only a clean two-sided swap is a buy or a sell: the stablecoin side is the
 * money, and where there is none, SOL is. Anything with more or fewer legs is shown as what it is, not forced into a trade.
 */
export function classify(gained: readonly Amount[], spent: readonly Amount[]): Classified {
  if (gained.length === 1 && spent.length === 1) {
    const g = gained[0]!;
    const s = spent[0]!;
    const sStable = isStableMint(s.mint);
    const gStable = isStableMint(g.mint);
    if (sStable && !gStable) return { kind: 'bought', token: g, quote: s };
    if (gStable && !sStable) return { kind: 'sold', token: s, quote: g };
    if (!sStable && !gStable && s.mint === SOL_MINT && g.mint !== SOL_MINT) return { kind: 'bought', token: g, quote: s };
    if (!sStable && !gStable && g.mint === SOL_MINT && s.mint !== SOL_MINT) return { kind: 'sold', token: s, quote: g };
    return { kind: 'swapped', token: s, quote: g };
  }
  if (gained.length >= 1 && spent.length === 0) return { kind: 'received', token: gained[0]!, quote: null };
  if (spent.length >= 1 && gained.length === 0) return { kind: 'sent', token: spent[0]!, quote: null };
  return { kind: 'other', token: null, quote: null };
}

export interface Price {
  /** What one token cost or fetched, in dollars; null when no dollar figure can be stated. */
  usd: number | null;
  /** The same, in the asset it was paid in (SOL, USDC...). */
  inQuote: number | null;
  /** What the whole trade was worth in dollars. */
  valueUsd: number | null;
}

/** The price of one token in a trade, from the two amounts. `solUsd` is SOL's dollar price at the time of the trade, when known. */
export function priceOf(c: Classified, solUsd: number | null): Price {
  const none: Price = { usd: null, inQuote: null, valueUsd: null };
  if (!c.token || !c.quote || (c.kind !== 'bought' && c.kind !== 'sold') || !(c.token.amount > 0)) return none;
  const inQuote = c.quote.amount / c.token.amount;
  if (isStableMint(c.quote.mint)) return { usd: inQuote, inQuote, valueUsd: c.quote.amount };
  if (c.quote.mint === SOL_MINT && solUsd !== null && solUsd > 0) return { usd: inQuote * solUsd, inQuote, valueUsd: c.quote.amount * solUsd };
  return { usd: null, inQuote, valueUsd: null };
}

export interface Candle {
  /** Start of the hour, Unix seconds. */
  t: number;
  open: number;
  close: number;
}

/** GeckoTerminal's `ohlcv_list` ([time, open, high, low, close, volume] rows), oldest first. Rows that are not numbers are dropped. */
export function parseCandles(list: unknown): Candle[] {
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row)) continue;
    const [t, open, , , close] = row.map(Number);
    if (Number.isFinite(t) && Number.isFinite(open) && Number.isFinite(close) && open! > 0 && close! > 0) out.push({ t: t!, open: open!, close: close! });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** SOL's dollar price at a moment, from hourly candles: the price moves from the candle's open to its close, and the moment sits on that line. Null outside the candles. */
export function priceAt(candles: readonly Candle[], time: number, hour = 3600): number | null {
  for (const c of candles) {
    if (time >= c.t && time < c.t + hour) return c.open + ((c.close - c.open) * (time - c.t)) / hour;
  }
  return null;
}

const STABLE_SYMBOLS = new Set(['USDC', 'USDC.E', 'USDT', 'USDT0', 'DAI', 'USDS', 'PYUSD', 'USD1', 'FDUSD', 'BUSD', 'USDE']);
const COIN_SYMBOLS = new Set(['SOL', 'ETH', 'BNB', 'POL', 'WETH', 'WBNB', 'WSOL', 'WPOL']);

export interface SwapSummary {
  kind: 'bought' | 'sold' | 'swapped';
  token: { symbol: string; amount: number };
  quote: { symbol: string; amount: number };
  /** Dollars per token, only when the other side was a dollar stablecoin. */
  priceUsd: number | null;
  /** Per token, in the other asset. */
  priceInQuote: number | null;
}

/**
 * The same buy-or-sell reading for a swap this browser made (known by symbol, on any network): a stablecoin side is the money, and
 * failing that the network's own coin is. `amountOut` is what was expected at the time, so the price is the one that was quoted.
 */
export function summariseSwap(fromSymbol: string, toSymbol: string, amountIn: number, amountOut: number): SwapSummary | null {
  if (!(amountIn > 0) || !(amountOut > 0)) return null;
  const from = fromSymbol.toUpperCase();
  const to = toSymbol.toUpperCase();
  const rank = (s: string): number => (STABLE_SYMBOLS.has(s) ? 2 : COIN_SYMBOLS.has(s) ? 1 : 0);
  const spent = { symbol: fromSymbol, amount: amountIn };
  const got = { symbol: toSymbol, amount: amountOut };
  if (rank(from) === rank(to)) return { kind: 'swapped', token: spent, quote: got, priceUsd: null, priceInQuote: null };
  const [kind, token, quote] = rank(from) > rank(to) ? (['bought', got, spent] as const) : (['sold', spent, got] as const);
  const perToken = quote.amount / token.amount;
  return { kind, token, quote, priceUsd: rank(quote.symbol.toUpperCase()) === 2 ? perToken : null, priceInQuote: perToken };
}
