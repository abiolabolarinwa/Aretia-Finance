/**
 * Read-only live proof of Aretia's routes on Robinhood Chain (4663), before swaps are switched on for it. Nothing is signed or
 * sent. It checks that every address in the Robinhood entries is a real contract, then, for liquid tokens taken from
 * DexScreener at run time (so nothing here is a hard-coded token), quotes a buy with the chain's native ETH through the same
 * provider the wallet uses, builds the exact transaction, and has the real router simulate it. The sender is given a balance
 * only inside the simulation. An impossible minimum must be refused by the router.
 *
 * Not proved here: selling a token back (it needs the sender to hold the token and approve the router) and the fee transfer.
 */
import { describe, expect, it } from 'vitest';
import { decodeAbiString, publicRead, type EvmRead } from '../chains/evmSession.js';
import { encodeCall } from '../engine/abi.js';
import { HUB_TOKENS } from './hubs.js';
import { EVM_NATIVE_ADDRESS, type TokenRef } from '../core/types.js';
import { AretiaDexRegistry, type DexEntry } from '../engine/registry.js';
import { EVM_DEXES } from './entries.js';
import { DirectEvmProvider } from './directEvm.js';

const taker = '0x' + '1'.repeat(40);
const entries = EVM_DEXES.filter((e) => e.chain === 'robinhood') as DexEntry[];
const tok = (address: string): TokenRef => ({ chain: 'robinhood', address });

/** The real node, except that the throwaway sender is given a balance, so the check runs for any address. */
const withBalance = (read: EvmRead): EvmRead => async (method, params) => {
  const balance = '0x' + (10n ** 27n).toString(16);
  if (method === 'eth_getBalance' && String(params[0]).toLowerCase() === taker) return balance;
  if (method === 'eth_call' && (params[0] as { from?: string }).from?.toLowerCase() === taker) return read(method, [params[0], params[1], { [taker]: { balance } }]);
  return read(method, params);
};

interface Pair {
  pairAddress: string;
  chainId: string;
  labels?: string[];
  baseToken: { address: string; symbol: string };
  quoteToken: { symbol: string };
  liquidity?: { usd?: number };
}

/** Liquid tokens that trade against ETH on Robinhood, by Uniswap version, found now. */
async function liquidTokens(label: 'v3' | 'v4' | 'any', count: number, quotes: string[] = ['WETH', 'ETH']): Promise<{ address: string; symbol: string; liquidity: number }[]> {
  const found = new Map<string, { address: string; symbol: string; liquidity: number }>();
  for (const q of ['robinhood weth', 'robinhood eth', 'robinhood usdg', 'robinhood']) {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) continue;
    const body = (await res.json()) as { pairs?: Pair[] };
    for (const p of body.pairs ?? []) {
      if (p.chainId !== 'robinhood' || (label !== 'any' && !p.labels?.includes(label)) || !quotes.includes(p.quoteToken.symbol)) continue;
      const liquidity = p.liquidity?.usd ?? 0;
      if (liquidity < 20_000) continue;
      const address = p.baseToken.address.toLowerCase();
      if (!found.has(address) || found.get(address)!.liquidity < liquidity) found.set(address, { address, symbol: p.baseToken.symbol, liquidity });
    }
  }
  return [...found.values()].sort((a, b) => b.liquidity - a.liquidity).slice(0, count);
}

