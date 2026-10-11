/**
 * What an Ethereum-style account holds: the native coin and the well-known tokens (the router's wrapped coin and
 * stablecoins) on each network. Balances are read straight from public nodes. There is no index of every token an
 * account owns on these networks, so a token outside that list is not found here (it still shows in Swap).
 */
import { CHAINS, EVM_NATIVE_ADDRESS, type ChainId } from '../swings/core/types.js';
import { HUB_TOKENS } from '../swings/dex/hubs.js';
import { WRAPPED_NATIVE } from '../swings/dex/entries.js';
import { publicRead, readBalance, type EvmRead } from '../swings/chains/evmSession.js';

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
}

export const isEvmNativeMint = (mint: string): boolean => mint.endsWith(':native');

/** DexScreener's name for each network; one it does not list is left unpriced rather than guessed. */
const DEX_SLUG: Partial<Record<ChainId, string>> = { ethereum: 'ethereum', bnb: 'bsc', polygon: 'polygon', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', avalanche: 'avalanche' };

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

/** The deepest pool's price for each token address (lower-case). */
export function bestPrices(pairs: readonly DexPair[]): Map<string, number> {
  const best = new Map<string, { price: number; liq: number }>();
  for (const p of pairs) {
    const a = p.baseToken?.address?.toLowerCase();
    const price = Number(p.priceUsd);
    if (!a || !Number.isFinite(price) || price <= 0) continue;
    const liq = p.liquidity?.usd ?? 0;
    if (!best.has(a) || liq > (best.get(a)?.liq ?? 0)) best.set(a, { price, liq });
  }
  return new Map([...best].map(([a, v]) => [a, v.price]));
}

export interface EvmHoldingsDeps {
  read?: (chain: ChainId) => EvmRead;
  fetchPairs?: (slug: string, addresses: string[]) => Promise<DexPair[]>;
}

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
  const held = reads.flatMap((r) => (r.status === 'fulfilled' && r.value.raw > 0n ? [r.value] : []));
  const prices = new Map<string, number>(); // `${chain}:${address}`
  await Promise.allSettled(
    [...new Set(held.map((h) => h.t.chain))].map(async (chain) => {
      const slug = DEX_SLUG[chain];
      if (!slug) return;
      const wanted = new Set<string>();
      for (const h of held) if (h.t.chain === chain) wanted.add(h.t.native ? WRAPPED_NATIVE[chain as keyof typeof WRAPPED_NATIVE].toLowerCase() : h.t.address);
      const found = bestPrices(await fetchPairs(slug, [...wanted]));
      for (const [a, p] of found) prices.set(`${chain}:${a}`, p);
    }),
  );
  return held
    .map(({ t, raw }): EvmHolding => {
      const key = t.native ? WRAPPED_NATIVE[t.chain as keyof typeof WRAPPED_NATIVE].toLowerCase() : t.address;
      const price = prices.get(`${t.chain}:${key}`) ?? null;
      const amount = unitsToNumber(raw, t.decimals);
      return { chain: t.chain, mint: t.native ? `${t.chain}:native` : `${t.chain}:${t.address}`, address: t.address, symbol: t.symbol, name: t.name, amount, raw: raw.toString(), decimals: t.decimals, price, value: price === null ? null : amount * price };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.amount - a.amount);
}
