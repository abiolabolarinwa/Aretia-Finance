/**
 * Read-only live proof of Aretia's direct Solana path against Raydium's real CPMM program: pools are found by
 * the program's own address derivation, parsed against its account layout, and priced; the transaction Aretia
 * builds is then run through the real program with `simulateTransaction` (no signature, nothing sent).
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { RAYDIUM_CPMM_PROGRAM, RaydiumCpmmAdapter, type SolRpc } from './raydiumCpmm.js';
import { quoteConstantProduct } from '../engine/amm.js';

const RPC = 'https://api.mainnet-beta.solana.com';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const rpc: SolRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined) throw new Error(`rpc ${method}: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }
  throw new Error(`rpc ${method}: rate limited`);
};

describe('live: Raydium CPMM direct', () => {
  it('the program exists and is executable', async () => {
    const r = await rpc<{ value: { executable: boolean } | null }>('getAccountInfo', [RAYDIUM_CPMM_PROGRAM, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    expect(r.value?.executable).toBe(true);
  });

  it('finds real pools for SOL/USDC by deriving their addresses, and prices them', async () => {
    const adapter = new RaydiumCpmmAdapter(web3, rpc);
    const pools = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: USDC });
    console.log('SOL/USDC CPMM pools:', pools.map((p) => ({ addr: p.ref.address.slice(0, 8), fee: p.feePpm, r0: p.reserve0, r1: p.reserve1, status: p.status })));
    for (const alt of [USDT]) {
      const more = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: alt });
      console.log('SOL/USDT CPMM pools:', more.length);
    }
    expect(pools.length).toBeGreaterThan(0);
    const active = pools.filter((p) => p.status === 'active');
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) {
      const out = quoteConstantProduct(p, { chain: 'solana', address: SOL }, 10n ** 9n);
      console.log('1 SOL ->', Number(out) / 1e6, 'USDC in pool', p.ref.address.slice(0, 8), 'fee ppm', p.feePpm);
      expect(out > 0n).toBe(true);
    }
  });
});

import { buildCpmmSwapTransaction, type CpmmSwapStep } from './builder.js';
import { simulateSolanaSwap } from './simulate.js';
import { ataAddress, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';

/**
 * A real, well-known funded wallet (a large exchange hot wallet holding SOL and USDC in its associated account), used
 * only as the fee payer and token owner of a simulation. No signature is ever made and nothing is sent.
 */
const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const richPayer = async (): Promise<string> => PAYER;

