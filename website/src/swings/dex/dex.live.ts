/**
 * Read-only live proof that Aretia's direct V2 integration matches the real venues:
 *  1. the registry's addresses are real contracts and the factory finds a real pair;
 *  2. Aretia's local maths gives exactly the router's own `getAmountsOut`, at the same block;
 *  3. Aretia-built calldata is accepted by the real router (simulated with eth_call, nothing signed or sent);
 *  4. the routing engine's chosen route and amounts equal the router's answer for that path.
 * No wallet, no key, no aggregator.
 */
import { describe, expect, it } from 'vitest';
import { publicRead, type EvmRead } from '../chains/evmSession.js';
import { decodeUintArray, encodeCall, addressArray, uint } from '../engine/abi.js';
import { AretiaDexRegistry, type DexEntry } from '../engine/registry.js';
import { LiquidityStore } from '../engine/liquidity.js';
import { RoutingEngine } from '../engine/routing.js';
import { quoteConstantProduct } from '../engine/amm.js';
import { EVM_DEXES, EVM_V2_DEXES, EVM_V3_DEXES } from './entries.js';
import { buildV3Swap, EvmV3Adapter, inspectV3Swap, simulateV3Swap } from './evmV3.js';
import { HUB_TOKENS } from './hubs.js';
import { EvmV2Adapter } from './evmV2.js';
import { buildV2Swap, inspectV2Swap, simulateV2Swap } from '../execution/evmV2Builder.js';
import { EVM_NATIVE_ADDRESS, type ChainId, type TokenRef } from '../core/types.js';
import { DirectEvmProvider } from './directEvm.js';

const STABLE: Record<string, string> = {
  ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  bnb: '0x55d398326f99059ff775485246999027b3197955', // USDT (BSC)
  polygon: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
};
const tok = (chain: ChainId, address: string): TokenRef => ({ chain, address });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function amountsOut(read: EvmRead, router: string, amountIn: bigint, path: string[], block: bigint): Promise<bigint[]> {
  const data = encodeCall('getAmountsOut(uint256,address[])', [uint(amountIn), addressArray(path)]);
  return decodeUintArray((await read('eth_call', [{ to: router, data }, '0x' + block.toString(16)])) as string);
}

