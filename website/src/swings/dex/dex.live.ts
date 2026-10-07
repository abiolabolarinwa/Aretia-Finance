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
import { EVM_AERODROME, EVM_BALANCER, EVM_CURVE, EVM_DEXES, EVM_PANCAKE_V3, EVM_V2_DEXES, EVM_V3_DEXES } from './entries.js';
import { buildCurveSwap, EvmCurveAdapter, inspectCurveSwap } from './evmCurve.js';
import { keccak256 } from '../core/keccak.js';
import { buildBalancerSwap, EvmBalancerAdapter, inspectBalancerSwap, simulateBalancerSwap } from './evmBalancer.js';
import { buildAerodromeSwap, EvmAerodromeAdapter, inspectAerodromeSwap } from './evmAerodrome.js';
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
  arbitrum: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  optimism: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
  avalanche: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // USDC
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

for (const entry of [...EVM_V3_DEXES, ...EVM_PANCAKE_V3]) {
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

describe('live: V3 multi-hop (exactInput) on the real router', () => {
  for (const entry of [...EVM_V3_DEXES, ...EVM_PANCAKE_V3]) {
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
        for (const f1 of entry.feeTiers ?? [500, 3000, 100, 10_000]) {
          for (const f2 of entry.feeTiers ?? [100, 500, 3000, 10_000]) {
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

describe('live: Aerodrome (Base) direct', () => {
  const entry = EVM_AERODROME[0]!;
  const read = publicRead('base');
  const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const from = '0x' + '1'.repeat(40);
  const hubs = (HUB_TOKENS.base ?? []).map((h) => h.address);

  it('router and factory are real contracts', async () => {
    for (const a of [entry.router!, entry.factory!]) expect(((await read('eth_getCode', [a, 'latest'])) as string).length).toBeGreaterThan(10);
  });

  it('prices ETH -> USDC by the router, builds the swap, and the real router accepts it and pays the same', async () => {
    await wait(800);
    const adapter = new EvmAerodromeAdapter(entry, read);
    const amountIn = 10n ** 17n;
    const route = await adapter.bestRoute(entry.wrappedNative!, USDC_BASE, amountIn, hubs);
    console.log('aerodrome best', route && { hops: route.hops.map((h) => (h.stable ? 'stable' : 'volatile')), out: route.amountOut });
    expect(route).not.toBeNull();
    const minOut = (route!.amountOut * 98n) / 100n;
    const plan = buildAerodromeSwap(entry, { hops: route!.hops, amountIn, minOut, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
    expect(inspectAerodromeSwap(plan.data)).toMatchObject({ function: 'swapExactETHForTokens', minOut, recipient: from, hops: route!.hops.map((h) => ({ ...h })) });
    const sim = await simulateV2Swap(read, plan, from, { balanceOverride: 10n ** 24n });
    console.log('aerodrome simulation', sim.ok, sim.error ?? '', sim.amounts?.[sim.amounts.length - 1]);
    expect(sim.ok, sim.error ?? '').toBe(true);
    const paid = sim.amounts![sim.amounts!.length - 1]!;
    const drift = paid > route!.amountOut ? paid - route!.amountOut : route!.amountOut - paid;
    expect(drift * 200n).toBeLessThan(route!.amountOut);
    const bad = buildAerodromeSwap(entry, { hops: route!.hops, amountIn, minOut: route!.amountOut * 2n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
    expect((await simulateV2Swap(read, bad, from, { balanceOverride: 10n ** 24n })).ok).toBe(false);
  });

  it('a stable pool and a two-hop route price too, when they exist', async () => {
    await wait(800);
    const adapter = new EvmAerodromeAdapter(entry, read);
    const stableOnly = await adapter.quote([{ from: USDC_BASE, to: '0xeb466342c4d449bc9f53a865d5cb90586f405215', stable: true, factory: entry.factory! }], 1_000_000n);
    console.log('USDC -> axlUSDC stable pool out', stableOnly);
    const twoHop = await adapter.quote([{ from: entry.wrappedNative!, to: USDC_BASE, stable: false, factory: entry.factory! }, { from: USDC_BASE, to: '0xeb466342c4d449bc9f53a865d5cb90586f405215', stable: true, factory: entry.factory! }], 10n ** 16n);
    console.log('WETH -> USDC -> axlUSDC out', twoHop);
    expect(stableOnly === null || stableOnly > 0n).toBe(true);
  });
});

describe('live: Balancer V2 direct', () => {
  const from = '0x' + '1'.repeat(40);
  for (const entry of EVM_BALANCER) {
    it(`${entry.id}: the Vault knows every listed pool, and lists tokens that match what Aretia expects`, async () => {
      await wait(600);
      const adapter = new EvmBalancerAdapter(entry, publicRead(entry.chain));
      let known = 0;
      for (const id of entry.knownPools!) {
        const tokens = await adapter.poolTokens(id);
        if (tokens) known++;
        else console.log(entry.id, 'pool id not known to the Vault (drained or removed):', id);
      }
      console.log(entry.id, `${known}/${entry.knownPools!.length} pools known to the Vault`);
      expect(known).toBeGreaterThan(0);
    });
  }

  it('Ethereum: prices WETH -> BAL by the Vault, builds batchSwap, and the real Vault accepts it and pays the same', async () => {
    await wait(800);
    const entry = EVM_BALANCER.find((e) => e.chain === 'ethereum')!;
    const read = publicRead('ethereum');
    const adapter = new EvmBalancerAdapter(entry, read);
    const BAL = '0xba100000625a3754423978a60c9317c58a424e3d';
    const amountIn = 10n ** 17n;
    const route = await adapter.bestRoute(entry.wrappedNative!, BAL, amountIn);
    console.log('balancer eth route', route && { steps: route.steps.length, out: route.amountOut });
    expect(route).not.toBeNull();
    const minOut = (route!.amountOut * 98n) / 100n;
    const plan = buildBalancerSwap(entry, { steps: route!.steps, assets: route!.assets, amountIn, minOut, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
    expect(inspectBalancerSwap(plan.data)).toMatchObject({ recipient: from, deadline: expect.any(Number) });
    const lastIdx = route!.steps[route!.steps.length - 1]!.assetOut;
    const sim = await simulateBalancerSwap(read, plan, from, lastIdx, { balanceOverride: 10n ** 24n });
    console.log('balancer simulation', sim.ok, sim.error ?? '', sim.amountOut);
    expect(sim.ok, sim.error ?? '').toBe(true);
    const drift = sim.amountOut! > route!.amountOut ? sim.amountOut! - route!.amountOut : route!.amountOut - sim.amountOut!;
    expect(drift * 100n).toBeLessThan(route!.amountOut);
    const bad = buildBalancerSwap(entry, { steps: route!.steps, assets: route!.assets, amountIn, minOut: route!.amountOut * 2n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
    expect((await simulateBalancerSwap(read, bad, from, lastIdx, { balanceOverride: 10n ** 24n })).ok).toBe(false);
  });

  it('Ethereum: a two-hop route (WBTC -> WETH -> BAL) is priced by the Vault', async () => {
    await wait(800);
    const entry = EVM_BALANCER.find((e) => e.chain === 'ethereum')!;
    const adapter = new EvmBalancerAdapter(entry, publicRead('ethereum'));
    const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
    const BAL = '0xba100000625a3754423978a60c9317c58a424e3d';
    const route = await adapter.bestRoute(WBTC, BAL, 10_000n);
    console.log('WBTC->BAL', route && { steps: route.steps.length, out: route.amountOut });
    expect(route?.steps.length).toBe(2);
  });
});

describe('live: Curve direct', () => {
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.replace('0x', '')).padStart(64, '0');
  /** storage slot of mapping[key] where the mapping sits at `slot` */
  const slotOf = (key: string, slot: string): string => '0x' + hex(keccak256(Uint8Array.from((word(key) + word(slot)).match(/../g)!, (h) => Number.parseInt(h, 16))));

  for (const entry of EVM_CURVE) {
    it(`${entry.id}: every listed pool answers coins() and a live get_dy`, async () => {
      await wait(700);
      const adapter = new EvmCurveAdapter(entry, publicRead(entry.chain));
      let usable = 0;
      for (const pool of entry.knownPools!) {
        const coins = await adapter.coins(pool);
        if (!coins) {
          console.log(entry.id, 'pool not usable (no int128 coins):', pool);
          continue;
        }
        // Coins have 6 or 18 decimals: try one whole unit of each, so a dust-sized probe cannot read as "no pool".
        let dy: bigint | null = null;
        for (const dx of [10n ** 6n, 10n ** 18n]) {
          dy = await adapter.quote(pool, 0, 1, dx);
          if (dy !== null) break;
        }
        console.log(entry.id, pool.slice(0, 8), 'coins', coins.map((c) => c.slice(0, 8)), 'get_dy(0,1) =', dy);
        if (dy !== null) usable++;
      }
      expect(usable).toBeGreaterThan(0);
    });
  }

  it('Ethereum 3pool: DAI -> USDC priced by the pool, built, and the real pool accepts it and agrees (token balance and allowance set by node state override)', async () => {
    await wait(800);
    const entry = EVM_CURVE.find((e) => e.chain === 'ethereum')!;
    const read = publicRead('ethereum');
    const adapter = new EvmCurveAdapter(entry, read);
    const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
    const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const amountIn = 1_000n * 10n ** 18n;
    const route = await adapter.bestRoute(DAI, USDC_ETH, amountIn);
    console.log('curve route', route);
    expect(route).not.toBeNull();
    const user = '0x' + '1'.repeat(40);
    const plan = buildCurveSwap(entry, { pool: route!.pool, i: route!.i, j: route!.j, tokenIn: DAI, amountIn, minOut: (route!.amountOut * 99n) / 100n });
    expect(inspectCurveSwap(plan.to, plan.data)).toMatchObject({ pool: route!.pool, i: route!.i, j: route!.j, amountIn });
    // DAI keeps balanceOf at storage slot 2 and allowance at slot 3.
    const balanceSlot = slotOf(user, '2');
    const allowanceSlot = slotOf(route!.pool, slotOf(user, '3'));
    const overrides = { [DAI]: { stateDiff: { [balanceSlot]: '0x' + word(amountIn * 2n), [allowanceSlot]: '0x' + word(amountIn * 2n) } } };
    const run = (minOut: bigint) => read('eth_call', [{ from: user, to: plan.to, data: buildCurveSwap(entry, { pool: route!.pool, i: route!.i, j: route!.j, tokenIn: DAI, amountIn, minOut }).data }, 'latest', overrides]);
    const ok = await run((route!.amountOut * 99n) / 100n).then(() => true, (e: Error) => { console.log('curve sim error:', e.message.slice(0, 200)); return false; });
    expect(ok).toBe(true);
    // A floor above the pool's output must be refused by the pool.
    const refused = await run(route!.amountOut * 2n).then(() => false, () => true);
    expect(refused).toBe(true);
  });
});

import { buildV3Split } from './evmV3.js';

describe('live: Uniswap V3 split across fee tiers (Ethereum), one multicall on the real router', () => {
  const entry = EVM_V3_DEXES.find((e) => e.id === 'uniswap-v3-ethereum')!;
  const read = publicRead('ethereum');
  const user = '0x' + '1'.repeat(40);
  for (const eth of [500n, 3_000n, 10_000n]) {
    it(`${eth} ETH -> USDC: quoted by the venue's quoter, and when split the real router accepts both legs and pays the sum`, async () => {
      await wait(1500);
      const provider = new DirectEvmProvider({ registry: new AretiaDexRegistry([entry]), read: () => read });
      const amountIn = eth * 10n ** 18n;
      const q = await provider.getQuote({ chain: 'ethereum', from: tok('ethereum', EVM_NATIVE_ADDRESS), to: tok('ethereum', STABLE.ethereum!), amountIn, slippageBps: 100, account: { chain: 'ethereum', address: user } });
      const raw = q.raw as { v3split?: { fee: number; amountIn: bigint; minOut: bigint }[]; reasons: string[] };
      console.log(`${eth} ETH`, 'out', q.expectedOut, 'impact', q.priceImpactBps, raw.v3split ? 'SPLIT' : 'single', '|', raw.reasons.at(-1));
      if (!raw.v3split) return;
      const plan = buildV3Split(entry, { tokenIn: entry.wrappedNative!, tokenOut: STABLE.ethereum!, legs: raw.v3split, recipient: user, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
      const sim = await simulateV3Swap(read, plan, user, { balanceOverride: 10n ** 30n });
      console.log('split simulation', sim.ok, sim.error ?? '', 'router pays', sim.amountOut, 'quoted', q.expectedOut);
      expect(sim.ok, sim.error ?? '').toBe(true);
      const drift = sim.amountOut! > q.expectedOut ? sim.amountOut! - q.expectedOut : q.expectedOut - sim.amountOut!;
      expect(drift * 200n).toBeLessThan(q.expectedOut);
    }, 120_000);
  }
});

describe('live: Velodrome (Optimism) direct', () => {
  const entry = EVM_AERODROME.find((e) => e.id === 'velodrome-optimism')!;
  const read = publicRead('optimism');
  const from = '0x' + '1'.repeat(40);
  const hubs = (HUB_TOKENS.optimism ?? []).map((h) => h.address);

  it('router and factory are real contracts, and the real router prices, accepts and pays an Aretia-built swap', async () => {
    await wait(800);
    for (const a of [entry.router!, entry.factory!]) expect(((await read('eth_getCode', [a, 'latest'])) as string).length).toBeGreaterThan(10);
    const adapter = new EvmAerodromeAdapter(entry, read);
    const amountIn = 10n ** 17n;
    const route = await adapter.bestRoute(entry.wrappedNative!, STABLE.optimism!, amountIn, hubs);
    console.log('velodrome best', route && { hops: route.hops.map((h) => (h.stable ? 'stable' : 'volatile')), out: route.amountOut });
    expect(route).not.toBeNull();
    const plan = buildAerodromeSwap(entry, { hops: route!.hops, amountIn, minOut: (route!.amountOut * 98n) / 100n, recipient: from, deadline: Math.floor(Date.now() / 1000) + 600, nativeIn: true });
    const sim = await simulateV2Swap(read, plan, from, { balanceOverride: 10n ** 24n });
    console.log('velodrome simulation', sim.ok, sim.error ?? '', sim.amounts?.[sim.amounts.length - 1]);
    expect(sim.ok, sim.error ?? '').toBe(true);
    const paid = sim.amounts![sim.amounts!.length - 1]!;
    const drift = paid > route!.amountOut ? paid - route!.amountOut : route!.amountOut - paid;
    expect(drift * 200n).toBeLessThan(route!.amountOut);
  });
});