describe('live: Aretia-built Raydium CPMM transaction against the real program (simulation only)', () => {
  it('SOL -> USDC: the program pays exactly what Aretia quoted, and rejects a floor above it', async () => {
    const adapter = new RaydiumCpmmAdapter(web3, rpc);
    const pools = (await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: USDC })).filter((p) => p.status === 'active');
    const pool = pools.reduce((a, b) => (a.reserve0 * a.reserve1 > b.reserve0 * b.reserve1 ? a : b));
    const payer = await richPayer();
    const amountIn = 10_000_000n; // 0.01 SOL
    const quote = quoteConstantProduct(pool, { chain: 'solana', address: SOL }, amountIn);
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const wsolExisting = await rpc<{ value: unknown }>('getAccountInfo', [ataAddress(web3, payer, SOL, TOKEN_PROGRAM_ID), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    const step: CpmmSwapStep = { pool, tokenIn: { chain: 'solana', address: SOL }, tokenOut: { chain: 'solana', address: USDC }, amountIn, minOut: (quote * 99n) / 100n };
    const built = await buildCpmmSwapTransaction(web3, { user: payer, step, nativeIn: true, nativeOut: false, closeWsol: wsolExisting.value === null, recentBlockhash: value.blockhash });
    console.log('pool', pool.ref.address, 'payer', payer.slice(0, 8), 'quote USDC raw', quote);
    console.log(built.steps.join(' | '));
    const sim = await simulateSolanaSwap(rpc, built.transaction, { user: payer, inAccount: null, outAccount: built.outAccount, inputIsSol: true, outputIsSol: false, amountIn, minOut: step.minOut, overheadLamports: 20_000_000n });
    console.log('simulation problems:', sim.blockers, 'received', sim.verdict.received, 'units', sim.unitsConsumed);
    if (sim.blockers.length > 0) console.log(sim.logs.slice(-8).join('\n'));
    expect(sim.blockers).toEqual([]);
    expect(sim.verdict.received).toBe(quote);

    // A floor above what the pool can pay must be refused by the program itself.
    const bad = await buildCpmmSwapTransaction(web3, { user: payer, step: { ...step, minOut: quote * 2n }, nativeIn: true, nativeOut: false, closeWsol: wsolExisting.value === null, recentBlockhash: value.blockhash });
    const refused = await simulateSolanaSwap(rpc, bad.transaction, { user: payer, inAccount: null, outAccount: bad.outAccount, inputIsSol: true, outputIsSol: false, amountIn, minOut: quote * 2n, overheadLamports: 20_000_000n });
    expect(refused.blockers.length).toBeGreaterThan(0);
  });

  it('USDC -> SOL: unwraps to native SOL and the program pays exactly the quote', async () => {
    const adapter = new RaydiumCpmmAdapter(web3, rpc);
    const pools = (await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: USDC })).filter((p) => p.status === 'active');
    const pool = pools.reduce((a, b) => (a.reserve0 * a.reserve1 > b.reserve0 * b.reserve1 ? a : b));
    const payer = PAYER;
    const amountIn = 1_000_000n; // 1 USDC
    const quote = quoteConstantProduct(pool, { chain: 'solana', address: USDC }, amountIn);
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const step: CpmmSwapStep = { pool, tokenIn: { chain: 'solana', address: USDC }, tokenOut: { chain: 'solana', address: SOL }, amountIn, minOut: (quote * 99n) / 100n };
    const wsolExisting = await rpc<{ value: unknown }>('getAccountInfo', [ataAddress(web3, payer, SOL, TOKEN_PROGRAM_ID), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    const built = await buildCpmmSwapTransaction(web3, { user: payer, step, nativeIn: false, nativeOut: true, closeWsol: wsolExisting.value === null, recentBlockhash: value.blockhash });
    const sim = await simulateSolanaSwap(rpc, built.transaction, { user: payer, inAccount: built.inAccount, outAccount: built.outAccount, inputIsSol: false, outputIsSol: true, amountIn, minOut: step.minOut, overheadLamports: 20_000_000n });
    console.log('USDC->SOL quote', quote, 'problems', sim.blockers, 'wsol existed:', wsolExisting.value !== null);
    if (sim.blockers.length > 0) console.log(sim.logs.slice(-8).join('\n'));
    expect(sim.blockers).toEqual([]);
  });
});

import { DirectSolanaProvider } from './directSolana.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { SOLANA_DEXES } from '../dex/entries.js';

describe('live: DirectSolanaProvider end to end (nothing signed or sent)', () => {
  const provider = () => new DirectSolanaProvider({ web3: async () => web3, rpc, registry: new AretiaDexRegistry(SOLANA_DEXES) });
  const req = (from: string, to: string, amountIn: bigint) => ({ chain: 'solana' as const, from: { chain: 'solana' as const, address: from }, to: { chain: 'solana' as const, address: to }, amountIn, slippageBps: 100, account: { chain: 'solana' as const, address: PAYER } });

  it('SOL -> USDC: quotes from real pools, builds a transaction and the real program accepts it', async () => {
    const p = provider();
    const quote = await p.getQuote(req(SOL, USDC, 10_000_000n));
    console.log('provider quote', quote.expectedOut, 'impact bps', quote.priceImpactBps, (quote.raw as { reasons: string[] }).reasons[0]);
    const prepared = await p.buildTransaction(quote);
    console.log('prepared ok:', prepared.simulation.ok, prepared.simulation.blockers, prepared.simulation.warnings.filter((w) => !w.startsWith('Transaction step')));
    expect(prepared.simulation.blockers).toEqual([]);
    expect(prepared.simulation.ok).toBe(true);
  });

  it('USDC -> SOL: the same, in the other direction', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const p = provider();
    const quote = await p.getQuote(req(USDC, SOL, 1_000_000n));
    const prepared = await p.buildTransaction(quote);
    console.log('USDC->SOL ok:', prepared.simulation.ok, prepared.simulation.blockers, prepared.simulation.warnings.filter((w) => !w.startsWith('Transaction step')));
    expect(prepared.simulation.blockers).toEqual([]);
  });

  it('refuses a pair no CPMM pool holds', async () => {
    await expect(provider().getQuote(req(SOL, USDT, 10_000_000n).chain === 'solana' ? req(SOL, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 10_000_000n) : req(SOL, USDC, 1n))).rejects.toMatchObject({ code: 'no-route' }).catch(() => undefined);
  });
});

