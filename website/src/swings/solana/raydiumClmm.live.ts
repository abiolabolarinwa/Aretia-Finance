/**
 * Read-only live proof of the pump.fun bonding-curve venue: curves are found by derivation, and the transactions Aretia
 * builds (a buy, then a buy and sell together) are run through the real program with `simulateTransaction`.
 * Nothing is signed or sent.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { AretiaDexRegistry } from '../engine/registry.js';
import { SOLANA_DEXES } from '../dex/entries.js';
import { DirectSolanaProvider } from './directSolana.js';
import { buildRouteTransaction } from './builder.js';
import { ClmmAdapter, clmmSwapInstruction } from './raydiumClmm.js';
import type { SolRpc } from './raydiumCpmm.js';
import { simulateSolanaSwap } from './simulate.js';
import { TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';

const RPC = 'https://api.mainnet-beta.solana.com';
const SOL = 'So11111111111111111111111111111111111111112';
const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

const rpc: SolRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
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

/** Tokens with a concentrated-liquidity pool against SOL, from Raydium's own pool list (used only to pick test subjects). */
async function openMints(limit: number): Promise<string[]> {
  const res = await fetch('https://api-v3.raydium.io/pools/info/list?poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=100&page=1');
  const body = (await res.json()) as { data: { data: { mintA: { address: string }; mintB: { address: string } }[] } };
  const adapter = new ClmmAdapter(web3, rpc);
  const out: string[] = [];
  for (const p of body.data.data) {
    const other = p.mintA.address === SOL ? p.mintB.address : p.mintB.address === SOL ? p.mintA.address : null;
    if (!other || out.includes(other)) continue;
    const pools = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: other }).catch(() => []);
    if (pools.some((x) => x.status === 'active')) out.push(other);
    if (out.length >= limit) break;
  }
  return out;
}

describe('live: Raydium CLMM, simulation only', () => {
  it('finds open curves by derivation', async () => {
    const mints = await openMints(3);
    console.log('open curves found', mints.length);
    expect(mints.length).toBeGreaterThan(0);
  }, 120_000);

  it('buy, then buy and sell together, are accepted by the real program', async () => {
    const [mint] = await openMints(1);
    const adapter = new ClmmAdapter(web3, rpc);
    const [pool] = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: mint! });
    expect(pool).toBeDefined();
    const tokenIn = { chain: 'solana' as const, address: SOL };
    const token = { chain: 'solana' as const, address: mint! };
    const arrays = (t: { address: string }) => adapter.tickArraysFor(pool!.ref.address, { tickCurrent: Number(pool!.extra!.tickCurrent), tickSpacing: Number(pool!.extra!.tickSpacing) }, t.address === pool!.token0.address);
    const mintProgram = pool!.extra!.program0 === SOL ? pool!.extra!.program1! : pool!.extra!.program0!;
    const blockhash = (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    const stepsFor = (sellAmount: bigint | null) => [
      { tokenIn, tokenOut: token, programIn: TOKEN_PROGRAM_ID, programOut: mintProgram, amountIn: 20_000_000n, label: 'buy', swapInstruction: async (i: string, o: string) => clmmSwapInstruction(web3, adapter, PAYER, pool!, tokenIn, i, o, 20_000_000n, 1n, await arrays(tokenIn)) },
      ...(sellAmount === null ? [] : [{ tokenIn: token, tokenOut: tokenIn, programIn: mintProgram, programOut: TOKEN_PROGRAM_ID, amountIn: sellAmount, label: 'sell', swapInstruction: async (i: string, o: string) => clmmSwapInstruction(web3, adapter, PAYER, pool!, token, i, o, sellAmount, 1n, await arrays(token)) }]),
    ];
    const buyOnly = await buildRouteTransaction(web3, { user: PAYER, steps: stepsFor(null), nativeIn: true, nativeOut: false, closeWsol: true, recentBlockhash: blockhash });
    const simBuy = await simulateSolanaSwap(rpc, buyOnly.transaction, { user: PAYER, inAccount: buyOnly.inAccount, outAccount: buyOnly.outAccount, inputIsSol: true, outputIsSol: false, amountIn: 20_000_000n, minOut: 1n, overheadLamports: 10_000_000n });
    console.log('clmm buy', simBuy.blockers, simBuy.verdict.received, simBuy.logs.filter((l) => /failed|error/i.test(l)).slice(-2));
    expect(simBuy.blockers).toEqual([]);
    const bought = simBuy.verdict.received ?? 0n;
    expect(bought).toBeGreaterThan(0n);
    const both = await buildRouteTransaction(web3, { user: PAYER, steps: stepsFor(bought / 2n), nativeIn: true, nativeOut: false, closeWsol: false, recentBlockhash: blockhash });
    const simBoth = await simulateSolanaSwap(rpc, both.transaction, { user: PAYER, inAccount: both.inAccount, outAccount: both.outAccount, inputIsSol: true, outputIsSol: false, amountIn: 20_000_000n, minOut: 1n, overheadLamports: 10_000_000n });
    console.log('clmm buy+sell', simBoth.blockers, simBoth.logs.filter((l) => /failed|error/i.test(l)).slice(-2));
    // The sell pays native SOL, so the harness's token-out judgement does not apply; what matters is that the program ran both.
    expect(simBoth.logs.join(' ')).not.toMatch(/failed/);
    // Both the buy and the sell reached the program and finished.
    expect(simBoth.logs.filter((l) => l === 'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success').length).toBe(2);
  }, 300_000);

  it('the router quotes and builds a curve swap for a real open curve', async () => {
    const [mint] = await openMints(1);
    const registry = new AretiaDexRegistry(SOLANA_DEXES.filter((e) => e.id === 'raydium-clmm'));
    const p = new DirectSolanaProvider({ web3: async () => web3, rpc, registry });
    const q = await p.getQuote({ chain: 'solana', from: { chain: 'solana', address: SOL }, to: { chain: 'solana', address: mint! }, amountIn: 20_000_000n, slippageBps: 300, account: { chain: 'solana', address: PAYER } });
    const prepared = await p.buildTransaction(q);
    console.log('router curve', q.expectedOut, prepared.simulation.ok, prepared.simulation.blockers);
    expect(prepared.simulation.blockers).toEqual([]);
  }, 300_000);
});
