/**
 * What one whole native coin (wrapped) is worth in dollars, read from the chain itself: the reserves of the factory's
 * wrapped-native / dollar-stablecoin pool (V2) or its price slot (V3). No external price feed is involved. Used only to put a
 * dollar figure on pools quoted in the native coin; when no such pool answers, the figure is null and the API says so.
 */
import type { MiChainConfig } from './chains.js';
import { allSpecs } from './dexes.js';
import { readAddress, readSqrtPrice, readV2Reserves, v3PriceScaled } from './evmReads.js';
import { PRICE_SCALE } from './math.js';
import type { Read } from './rpc.js';

const pad = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const FEE_TIERS = [500, 3000, 2500, 10000, 100];

export function nativeUsdReader(chain: MiChainConfig, read: Read, now: () => number, ttlMs = 60_000): () => Promise<number | null> {
  let cached: { at: number; value: number | null } | null = null;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    let value: number | null;
    try {
      value = await compute(chain, read);
    } catch {
      value = cached?.value ?? null;
    }
    cached = { at: now(), value };
    return value;
  };
}

async function compute(chain: MiChainConfig, read: Read): Promise<number | null> {
  const native = chain.quoteTokens.find((q) => q.role === 'native');
  const usd = chain.quoteTokens.find((q) => q.role === 'usd');
  if (!native || !usd) return null;
  const sorted = [native.address, usd.address].sort();
  const nativeIs0 = sorted[0] === native.address;
  for (const spec of allSpecs().filter((s) => s.chain === chain.id)) {
    if (spec.kind === 'v2') {
      const pair = await readAddress(read, spec.factory, '0xe6a43905' + pad(native.address) + pad(usd.address));
      if (!pair) continue;
      const r = await readV2Reserves(read, pair);
      if (!r || r[0] <= 0n || r[1] <= 0n) continue;
      const nativeRaw = nativeIs0 ? r[0] : r[1];
      const usdRaw = nativeIs0 ? r[1] : r[0];
      // A reference pool must be deep enough to mean something: at least $10,000 on the dollar side.
      if (usdRaw < 10_000n * 10n ** BigInt(usd.decimals)) continue;
      return (Number(usdRaw) / 10 ** usd.decimals) / (Number(nativeRaw) / 10 ** native.decimals);
    }
    for (const fee of FEE_TIERS) {
      const pool = await readAddress(read, spec.factory, '0x1698ee82' + pad(native.address) + pad(usd.address) + fee.toString(16).padStart(64, '0'));
      if (!pool) continue;
      const sqrt = await readSqrtPrice(read, pool);
      if (sqrt === null) continue;
      // Price of token0 in token1; flip when the native coin is token1.
      const dec0 = nativeIs0 ? native.decimals : usd.decimals;
      const dec1 = nativeIs0 ? usd.decimals : native.decimals;
      const p = v3PriceScaled(sqrt, dec0, dec1);
      if (p === null || p <= 0n) continue;
      const asNumber = Number(p) / 10 ** PRICE_SCALE;
      const price = nativeIs0 ? asNumber : 1 / asNumber;
      if (Number.isFinite(price) && price > 0) return price;
    }
  }
  return null;
}
