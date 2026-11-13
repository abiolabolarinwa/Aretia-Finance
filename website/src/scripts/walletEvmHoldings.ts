/**
 * What an Ethereum-style account holds: the native coin, the well-known tokens (the router's wrapped coin and stablecoins) on
 * each network, and any other token the caller names (the ones this browser has swapped through Aretia, so a token just bought
 * shows up). Balances, names and decimals are read straight from public nodes. There is no index of every token an account owns
 * on these networks, so a token bought elsewhere and never named here is not found (it still shows in Swap).
 */
import { CHAINS, EVM_NATIVE_ADDRESS, type ChainId } from '../swings/core/types.js';
import { HUB_TOKENS } from '../swings/dex/hubs.js';
import { WRAPPED_NATIVE } from '../swings/dex/entries.js';
import { decodeAbiString, publicRead, readBalance, type EvmRead } from '../swings/chains/evmSession.js';
import { cleanText } from '../swings/tokens/safeText.js';
import { decodeAggregate3, encodeAggregate3, MULTICALL3 } from './walletHoldingsScan';
import { THIN_LIQUIDITY_USD } from './walletHoldings';

export interface EvmHolding {
  chain: ChainId;
  /** `${chain}:native` for the native coin, otherwise `${chain}:${contract}`. */
  mint: string;
  address: string;
  symbol: string;
  name: string;
  amount: number;
  /** The exact balance in the smallest unit (a decimal string). */
  raw: string;
  decimals: number;
  price: number | null;
  value: number | null;
  /** The only pool behind the price holds under $10,000, so the dollar value is only indicative and is not added to the total. */
  thin: boolean;
  /** Found from a list of named tokens (the scan, the outside list, the swap history), not one of the network's own coin and well-known tokens. */
  named: boolean;
}

export const isEvmNativeMint = (mint: string): boolean => mint.endsWith(':native');

/** DexScreener's name for each network; one it does not list is left unpriced rather than guessed. */
const DEX_SLUG: Partial<Record<ChainId, string>> = { ethereum: 'ethereum', bnb: 'bsc', polygon: 'polygon', base: 'base' };

export interface EvmTarget {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  native: boolean;
}

export function evmTargets(chains: readonly ChainId[]): EvmTarget[] {
  const out: EvmTarget[] = [];
  for (const chain of chains) {
    const info = CHAINS[chain];
    if (info.kind !== 'evm') continue;
    out.push({ chain, address: EVM_NATIVE_ADDRESS, symbol: info.nativeSymbol, name: info.name, decimals: info.nativeDecimals, native: true });
    for (const t of HUB_TOKENS[chain] ?? []) out.push({ chain, address: t.address.toLowerCase(), symbol: t.symbol, name: `${t.symbol} on ${info.name}`, decimals: t.decimals, native: false });
  }
  return out;
}