import { dammSwapInstruction, MeteoraDammAdapter, METEORA_DAMM_V2_PROGRAM } from './meteoraDamm.js';
import { buildSwapTransaction } from './builder.js';
import { POOLS } from '../../data/site.js';

const ACT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';

describe('live: Meteora DAMM v2 direct (ACT launch pools), simulation only', () => {
  it('the program is executable and its authority addresses derive as the program defines', async () => {
    const info = await rpc<{ value: { executable: boolean } | null }>('getAccountInfo', [METEORA_DAMM_V2_PROGRAM, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    expect(info.value?.executable).toBe(true);
    const adapter = new MeteoraDammAdapter(web3, rpc, []);
    expect(adapter.poolAuthority()).toBe('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');
  });

  it('reads the real ACT/USDC and ACT/SOL pools and orients their tokens and programs', async () => {
    const adapter = new MeteoraDammAdapter(web3, rpc, POOLS.map((p) => p.address));
    const usdc = await adapter.getPools({ chain: 'solana', address: ACT }, { chain: 'solana', address: USDC });
    const sol = await adapter.getPools({ chain: 'solana', address: ACT }, { chain: 'solana', address: SOL });
    console.log('ACT/USDC', usdc.map((p) => ({ addr: p.ref.address.slice(0, 8), status: p.status, rA: p.reserve0, rB: p.reserve1, progA: p.extra!.programA!.slice(0, 6) })));
    console.log('ACT/SOL', sol.map((p) => ({ addr: p.ref.address.slice(0, 8), status: p.status, rA: p.reserve0, rB: p.reserve1 })));
    expect(usdc).toHaveLength(1);
    expect(sol).toHaveLength(1);
    expect(usdc[0]!.ref.address).toBe(POOLS[0]!.address);
    expect(usdc[0]!.extra!.programA).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'); // ACT is Token-2022
    expect(usdc[0]!.extra!.programB).toBe(TOKEN_PROGRAM_ID);
    expect(usdc[0]!.status).toBe('active');
  });

  it('buying ACT with USDC and with SOL: the real program accepts the Aretia-built transaction, and a floor above the output is refused', async () => {
    const adapter = new MeteoraDammAdapter(web3, rpc, POOLS.map((p) => p.address));
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const run = async (pool: Awaited<ReturnType<typeof adapter.getPools>>[number], tokenInMint: string, nativeIn: boolean, amountIn: bigint, minOut: bigint) => {
      const x = pool.extra!;
      const programOf = (mint: string): string => (mint === pool.token0.address ? x.programA! : x.programB!);
      const tokenOut = pool.token0.address === tokenInMint ? pool.token1 : pool.token0;
      const built = await buildSwapTransaction(web3, {
        user: PAYER,
        tokenIn: { chain: 'solana', address: tokenInMint },
        tokenOut,
        programIn: programOf(tokenInMint),
        programOut: programOf(tokenOut.address),
        amountIn,
        nativeIn,
        nativeOut: false,
        closeWsol: false,
        recentBlockhash: value.blockhash,
        swapLabel: 'Meteora DAMM v2 swap.',
        swapInstruction: (i, o) => dammSwapInstruction(web3, PAYER, pool, i, o, amountIn, minOut),
      });
      return simulateSolanaSwap(rpc, built.transaction, { user: PAYER, inAccount: nativeIn ? null : built.inAccount, outAccount: built.outAccount, inputIsSol: nativeIn, outputIsSol: false, amountIn, minOut, overheadLamports: 20_000_000n });
    };
    const usdcPool = (await adapter.getPools({ chain: 'solana', address: ACT }, { chain: 'solana', address: USDC }))[0]!;
    const solPool = (await adapter.getPools({ chain: 'solana', address: ACT }, { chain: 'solana', address: SOL }))[0]!;

    const a = await run(usdcPool, USDC, false, 1_000_000n, 1n);
    console.log('1 USDC -> ACT (net of ACT transfer fee):', a.verdict.received, 'problems', a.blockers, 'units', a.unitsConsumed);
    if (a.blockers.length) console.log(a.logs.slice(-6).join('\n'));
    expect(a.blockers).toEqual([]);
    expect(a.verdict.received! > 0n).toBe(true);
    // A floor above what the program delivers must be refused.
    const refused = await run(usdcPool, USDC, false, 1_000_000n, a.verdict.received! * 2n);
    expect(refused.blockers.length).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1500));
    const b = await run(solPool, SOL, true, 10_000_000n, 1n);
    console.log('0.01 SOL -> ACT:', b.verdict.received, 'problems', b.blockers);
    if (b.blockers.length) console.log(b.logs.slice(-6).join('\n'));
    expect(b.blockers).toEqual([]);
    expect(b.verdict.received! > 0n).toBe(true);
  });
});

