import { browserStorage, type StorageLike } from '../swings/history.js';
import { classify, parseCandles, parseSolanaTx, priceAt, priceOf, SOL_MINT, type Candle, type Classified, type ParsedTx, type Price, type RawTx } from '../swings/account/trades.js';
import { rpcCall } from './walletSend';
import { KNOWN_TOKENS } from './walletTools';

/**
 * The Activity page's buys and sells for the connected Solana wallet, read from the chain.
 *
 * What goes where: the wallet address goes to the Solana RPC (through Aretia's proxy) to read its own transactions, token names
 * come from Jupiter's public list, and SOL's dollar price at the time of a trade comes from GeckoTerminal's hourly candles for the
 * main SOL/USDC pool. Nothing is sent to Aretia's servers except the RPC proxy, which only forwards the read.
 * A transaction on the chain never changes once it is final, so what was read is kept in this browser and not asked for again.
 */

export interface Leg {
  mint: string;
  symbol: string;
  amount: number;
}
export interface TradeRow {
  signature: string;
  time: number | null;
  ok: boolean;
  /** False when the node could not give this transaction, so only its time and status are known. */
  read: boolean;
  kind: Classified['kind'];
  token: Leg | null;
  quote: Leg | null;
  price: Price;
  /** Everything gained and spent, for a transaction that is not a plain buy or sell. */
  gained: Leg[];
  spent: Leg[];
}

interface SignatureInfo {
  signature: string;
  time: number | null;
  ok: boolean;
}

const KEY = 'aretia-trades-v1';
const KEEP = 200;
/** The deepest pool for SOL against USDC; its hourly candles are SOL's dollar price over the last 41 days. */
const SOL_USDC_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const HOUR = 3600;

type Cache = Record<string, Record<string, ParsedTx>>;

function readCache(storage: StorageLike | null): Cache {
  try {
    const raw = storage?.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Cache) : {};
  } catch {
    return {};
  }
}
function writeCache(storage: StorageLike | null, cache: Cache, wallet: string): void {
  try {
    const mine = Object.values(cache[wallet] ?? {}).sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, KEEP);
    cache[wallet] = Object.fromEntries(mine.map((p) => [p.signature, p]));
    storage?.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Not kept: the next visit reads them again.
  }
}

/** Runs `work` over the items, a few at a time, so a wallet with many transactions does not flood the node. */
async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

const symbolsSeen = new Map<string, string>(KNOWN_TOKENS.map((k) => [k.mint, k.symbol]));

async function symbolsFor(mints: readonly string[]): Promise<Map<string, string>> {
  const need = mints.filter((m) => !symbolsSeen.has(m)).slice(0, 100);
  if (need.length > 0) {
    try {
      const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${need.join(',')}`);
      if (res.ok) {
        for (const t of (await res.json()) as { id?: string; symbol?: string }[]) {
          if (t.id && typeof t.symbol === 'string' && need.includes(t.id)) symbolsSeen.set(t.id, t.symbol.slice(0, 20));
        }
      }
    } catch {
      // A name is decoration: the short address shows instead.
    }
  }
  return symbolsSeen;
}

/** Hourly SOL/USD candles that reach back from just after `newest`. Empty when the lookup fails; the dollar figure is then left out, not guessed. */
async function solCandles(newest: number): Promise<Candle[]> {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${SOL_USDC_POOL}/ohlcv/hour?limit=1000&currency=usd&before_timestamp=${newest + HOUR}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
    return parseCandles(body.data?.attributes?.ohlcv_list);
  } catch {
    return [];
  }
}

const short = (mint: string): string => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

/** Reads the transactions' buys and sells for `wallet`. `items` is the wallet's recent signatures, newest first. */
export async function loadTrades(wallet: string, items: readonly SignatureInfo[], storage: StorageLike | null = browserStorage()): Promise<TradeRow[]> {
  const cache = readCache(storage);
  const have = cache[wallet] ?? (cache[wallet] = {});
  const parsed = new Map<string, ParsedTx>();
  const todo: SignatureInfo[] = [];
  for (const it of items) {
    if (!it.ok) parsed.set(it.signature, { signature: it.signature, time: it.time, ok: false, gained: [], spent: [] });
    else if (have[it.signature]) parsed.set(it.signature, have[it.signature]!);
    else todo.push(it);
  }
  let fetched = 0;
  await pool(todo, 3, async (it) => {
    // A public node sometimes refuses a read while the page is busy; one more try after a pause is usually enough.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tx = await rpcCall<RawTx | null>('getTransaction', [it.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
        const p = parseSolanaTx(it.signature, tx, wallet);
        if (p) {
          parsed.set(it.signature, p);
          have[it.signature] = p;
          fetched++;
          return;
        }
      } catch {
        // try again below
      }
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
    // This one stays as a plain row; the rest still show.
  });
  if (fetched > 0) writeCache(storage, cache, wallet);

  const mints = new Set<string>();
  for (const p of parsed.values()) for (const a of [...p.gained, ...p.spent]) mints.add(a.mint);
  const symbols = await symbolsFor([...mints]);
  const sym = (mint: string): string => (mint === SOL_MINT ? 'SOL' : (symbols.get(mint) ?? short(mint)));
  const leg = (a: { mint: string; amount: number }): Leg => ({ mint: a.mint, symbol: sym(a.mint), amount: a.amount });

  // SOL's dollar price is only needed for a trade paid in or settled in SOL.
  const classified = items.map((it) => {
    const p = parsed.get(it.signature);
    return { it, p, c: p ? classify(p.gained, p.spent) : null };
  });
  const solTimes = classified.filter((x) => x.p?.time && x.c && x.c.quote?.mint === SOL_MINT && (x.c.kind === 'bought' || x.c.kind === 'sold')).map((x) => x.p!.time!);
  const candles = solTimes.length > 0 ? await solCandles(Math.max(...solTimes)) : [];

  return classified.map(({ it, p, c }): TradeRow => {
    if (!p || !c) return { signature: it.signature, time: it.time, ok: it.ok, read: false, kind: 'other', token: null, quote: null, price: { usd: null, inQuote: null, valueUsd: null }, gained: [], spent: [] };
    const time = p.time ?? it.time;
    return {
      signature: it.signature,
      time,
      ok: p.ok,
      read: true,
      kind: p.ok ? c.kind : 'other',
      token: c.token ? leg(c.token) : null,
      quote: c.quote ? leg(c.quote) : null,
      price: priceOf(c, time ? priceAt(candles, time) : null),
      gained: p.gained.map(leg),
      spent: p.spent.map(leg),
    };
  });
}