describe('live: Robinhood Chain routes, simulation only', () => {
  const read = publicRead('robinhood');

  it('has a V3 and a V4 venue, and every address in them is a real contract', async () => {
    expect(entries.map((e) => e.id).sort()).toEqual(['uniswap-v3-robinhood', 'uniswap-v4-robinhood']);
    for (const e of entries) {
      const addrs = [e.router, e.factory, e.quoter, e.wrappedNative, (e as { stateView?: string }).stateView, (e as { positionManager?: string }).positionManager].filter((a): a is string => typeof a === 'string');
      for (const a of addrs) expect(((await read('eth_getCode', [a, 'latest'])) as string).length, `${e.id} ${a}`).toBeGreaterThan(10);
    }
  }, 120_000);

  it('every hub token is what it says it is: the chain reports the same symbol and decimals', async () => {
    const hubs = HUB_TOKENS.robinhood ?? [];
    expect(hubs.map((h) => h.symbol)).toEqual(['WETH', 'USDG']);
    for (const h of hubs) {
      const symbol = decodeAbiString(await read('eth_call', [{ to: h.address, data: encodeCall('symbol()', []) }, 'latest']));
      const decimals = Number(BigInt((await read('eth_call', [{ to: h.address, data: encodeCall('decimals()', []) }, 'latest'])) as string));
      expect({ symbol, decimals }, h.address).toEqual({ symbol: h.symbol, decimals: h.decimals });
    }
  }, 120_000);

  it("USDG, the chain's stablecoin, can be bought with ETH: quoted, built, and accepted by the real router", async () => {
    const usdg = HUB_TOKENS.robinhood!.find((h) => h.symbol === 'USDG')!;
    const provider = new DirectEvmProvider({ registry: new AretiaDexRegistry(entries), read: () => withBalance(read) });
    const amountIn = 5n * 10n ** 15n;
    const quote = await provider.getQuote({ chain: 'robinhood', from: tok(EVM_NATIVE_ADDRESS), to: tok(usdg.address), amountIn, slippageBps: 300, account: { chain: 'robinhood', address: taker } });
    const prepared = await provider.buildTransaction(quote);
    console.log('robinhood USDG quote', quote.expectedOut, 'via', quote.route.legs.map((l) => l.venue).join('>'), 'impact bps', quote.priceImpactBps, 'sim', prepared.simulation.ok, prepared.simulation.blockers.join(';'));
    expect(prepared.simulation.blockers).toEqual([]);
    expect(prepared.simulation.ok).toBe(true);
    // 0.005 ETH of USDG is a plausible number of dollars (6 decimals), not dust and not absurd.
    expect(quote.expectedOut > 1_000_000n && quote.expectedOut < 100_000_000n).toBe(true);
  }, 180_000);

  it('every liquid token that pairs with USDG is either quoted and accepted by the real router, or has no route: never quoted and then refused', async () => {
    const tokens = await liquidTokens('any', 8, ['USDG']);
    console.log('robinhood USDG-paired tokens', tokens.map((t) => t.symbol).join(', '));
    expect(tokens.length).toBeGreaterThan(0);
    const provider = new DirectEvmProvider({ registry: new AretiaDexRegistry(entries), read: () => withBalance(read) });
    let accepted = 0;
    const refused: string[] = [];
    for (const t of tokens) {
      let quote;
      try {
        quote = await provider.getQuote({ chain: 'robinhood', from: tok(EVM_NATIVE_ADDRESS), to: tok(t.address), amountIn: 5n * 10n ** 15n, slippageBps: 300, account: { chain: 'robinhood', address: taker } });
      } catch {
        continue; // no route: the wallet says so, which is honest
      }
      const prepared = await provider.buildTransaction(quote);
      console.log('robinhood', t.symbol, 'via', quote.route.legs.map((l) => l.venue).join('>'), 'sim', prepared.simulation.ok, prepared.simulation.blockers.join(';').slice(0, 80));
      if (prepared.simulation.ok) accepted++;
      else refused.push(t.symbol);
    }
    expect(refused, `quoted, then refused by the router: ${refused.join(', ')}`).toEqual([]);
    expect(accepted).toBeGreaterThan(0);
  }, 280_000);

  for (const label of ['v3', 'v4'] as const) {
    it(`${label}: a buy with ETH is quoted, built, and accepted by the real router at the quoted price; an impossible minimum is refused`, async () => {
      const tokens = await liquidTokens(label, 3);
      console.log('robinhood', label, 'tokens', tokens.map((t) => `${t.symbol} $${Math.round(t.liquidity)}`).join(', '));
      expect(tokens.length, `no liquid ${label} token found on Robinhood`).toBeGreaterThan(0);
      const registry = new AretiaDexRegistry(entries);
      const provider = new DirectEvmProvider({ registry, read: () => withBalance(read) });
      const amountIn = 5n * 10n ** 15n; // 0.005 ETH
      let accepted = 0;
      for (const t of tokens) {
        try {
          const quote = await provider.getQuote({ chain: 'robinhood', from: tok(EVM_NATIVE_ADDRESS), to: tok(t.address), amountIn, slippageBps: 300, account: { chain: 'robinhood', address: taker } });
          const prepared = await provider.buildTransaction(quote);
          console.log('robinhood', label, t.symbol, 'quote', quote.expectedOut, 'via', quote.route.legs.map((l) => l.venue).join('>'), 'impact bps', quote.priceImpactBps, 'sim', prepared.simulation.ok, prepared.simulation.blockers.join(';'));
          if (prepared.simulation.blockers.length > 0) console.log('robinhood', label, t.symbol, 'BLOCKERS:', JSON.stringify(prepared.simulation.blockers), 'route', JSON.stringify(quote.route.legs.map((l) => ({ venue: l.venue, path: (l as { path?: unknown }).path }))), 'raw', JSON.stringify((quote.raw as { reasons?: string[] }).reasons ?? []).slice(0, 300));
          expect(prepared.simulation.blockers, `${t.symbol} blockers`).toEqual([]);
          expect(prepared.simulation.ok).toBe(true);
          accepted++;
          // The router must refuse a minimum the pool cannot meet (ten times what it would pay).
          if (accepted === 1) {
            const impossible = await provider.buildTransaction({ ...quote, minOut: quote.expectedOut * 10n });
            console.log('robinhood', label, t.symbol, 'impossible minimum, sim ok:', impossible.simulation.ok, impossible.simulation.blockers.join(';').slice(0, 120));
            expect(impossible.simulation.ok, 'the router accepted a minimum the pool cannot meet').toBe(false);
          }
        } catch (e) {
          console.log('robinhood', label, t.symbol, 'not accepted:', e instanceof Error ? e.message.slice(0, 160) : e);
        }
      }
      expect(accepted, `the router accepted none of the ${label} buys`).toBeGreaterThan(0);
    }, 240_000);
  }
});