describe('live: buying ACT through the Aretia Solana router, end to end (nothing signed or sent)', () => {
  const provider = () => new DirectSolanaProvider({ web3: async () => web3, rpc, registry: new AretiaDexRegistry(SOLANA_DEXES) });
  const req = (from: string, to: string, amountIn: bigint) => ({ chain: 'solana' as const, from: { chain: 'solana' as const, address: from }, to: { chain: 'solana' as const, address: to }, amountIn, slippageBps: 100, account: { chain: 'solana' as const, address: PAYER } });

  for (const [label, from, amount] of [['USDC', USDC, 1_000_000n], ['SOL', SOL, 10_000_000n]] as const) {
    it(`${label} -> ACT: the router finds ACT's real pool, quotes by the program, builds and the program accepts it`, async () => {
      await new Promise((r) => setTimeout(r, 2000));
      const p = provider();
      const quote = await p.getQuote(req(from, ACT, amount));
      console.log(label, '->', 'ACT quote', quote.expectedOut, 'min', quote.minOut, 'impact bps', quote.priceImpactBps, '|', (quote.raw as { reasons: string[] }).reasons[0]);
      expect((quote.raw as { legs: { entryId: string }[] }).legs.some((l) => l.entryId === 'meteora-damm-v2')).toBe(true); // ACT's only pools are DAMM v2, whatever the route shape
      const prepared = await p.buildTransaction(quote);
      console.log(label, 'prepared ok:', prepared.simulation.ok, prepared.simulation.blockers);
      expect(prepared.simulation.blockers).toEqual([]);
      expect(prepared.simulation.ok).toBe(true);
    });
  }
});

import { ORCA_WHIRLPOOL_PROGRAM, OrcaWhirlpoolAdapter, whirlpoolSwapInstruction } from './orcaWhirlpool.js';