export function unitsToNumber(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

interface DexPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/** The deepest pool's price, and how much that pool holds in dollars, for each token address (lower-case). */
export function bestPools(pairs: readonly DexPair[]): Map<string, { price: number; liq: number }> {
  const best = new Map<string, { price: number; liq: number }>();
  for (const p of pairs) {
    const a = p.baseToken?.address?.toLowerCase();
    const price = Number(p.priceUsd);
    if (!a || !Number.isFinite(price) || price <= 0) continue;
    const liq = p.liquidity?.usd ?? 0;
    if (!best.has(a) || liq > (best.get(a)?.liq ?? 0)) best.set(a, { price, liq });
  }
  return best;
}

/** The deepest pool's price for each token address (lower-case). */
export function bestPrices(pairs: readonly DexPair[]): Map<string, number> {
  return new Map([...bestPools(pairs)].map(([a, v]) => [a, v.price]));
}

/** A token to look for besides the well-known ones: its network and contract address. */
export interface ExtraToken {
  chain: ChainId;
  address: string;
}

export interface EvmHoldingsDeps {
  read?: (chain: ChainId) => EvmRead;
  fetchPairs?: (slug: string, addresses: string[]) => Promise<DexPair[]>;
  /** Tokens the account is known to have dealt in, such as the ones it swapped through Aretia. */
  extra?: readonly ExtraToken[];
}

/** The tokens to look for besides the well-known ones: valid, on a network being read, not the native coin, each once. */
export function extraTargets(extra: readonly ExtraToken[], chains: readonly ChainId[], known: readonly EvmTarget[]): ExtraToken[] {
  const seen = new Set(known.map((t) => `${t.chain}:${t.address.toLowerCase()}`));
  const out: ExtraToken[] = [];
  for (const e of extra) {
    const address = e.address.toLowerCase();
    const key = `${e.chain}:${address}`;
    if (!chains.includes(e.chain) || CHAINS[e.chain].kind !== 'evm' || !/^0x[0-9a-f]{40}$/.test(address) || address === EVM_NATIVE_ADDRESS.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    out.push({ chain: e.chain, address });
  }
  return out;
}

/** A token's symbol, name and decimals, read from its contract. Null when it does not answer like an ERC-20. */
async function readFacts(read: EvmRead, address: string): Promise<{ symbol: string; name: string; decimals: number } | null> {
  try {
    const d = await read('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']);
    const decimals = typeof d === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(d) ? Number.parseInt(d, 16) : Number.NaN;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    const text = async (data: string): Promise<string> => {
      try {
        return decodeAbiString(await read('eth_call', [{ to: address, data }, 'latest'])) ?? '';
      } catch {
        return '';
      }
    };
    const [symbol, name] = [await text('0x95d89b41'), await text('0x06fdde03')];
    // Token text is untrusted: control and look-alike characters are removed before it is shown.
    return { symbol: cleanText(symbol, 20) || `${address.slice(0, 6)}\u2026`, name: cleanText(name, 60), decimals };
  } catch {
    return null;
  }
}

/** Networks where Multicall3 is deployed, so a batch of tokens can be read in one call. */
const MULTICALL_CHAINS: readonly ChainId[] = ['ethereum', 'bnb', 'polygon', 'base'];
/** Tokens per batch: four reads each, so 240 inside one call. */
const BATCH = 60;

type Held = { t: EvmTarget; raw: bigint; named?: boolean };

const toHeld = (e: ExtraToken, raw: bigint, f: { symbol: string; name: string; decimals: number }): Held => ({ t: { chain: e.chain, address: e.address, symbol: f.symbol, name: f.name || f.symbol, decimals: f.decimals, native: false }, raw, named: true });

/** One token, one read at a time: the way for a network without Multicall3, and for a batch the node would not answer. */
async function readOne(read: EvmRead, account: string, e: ExtraToken): Promise<Held | null> {
  const raw = await readBalance(read, account, e.address);
  if (raw <= 0n) return null;
  const facts = await readFacts(read, e.address);
  return facts ? toHeld(e, raw, facts) : null;
}

/** A batch of tokens in a single Multicall3 read: balance, decimals, symbol and name of each. Throws when the answer is not usable. */
async function readBatch(read: EvmRead, account: string, tokens: readonly ExtraToken[]): Promise<Held[]> {
  const holder = account.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const calls = tokens.flatMap((e) => ['70a08231' + holder, '313ce567', '95d89b41', '06fdde03'].map((data) => ({ target: e.address, data })));
  const out = decodeAggregate3(await read('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest']));
  if (!out || out.length !== calls.length) throw new Error('The batch was not answered.');
  const held: Held[] = [];
  tokens.forEach((e, i) => {
    const [bal, dec, sym, nam] = [out[i * 4]!, out[i * 4 + 1]!, out[i * 4 + 2]!, out[i * 4 + 3]!];
    if (!bal.ok || bal.data.length < 64) return;
    const raw = BigInt('0x' + bal.data.slice(0, 64));
    if (raw <= 0n) return;
    const places = dec.ok && dec.data.length >= 64 ? BigInt('0x' + dec.data.slice(0, 64)) : -1n;
    if (places < 0n || places > 36n) return;
    const decimals = Number(places);
    const symbol = sym.ok ? (decodeAbiString('0x' + sym.data) ?? '') : '';
    const name = nam.ok ? (decodeAbiString('0x' + nam.data) ?? '') : '';
    // Token text is untrusted: control and look-alike characters are removed before it is shown.
    held.push(toHeld(e, raw, { symbol: cleanText(symbol, 20) || `${e.address.slice(0, 6)}…`, name: cleanText(name, 60), decimals }));
  });
  return held;
}