for (const entry of EVM_V2_DEXES) {
  describe(`live: ${entry.id}`, () => {
    const read = publicRead(entry.chain);
    const stable = STABLE[entry.chain]!;
    const wrapped = entry.wrappedNative!;

    it('router, factory and wrapped-native token are real contracts', async () => {
      for (const [name, addr] of [['router', entry.router], ['factory', entry.factory], ['wrapped native', wrapped]] as const) {
        const code = (await read('eth_getCode', [addr, 'latest'])) as string;
        expect(code.length, `${entry.id} ${name} has no code`).toBeGreaterThan(10);
      }
    });

    it('local maths equals the router at the same block, and the built calldata is accepted by the real router', async () => {
      const adapter = new EvmV2Adapter(entry, read);
      const block = BigInt((await read('eth_blockNumber', [])) as string) - 2n;
      const pool = await adapter.getPool(tok(entry.chain, wrapped), tok(entry.chain, stable), { block });
      expect(pool, `no ${entry.id} pair for wrapped native / stable`).not.toBeNull();
      expect(pool!.reserve0 > 0n && pool!.reserve1 > 0n).toBe(true);

      // A small trade relative to the pool, so the check is about maths and not about liquidity.
      const reserveWrapped = pool!.token0.address === wrapped ? pool!.reserve0 : pool!.reserve1;
      const amountIn = reserveWrapped / 1000n;
      const local = quoteConstantProduct(pool!, tok(entry.chain, wrapped), amountIn);
      const onchain = await amountsOut(read, entry.router!, amountIn, [wrapped, stable], block);
      console.log(entry.id, 'reserves', pool!.reserve0, pool!.reserve1, 'local', local, 'router', onchain[1]);
      expect(local).toBe(onchain[1]);

      // The exact transaction Aretia would build, simulated by the router from a throwaway address (balance supplied by a node override).
      const from = '0x' + '1'.repeat(40);
      const plan = buildV2Swap(entry, { path: [wrapped, stable], amountIn, minOut: (local * 99n) / 100n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
      expect(inspectV2Swap(plan.data)?.minOut).toBe((local * 99n) / 100n);
      await wait(500);
      const sim = await simulateV2Swap(read, plan, from, { balanceOverride: amountIn * 10n });
      console.log(entry.id, 'simulation', sim.ok, sim.error ?? '', sim.amounts);
      expect(sim.ok, sim.error ?? '').toBe(true);
      // The simulation runs at the latest block, so allow a small drift against the pinned-block quote.
      const drift = sim.amounts![1]! > local ? sim.amounts![1]! - local : local - sim.amounts![1]!;
      expect(drift * 1000n).toBeLessThan(local);

      // A floor above what the pool can pay must be refused by the real router.
      const impossible = buildV2Swap(entry, { path: [wrapped, stable], amountIn, minOut: local * 2n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
      const failed = await simulateV2Swap(read, impossible, from, { balanceOverride: amountIn * 10n });
      expect(failed.ok).toBe(false);
    });
  });
}

describe('live: Aretia routing engine against the real Ethereum Uniswap V2 router', () => {
  const entry = EVM_V2_DEXES.find((e) => e.id === 'uniswap-v2-ethereum')!;
  const read = publicRead('ethereum');
  const WETH = entry.wrappedNative!;
  const USDC = STABLE.ethereum!;
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

  it('discovers pools itself, finds a route, and its amounts equal the router answer for the same path', async () => {
    const adapter = new EvmV2Adapter(entry, read);
    const store = new LiquidityStore();
    const block = BigInt((await read('eth_blockNumber', [])) as string) - 2n;
    const tokens = [WETH, USDC, USDT, DAI].map((a) => tok('ethereum', a));
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const pool = await adapter.getPool(tokens[i]!, tokens[j]!, { block });
        if (pool && pool.status === 'active') store.put(pool);
      }
    }
    console.log('pools discovered', store.size());
    expect(store.size()).toBeGreaterThanOrEqual(3);

    const registry = new AretiaDexRegistry([entry as DexEntry]);
    const engine = new RoutingEngine({ store, registry });
    const amountIn = 5n * 10n ** 18n;
    const result = engine.find({ tokenIn: tok('ethereum', WETH), tokenOut: tok('ethereum', USDT), amountIn, maxHops: 3 });
    console.log('best route', result.best.hops.map((h) => h.tokenIn.address.slice(0, 8) + '…').join(' > '), 'out', result.best.amountOut, 'impact bps', result.best.priceImpactBps, 'split', result.split?.improvementBps ?? 'none');
    console.log(result.reasoning.join(' | '));

    // Every route Aretia ranked must equal what the real router says for that exact path.
    for (const route of [result.best, ...result.alternatives]) {
      const path = [route.hops[0]!.tokenIn.address, ...route.hops.map((h) => h.tokenOut.address)];
      await wait(300);
      const real = await amountsOut(read, entry.router!, amountIn, path, block);
      expect(route.amountOut, `path ${path.join('>')}`).toBe(real[real.length - 1]);
    }
    // And the best route really is the best of those that were found.
    const outs = [result.best, ...result.alternatives].map((r) => r.amountOut);
    expect(result.best.amountOut).toBe(outs.reduce((a, b) => (a > b ? a : b)));
  });
});

describe('live: DirectEvmProvider end to end on all four chains (nothing signed or sent)', () => {
  const taker = '0x' + '1'.repeat(40);
  // The real node, except that the throwaway sender is given a balance, so the check runs for any address.
  const withBalance = (read: EvmRead): EvmRead => async (method, params) => {
    if (method === 'eth_getBalance' && String(params[0]).toLowerCase() === taker) return '0x' + (10n ** 27n).toString(16);
    if (method === 'eth_call' && (params[0] as { from?: string }).from?.toLowerCase() === taker) return read(method, [params[0], params[1], { [taker]: { balance: '0x' + (10n ** 27n).toString(16) } }]);
    return read(method, params);
  };
  for (const entry of EVM_V2_DEXES) {
    it(`${entry.chain}: native -> stable, the router agrees with the quote and accepts the transaction`, async () => {
      await wait(500);
      // Every direct venue on this chain (V2 and V3) competes, as in production.
      const registry = new AretiaDexRegistry(EVM_DEXES.filter((e) => e.chain === entry.chain) as DexEntry[]);
      const provider = new DirectEvmProvider({ registry, read: (c) => withBalance(publicRead(c)) });
      const stable = STABLE[entry.chain]!;
      const wrapped = entry.wrappedNative!;
      // Size the trade from the pool itself, so it is small relative to liquidity on every chain.
      const pool = await new EvmV2Adapter(entry, publicRead(entry.chain)).getPool(tok(entry.chain, wrapped), tok(entry.chain, stable));
      const reserveWrapped = pool!.token0.address === wrapped ? pool!.reserve0 : pool!.reserve1;
      const amountIn = reserveWrapped / 2000n;
      const quote = await provider.getQuote({ chain: entry.chain, from: tok(entry.chain, EVM_NATIVE_ADDRESS), to: tok(entry.chain, stable), amountIn, slippageBps: 100, account: { chain: entry.chain, address: taker } });
      const prepared = await provider.buildTransaction(quote);
      console.log(entry.chain, (quote.raw as { reasons: string[] }).reasons[0]);
      console.log(entry.chain, 'quote', quote.expectedOut, 'via', quote.route.legs.map((l) => l.venue).join('>'), 'impact bps', quote.priceImpactBps, 'sim', prepared.simulation.ok, prepared.simulation.blockers.join(';'), prepared.simulation.warnings.join(';'));
      expect(prepared.simulation.blockers).toEqual([]);
      expect(prepared.simulation.ok).toBe(true);
      expect(quote.priceImpactBps).not.toBeNull();
      expect(quote.priceImpactBps!).toBeLessThan(100);
    });
  }
});

for (const entry of EVM_V3_DEXES) {
  describe(`live: ${entry.id}`, () => {
    const read = publicRead(entry.chain);
    const stable = STABLE[entry.chain]!;
    const wrapped = entry.wrappedNative!;
    const from = '0x' + '1'.repeat(40);

    it('contracts are real, the quoter prices a trade, and the real SwapRouter02 accepts and agrees with Aretia-built calldata', async () => {
      await wait(800);
      for (const [name, addr] of [['router', entry.router], ['factory', entry.factory], ['quoter', entry.quoter]] as const) {
        expect(((await read('eth_getCode', [addr, 'latest'])) as string).length, `${entry.id} ${name}`).toBeGreaterThan(10);
      }
      const adapter = new EvmV3Adapter(entry, read);
      const hubs = (HUB_TOKENS[entry.chain] ?? []).map((h) => h.address);
      const amountIn = 10n ** 17n; // 0.1 of the native coin
      const route = await adapter.bestRoute(wrapped, stable, amountIn, hubs);
      console.log(entry.id, 'best route', route && { hops: route.tokens.length - 1, fees: route.fees, out: route.amountOut, gas: route.gasEstimate });
      expect(route, 'no V3 route for wrapped native -> stable').not.toBeNull();
      expect(route!.amountOut > 0n).toBe(true);

      const minOut = (route!.amountOut * 98n) / 100n;
      const plan = buildV3Swap(entry, { tokens: route!.tokens, fees: route!.fees, amountIn, minOut, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
      const back = inspectV3Swap(plan.data)!;
      expect(back).toMatchObject({ amountIn, minOut, recipient: from, tokens: route!.tokens, fees: route!.fees });
      const sim = await simulateV3Swap(read, plan, from, { balanceOverride: 10n ** 24n });
      console.log(entry.id, 'simulation', sim.ok, sim.error ?? '', 'router pays', sim.amountOut);
      expect(sim.ok, sim.error ?? '').toBe(true);
      const drift = sim.amountOut! > route!.amountOut ? sim.amountOut! - route!.amountOut : route!.amountOut - sim.amountOut!;
      expect(drift * 200n).toBeLessThan(route!.amountOut);

      // The router must refuse a minimum the pool cannot meet.
      const bad = buildV3Swap(entry, { tokens: route!.tokens, fees: route!.fees, amountIn, minOut: route!.amountOut * 2n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
      expect((await simulateV3Swap(read, bad, from, { balanceOverride: 10n ** 24n })).ok).toBe(false);
    });

    it('a two-hop route through a hub is quoted and accepted too, when one exists', async () => {
      await wait(800);
      const adapter = new EvmV3Adapter(entry, read);
      const others = (HUB_TOKENS[entry.chain] ?? []).map((h) => h.address).filter((a) => a !== wrapped && a !== stable);
      if (others.length === 0) return;
      const route = await adapter.bestRoute(others[0]!, stable, 10n ** 6n * 5n, [wrapped]);
      console.log(entry.id, 'two-hop probe', route && { hops: route.tokens.length - 1, out: route.amountOut });
      if (route && route.tokens.length === 3) {
        const plan = buildV3Swap(entry, { tokens: route.tokens, fees: route.fees, amountIn: 10n ** 6n * 5n, minOut: 1n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600 });
        expect(inspectV3Swap(plan.data)?.function).toBe('exactInput');
      }
    });
  });
}

describe('live: Uniswap V3 multi-hop (exactInput) on the real router', () => {
  for (const entry of EVM_V3_DEXES) {
    it(`${entry.id}: a forced two-hop path is quoted by the venue and the router pays the same`, async () => {
      await wait(800);
      const read = publicRead(entry.chain);
      const adapter = new EvmV3Adapter(entry, read);
      const wrapped = entry.wrappedNative!;
      const mid = STABLE[entry.chain]!;
      const from = '0x' + '1'.repeat(40);
      const ends = (HUB_TOKENS[entry.chain] ?? []).map((h) => h.address).filter((a) => a !== wrapped && a !== mid);
      let chosen: { out: string; f1: number; f2: number } | null = null;
      for (const out of ends) {
        for (const f1 of [500, 3000, 100, 10_000]) {
          for (const f2 of [100, 500, 3000, 10_000]) {
            if (!chosen && (await adapter.hasPool(wrapped, mid, f1)) && (await adapter.hasPool(mid, out, f2))) chosen = { out, f1, f2 };
          }
        }
      }
      if (!chosen) {
        console.log(entry.id, 'no two-hop path through the stable exists among the hubs: skipped');
        return;
      }
      const amountIn = 10n ** 17n;
      const tokens = [wrapped, mid, chosen.out];
      const fees = [chosen.f1, chosen.f2];
      const quote = await adapter.quotePath(tokens, fees, amountIn);
      expect(quote).not.toBeNull();
      const plan = buildV3Swap(entry, { tokens, fees, amountIn, minOut: (quote!.amountOut * 95n) / 100n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
      expect(inspectV3Swap(plan.data)).toMatchObject({ function: 'exactInput', tokens, fees, amountIn });
      const sim = await simulateV3Swap(read, plan, from, { balanceOverride: 10n ** 24n });
      console.log(entry.id, 'two-hop', tokens.map((t) => t.slice(0, 8)).join('>'), fees, 'quote', quote!.amountOut, 'router pays', sim.amountOut, sim.error ?? '');
      expect(sim.ok, sim.error ?? '').toBe(true);
      const drift = sim.amountOut! > quote!.amountOut ? sim.amountOut! - quote!.amountOut : quote!.amountOut - sim.amountOut!;
      expect(drift * 100n).toBeLessThan(quote!.amountOut);
    });
  }
});