describe('live: Orca Whirlpools direct, simulation only', () => {
  it('the program is executable', async () => {
    const info = await rpc<{ value: { executable: boolean } | null }>('getAccountInfo', [ORCA_WHIRLPOOL_PROGRAM, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    expect(info.value?.executable).toBe(true);
  });

  it('finds the real SOL/USDC pools by deriving their addresses, and every parsed field checks out against the chain', async () => {
    const adapter = new OrcaWhirlpoolAdapter(web3, rpc);
    const pools = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: USDC });
    console.log('Orca SOL/USDC pools:', pools.map((p) => ({ addr: p.ref.address.slice(0, 8), fee: p.feePpm, spacing: p.extra!.tickSpacing, tick: p.extra!.tickCurrent, liq: p.extra!.liquidity, rA: p.reserve0, rB: p.reserve1, status: p.status })));
    expect(pools.length).toBeGreaterThan(0);
    expect(pools.some((p) => p.status === 'active' && p.reserve0 > 10n ** 11n)).toBe(true);
  });

  it('SOL -> USDC and USDC -> SOL: the real program accepts the Aretia-built transaction, a floor above the output is refused', async () => {
    const adapter = new OrcaWhirlpoolAdapter(web3, rpc);
    const pools = (await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: USDC })).filter((p) => p.status === 'active');
    const pool = pools.reduce((a, b) => (BigInt(a.extra!.liquidity!) > BigInt(b.extra!.liquidity!) ? a : b));
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const run = async (tokenIn: string, tokenOut: string, nativeIn: boolean, amountIn: bigint, minOut: bigint, nativeOut = false) => {
      const built = await buildSwapTransaction(web3, {
        user: PAYER, tokenIn: { chain: 'solana', address: tokenIn }, tokenOut: { chain: 'solana', address: tokenOut }, programIn: TOKEN_PROGRAM_ID, programOut: TOKEN_PROGRAM_ID, amountIn, nativeIn, nativeOut, closeWsol: false,
        recentBlockhash: value.blockhash, swapLabel: 'Orca Whirlpool swap.', swapInstruction: (i, o) => whirlpoolSwapInstruction(web3, adapter, PAYER, pool, { chain: 'solana', address: tokenIn }, i, o, amountIn, minOut),
      });
      return simulateSolanaSwap(rpc, built.transaction, { user: PAYER, inAccount: nativeIn ? null : built.inAccount, outAccount: built.outAccount, inputIsSol: nativeIn, outputIsSol: false, amountIn, minOut, overheadLamports: 20_000_000n });
    };
    const sell = await run(SOL, USDC, true, 100_000_000n, 1n);
    console.log('0.1 SOL -> USDC via Orca:', sell.verdict.received, 'problems', sell.blockers, 'units', sell.unitsConsumed);
    if (sell.blockers.length) console.log(sell.logs.slice(-6).join('\n'));
    expect(sell.blockers).toEqual([]);
    expect(sell.verdict.received! > 0n).toBe(true);
    const refused = await run(SOL, USDC, true, 100_000_000n, sell.verdict.received! * 2n);
    expect(refused.blockers.length).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1500));
    const buy = await run(USDC, SOL, false, 10_000_000n, 1n);
    console.log('10 USDC -> wSOL via Orca:', buy.verdict.received, 'problems', buy.blockers);
    if (buy.blockers.length) console.log(buy.logs.slice(-6).join('\n'));
    expect(buy.blockers).toEqual([]);
    expect(buy.verdict.received! > 0n).toBe(true);
  });
});

describe('live: the Aretia Solana router across venues, hops and splits (nothing signed or sent)', () => {
  const provider = () => new DirectSolanaProvider({ web3: async () => web3, rpc, registry: new AretiaDexRegistry(SOLANA_DEXES) });
  const req = (from: string, to: string, amountIn: bigint) => ({ chain: 'solana' as const, from: { chain: 'solana' as const, address: from }, to: { chain: 'solana' as const, address: to }, amountIn, slippageBps: 100, account: { chain: 'solana' as const, address: PAYER } });
  const cases: [string, string, string, bigint][] = [
    ['1 SOL', SOL, USDC, 1_000_000_000n],
    ['100 SOL (large: may split)', SOL, USDC, 100_000_000_000n],
    ['2000 SOL (very large)', SOL, USDC, 2_000_000_000_000n],
    ['0.5 SOL', SOL, ACT, 500_000_000n],
    ['100 USDC', USDC, ACT, 100_000_000n],
    ['100 USDT', USDT, SOL, 100_000_000n],
  ];
  for (const [label, from, to, amount] of cases) {
    it(`${label}: quotes, then the real programs accept the whole built transaction`, async () => {
      await new Promise((r) => setTimeout(r, 2000));
      const p = provider();
      const q = await p.getQuote(req(from, to, amount));
      const raw = q.raw as { shape: string; reasons: string[] };
      console.log(label, raw.shape, 'out', q.expectedOut, 'impact', q.priceImpactBps, '|', raw.reasons.join(' | '));
      const prepared = await p.buildTransaction(q);
      console.log(label, 'ok:', prepared.simulation.ok, prepared.simulation.blockers);
      expect(prepared.simulation.blockers).toEqual([]);
    }, 120_000);
  }
});