/** The balances above zero among the named tokens, with their names and decimals. A token or batch that cannot be read is left out. */
async function readExtras(read: (chain: ChainId) => EvmRead, account: string, extras: readonly ExtraToken[]): Promise<Held[]> {
  const chains = [...new Set(extras.map((e) => e.chain))];
  const perChain = await Promise.allSettled(
    chains.map(async (chain) => {
      const mine = extras.filter((e) => e.chain === chain);
      const node = read(chain);
      const found: Held[] = [];
      for (let i = 0; i < mine.length; i += BATCH) {
        const part = mine.slice(i, i + BATCH);
        try {
          if (!MULTICALL_CHAINS.includes(chain)) throw new Error('No Multicall3 here.');
          found.push(...(await readBatch(node, account, part)));
        } catch {
          const each = await Promise.allSettled(part.map((e) => readOne(node, account, e)));
          for (const r of each) if (r.status === 'fulfilled' && r.value) found.push(r.value);
        }
      }
      return found;
    }),
  );
  return perChain.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/** The most token addresses the market feed answers for in one request. */
export const PRICE_GROUP = 30;

const defaultPairs = async (slug: string, addresses: string[]): Promise<DexPair[]> => {
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${addresses.join(',')}`);
  if (!res.ok) throw new Error(`DexScreener answered ${res.status}`);
  return (await res.json()) as DexPair[];
};

/** Balances above zero on each network, priced where a market feed has the token. A network that cannot be read is left out. */
export async function loadEvmHoldings(account: string, chains: readonly ChainId[], deps: EvmHoldingsDeps = {}): Promise<EvmHolding[]> {
  const read = deps.read ?? ((c: ChainId) => publicRead(c));
  const fetchPairs = deps.fetchPairs ?? defaultPairs;
  const targets = evmTargets(chains);
  const reads = await Promise.allSettled(
    targets.map(async (t) => {
      const raw = await readBalance(read(t.chain), account, t.address);
      return { t, raw };
    }),
  );
  const held: Held[] = reads.flatMap((r) => (r.status === 'fulfilled' && r.value.raw > 0n ? [r.value] : []));
  // Tokens named by the caller: their balances, and the name and decimals of the ones that are held.
  held.push(...(await readExtras(read, account, extraTargets(deps.extra ?? [], chains, targets))));
  const prices = new Map<string, { price: number; liq: number }>(); // `${chain}:${address}`
  await Promise.allSettled(
    [...new Set(held.map((h) => h.t.chain))].map(async (chain) => {
      const slug = DEX_SLUG[chain];
      if (!slug) return;
      const wanted = new Set<string>();
      for (const h of held) if (h.t.chain === chain) wanted.add(h.t.native ? WRAPPED_NATIVE[chain as keyof typeof WRAPPED_NATIVE].toLowerCase() : h.t.address);
      // The market feed takes at most 30 addresses in a request and ignores the rest, so a wallet with many tokens is priced 30 at a time.
      const list = [...wanted];
      const groups: string[][] = [];
      for (let i = 0; i < list.length; i += PRICE_GROUP) groups.push(list.slice(i, i + PRICE_GROUP));
      await Promise.allSettled(
        groups.map(async (group) => {
          for (const [a, p] of bestPools(await fetchPairs(slug, group))) prices.set(`${chain}:${a}`, p);
        }),
      );
    }),
  );
  return held
    .map(({ t, raw, named }): EvmHolding => {
      const key = t.native ? WRAPPED_NATIVE[t.chain as keyof typeof WRAPPED_NATIVE].toLowerCase() : t.address;
      const found = prices.get(`${t.chain}:${key}`) ?? null;
      const price = found?.price ?? null;
      const amount = unitsToNumber(raw, t.decimals);
      return { chain: t.chain, mint: t.native ? `${t.chain}:native` : `${t.chain}:${t.address}`, address: t.address, symbol: t.symbol, name: t.name, amount, raw: raw.toString(), decimals: t.decimals, price, value: price === null ? null : amount * price, thin: found !== null && found.liq < THIN_LIQUIDITY_USD, named: named === true };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount);
}
