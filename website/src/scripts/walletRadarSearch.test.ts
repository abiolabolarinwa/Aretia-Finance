import { describe, expect, it } from 'vitest';
import { GECKO_NETWORK } from '../swings/charts/pool.js';
import type { ChainId } from '../swings/core/types.js';
import { searchTokens } from '../swings/tokens/globalSearch.js';
import { RADAR_CHAINS, assetIdOf, classifyInput, searchForRadar, sharedSymbols } from './walletRadar';

const EVM = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';

describe('classifyInput', () => {
  it('reads a token address, whatever its chain, as an address', () => {
    expect(classifyInput(` ${PEPE} `, 'base')).toEqual({ kind: 'address', assetId: `base:${PEPE.toLowerCase()}` });
    expect(classifyInput(SOL, 'ethereum')).toEqual({ kind: 'address', assetId: `solana:${SOL}` });
  });
  it('reads anything else of a sensible length as a name or symbol to search for', () => {
    expect(classifyInput('pepe', 'ethereum')).toEqual({ kind: 'name', query: 'pepe' });
    expect(classifyInput('  Wrapped Ether ', 'ethereum')).toEqual({ kind: 'name', query: 'Wrapped Ether' });
    expect(classifyInput('$WIF', 'ethereum')).toEqual({ kind: 'name', query: '$WIF' });
  });
  it('asks for more when there is too little, and does not search a half-pasted EVM address as a name', () => {
    expect(classifyInput('', 'ethereum').kind).toBe('invalid');
    expect(classifyInput('a', 'ethereum').kind).toBe('invalid');
    const cut = classifyInput(PEPE.slice(0, 30), 'ethereum');
    expect(cut.kind).toBe('invalid');
    expect(cut.kind === 'invalid' && cut.message).toMatch(/copied all of it/);
    expect(classifyInput('x'.repeat(81), 'ethereum').kind).toBe('invalid');
  });
});

describe('assetIdOf', () => {
  it('lower-cases an EVM address and leaves a Solana mint as it is', () => {
    expect(assetIdOf('ethereum', PEPE)).toBe(`ethereum:${PEPE.toLowerCase()}`);
    expect(assetIdOf('solana', SOL)).toBe(`solana:${SOL}`);
  });
});

describe('sharedSymbols', () => {
  it('counts distinct tokens that carry the same symbol, ignoring case, and lists nothing for a symbol used once', () => {
    const hits = [
      { chain: 'ethereum' as ChainId, address: EVM(1), symbol: 'PEPE' },
      { chain: 'ethereum' as ChainId, address: EVM(2), symbol: 'pepe' },
      { chain: 'base' as ChainId, address: EVM(1), symbol: 'PEPE' },
      { chain: 'solana' as ChainId, address: SOL, symbol: 'WIF' },
    ];
    expect([...sharedSymbols(hits)]).toEqual([['PEPE', 3]]);
  });
  it('does not count the same token twice', () => {
    expect(sharedSymbols([{ chain: 'ethereum', address: EVM(1), symbol: 'A' }, { chain: 'ethereum', address: EVM(1).toUpperCase().replace('0X', '0x'), symbol: 'A' }]).size).toBe(0);
  });
});

// A GeckoTerminal-shaped answer, and a stand-in fetch that serves it (and an empty registry).
function gecko(rows: { chain: ChainId; address: string; symbol: string; name?: string; liq: number }[]): unknown {
  return {
    data: rows.map((r) => ({
      attributes: { reserve_in_usd: String(r.liq), base_token_price_usd: '1' },
      relationships: { base_token: { data: { id: `${GECKO_NETWORK[r.chain]}_${r.address}` } }, network: { data: { id: GECKO_NETWORK[r.chain] } } },
    })),
    included: rows.map((r) => ({ id: `${GECKO_NETWORK[r.chain]}_${r.address}`, type: 'token', attributes: { address: r.address, name: r.name ?? r.symbol, symbol: r.symbol, decimals: 6, image_url: null } })),
  };
}
const serve = (body: unknown): typeof fetch => (async (url: string | URL | Request) => (String(url).includes('/api/swings-tokens') ? new Response(JSON.stringify({ results: [] })) : new Response(JSON.stringify(body)))) as typeof fetch;

describe('searchForRadar', () => {
  it('keeps only networks Radar can analyze', async () => {
    const f = serve(gecko([{ chain: 'ethereum', address: EVM(1), symbol: 'AAA', liq: 500 }, { chain: 'arbitrum', address: EVM(2), symbol: 'AAA', liq: 900 }, { chain: 'solana', address: SOL, symbol: 'AAA', liq: 700 }, { chain: 'avalanche', address: EVM(3), symbol: 'AAA', liq: 800 }]));
    const hits = await searchForRadar('aaa', f);
    expect(hits.map((h) => h.chain).sort()).toEqual(['ethereum', 'solana']);
    for (const h of hits) expect(RADAR_CHAINS.has(h.chain)).toBe(true);
  });
  it('is not crowded out: results on other networks never use up the ten places', async () => {
    const crowd = Array.from({ length: 14 }, (_, i) => ({ chain: 'arbitrum' as ChainId, address: EVM(100 + i), symbol: 'BBB', liq: 1_000_000 - i }));
    const f = serve(gecko([...crowd, { chain: 'ethereum', address: EVM(1), symbol: 'BBB', liq: 10 }]));
    expect((await searchForRadar('bbb', f)).map((h) => h.address)).toEqual([EVM(1)]);
    // The same search with no filter, as the top bar makes it, is unchanged: ten results, all on the busy network.
    const plain = await searchTokens('bbb', f);
    expect(plain).toHaveLength(10);
    expect(plain.every((h) => h.chain === 'arbitrum')).toBe(true);
  });
  it('ranks by liquidity and stops at ten', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ chain: 'ethereum' as ChainId, address: EVM(200 + i), symbol: 'CCC', liq: 100 + i }));
    const hits = await searchForRadar('ccc', serve(gecko(many)));
    expect(hits).toHaveLength(10);
    expect(hits.map((h) => h.liquidityUsd)).toEqual([...hits.map((h) => h.liquidityUsd)].sort((a, b) => (b ?? 0) - (a ?? 0)));
    expect(hits[0]?.liquidityUsd).toBe(112);
  });
  it('finds nothing for a query that is too short, or when the sources have nothing', async () => {
    expect(await searchForRadar('a', serve(gecko([])))).toEqual([]);
    expect(await searchForRadar('zzzz', serve({ data: [] }))).toEqual([]);
  });
  it('still drops look-alike tokens: a symbol dressed with letters from another alphabet never reaches the list', async () => {
    const f = serve(gecko([{ chain: 'ethereum', address: EVM(1), symbol: 'USDС', liq: 900 }, { chain: 'ethereum', address: EVM(2), symbol: 'USDC', liq: 5 }]));
    expect((await searchForRadar('usd', f)).map((h) => h.symbol)).toEqual(['USDC']);
  });
});
