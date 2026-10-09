/** Live, read-only: the Marketplace lists on the real GeckoTerminal, and Find Tokens' numbers on the real DexScreener. */
import { describe, expect, it } from 'vitest';
import { GeckoMarket } from './gecko.js';
import { rowsFromRecords } from './registryRows.js';
import type { TokenRecord } from '../core/types.js';

describe('market data, live', () => {
  it('Trending, Top and New pairs return real rows with prices, volume and changes', async () => {
    const m = new GeckoMarket();
    const lines: string[] = [];
    for (const [kind, chain] of [['trending', ''], ['top', 'solana'], ['new', 'base'], ['gainers', 'ethereum']] as const) {
      const rows = await m.load({ kind, chain, window: 'h24' });
      lines.push(`${kind}/${chain || 'all'}: ${rows.length} rows; first ${rows[0]?.symbol}/${rows[0]?.quoteSymbol} price ${rows[0]?.priceUsd} vol ${rows[0]?.volume24hUsd} h24 ${rows[0]?.change.h24} cap ${rows[0]?.capUsd}`);
      expect(rows.length, kind).toBeGreaterThan(0);
      expect(rows.every((r) => r.symbol && r.address && r.pool)).toBe(true);
    }
    console.log(lines.join('\n'));
  }, 90_000);

  it('adds real market numbers to a registry token', async () => {
    const act = { ref: { chain: 'solana', address: '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG' }, symbol: 'ACT', name: 'Aretia', decimals: 6, logo: null, firstDetectedAt: Date.now() - 1e9, discoverySource: 't', createdAt: null, firstPoolAt: null, discoveryStatus: 'tradable', liquidityUsd: null, volume24hUsd: null, holderCount: null, pools: [], metadata: {}, verified: true, metadataConfidence: 'onchain', risk: null, updatedAt: Date.now() } as unknown as TokenRecord;
    const [row] = await rowsFromRecords([act]);
    console.log('ACT row', JSON.stringify({ price: row!.priceUsd, cap: row!.capUsd, txns: row!.txns24h, vol: row!.volume24hUsd, liq: row!.liquidityUsd, change: row!.change, quote: row!.quoteSymbol }));
    expect(row!.priceUsd).not.toBeNull();
  }, 60_000);
});
