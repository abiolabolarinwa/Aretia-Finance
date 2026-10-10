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
import { publicRead, type EvmRead } from '../chains/evmSession.js';
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
async function liquidTokens(label: 'v3' | 'v4', count: number): Promise<{ address: string; symbol: string; liquidity: number }[]> {
  const found = new Map<string, { address: string; symbol: string; liquidity: number }>();
  for (const q of ['robinhood weth', 'robinhood eth', 'robinhood']) {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) continue;
    const body = (await res.json()) as { pairs?: Pair[] };
    for (const p of body.pairs ?? []) {
      if (p.chainId !== 'robinhood' || !p.labels?.includes(label) || !['WETH', 'ETH'].includes(p.quoteToken.symbol)) continue;
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