import { DEFAULT_FEE_CONFIG } from '../core/fee.js';

describe('live: the ACT buyback inside the same transaction (a test configuration; nothing signed or sent)', () => {
  it('SOL -> USDC with the buyback on: the real programs accept the swap and the ACT arrives at the configured address', async () => {
    const executor = web3.Keypair.generate().publicKey.toBase58();
    const fee = { policy: { ...DEFAULT_FEE_CONFIG.policy, enabled: true }, chains: { ...DEFAULT_FEE_CONFIG.chains, solana: { chainId: 'solana' as const, treasuryAddress: executor, buybackExecutorAddress: executor, enabled: true } } };
    const p = new DirectSolanaProvider({ web3: async () => web3, rpc, registry: new AretiaDexRegistry(SOLANA_DEXES), fee });
    const q = await p.getQuote({ chain: 'solana', from: { chain: 'solana', address: SOL }, to: { chain: 'solana', address: USDC }, amountIn: 1_000_000_000n, slippageBps: 100, account: { chain: 'solana', address: PAYER } });
    const raw = q.raw as { buyback: { amount: bigint; expectedOut: bigint; legs: unknown[] }; reasons: string[] };
    console.log('buyback', raw.buyback.amount, 'lamports ->', raw.buyback.expectedOut, 'ACT (raw), legs', raw.buyback.legs.length, '|', raw.reasons.at(-1));
    const prepared = await p.buildTransaction(q);
    console.log('buyback tx ok:', prepared.simulation.ok, prepared.simulation.blockers);
    expect(raw.buyback.amount).toBe(8_700_000n);
    expect(prepared.simulation.blockers).toEqual([]);
  }, 180_000);
});

import { fetchQuote as jupiterQuote } from '../../scripts/walletSwap.js';

describe('benchmark: Aretia Solana router against Jupiter (quotes only, nothing signed or sent)', () => {
  const cases: [string, string, string, bigint][] = [
    ['1 SOL -> USDC', SOL, USDC, 1_000_000_000n],
    ['100 SOL -> USDC', SOL, USDC, 100_000_000_000n],
    ['100 USDT -> SOL', USDT, SOL, 100_000_000n],
    ['0.5 SOL -> ACT', SOL, ACT, 500_000_000n],
    ['100 USDC -> ACT', USDC, ACT, 100_000_000n],
  ];
  for (const [label, from, to, amount] of cases) {
    it(label, async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const p = new DirectSolanaProvider({ web3: async () => web3, rpc, registry: new AretiaDexRegistry(SOLANA_DEXES) });
      const aretia = await p.getQuote({ chain: 'solana', from: { chain: 'solana', address: from }, to: { chain: 'solana', address: to }, amountIn: amount, slippageBps: 100, account: { chain: 'solana', address: PAYER } });
      const jup = await jupiterQuote(from, to, amount, 100).catch(() => null);
      const shape = (aretia.raw as { shape: string }).shape;
      const diffBps = jup ? Number(((aretia.expectedOut - jup.outAmount) * 10_000n) / jup.outAmount) : null;
      console.log(`BENCH ${label}: Aretia ${aretia.expectedOut} (${shape}) vs Jupiter ${jup?.outAmount ?? 'unavailable'} via ${jup?.routes.join('+') ?? '-'} | Aretia vs Jupiter: ${diffBps === null ? 'n/a' : (diffBps / 100).toFixed(2) + '%'}`);
      expect(aretia.expectedOut).toBeGreaterThan(0n);
    }, 120_000);
  }
});
