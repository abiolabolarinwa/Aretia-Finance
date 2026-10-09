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
import { BoopAdapter, boopSwapInstructions } from './boopCurve.js';
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

let listed: { data: { relationships: { base_token: { data: { id: string } } } }[] } | null = null;
async function openMints(limit: number): Promise<string[]> {
  // The public list allows about 30 requests a minute; it is read once, retried when busy, and shared by the tests.
  for (let attempt = 0; listed === null && attempt < 6; attempt++) {
    const res = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/dexes/boop-fun/pools?page=1');
    if (res.ok) listed = (await res.json()) as typeof listed;
    else await new Promise((r) => setTimeout(r, 10_000));
  }
  const body = listed!;
  const adapter = new BoopAdapter(web3, rpc);
  const out: string[] = [];
  for (const p of body.data) {
    const mint = p.relationships.base_token.data.id.replace('solana_', '');
    const pools = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: mint }).catch(() => []);
    if (pools.some((x) => x.status === 'active')) out.push(mint);
    if (out.length >= limit) break;
  }
  return out;
}

describe('live: Boop, simulation only', () => {
  it('finds open curves by derivation', async () => {
    const mints = await openMints(3);
    console.log('open curves found', mints.length);
    expect(mints.length).toBeGreaterThan(0);
  }, 120_000);

  it('buy, then buy and sell together, are accepted by the real program', async () => {
    const [mint] = await openMints(1);
    const adapter = new BoopAdapter(web3, rpc);
    const [pool] = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: mint! });
    expect(pool).toBeDefined();
    const tokenIn = { chain: 'solana' as const, address: SOL };
    const token = { chain: 'solana' as const, address: mint! };
    const mintProgram = TOKEN_PROGRAM_ID;
    const blockhash = (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    const stepsFor = (sellAmount: bigint | null) => [
      { tokenIn, tokenOut: token, programIn: TOKEN_PROGRAM_ID, programOut: mintProgram, amountIn: 20_000_000n, label: 'buy', swapInstruction: async (i: string, o: string) => boopSwapInstructions(web3, adapter, PAYER, pool!, tokenIn, i, o, 20_000_000n, 1n) },
      ...(sellAmount === null ? [] : [{ tokenIn: token, tokenOut: tokenIn, programIn: mintProgram, programOut: TOKEN_PROGRAM_ID, amountIn: sellAmount, label: 'sell', swapInstruction: async (i: string, o: string) => boopSwapInstructions(web3, adapter, PAYER, pool!, token, i, o, sellAmount, 1n) }]),
    ];
    const buyOnly = await buildRouteTransaction(web3, { user: PAYER, steps: stepsFor(null), nativeIn: true, nativeOut: false, closeWsol: true, recentBlockhash: blockhash });
    const simBuy = await simulateSolanaSwap(rpc, buyOnly.transaction, { user: PAYER, inAccount: buyOnly.inAccount, outAccount: buyOnly.outAccount, inputIsSol: true, outputIsSol: false, amountIn: 20_000_000n, minOut: 1n, overheadLamports: 10_000_000n });
    console.log('boop buy', simBuy.blockers, simBuy.verdict.received, simBuy.logs.filter((l) => /failed|error/i.test(l)).slice(-2));
    expect(simBuy.blockers).toEqual([]);
    const bought = simBuy.verdict.received ?? 0n;
    expect(bought).toBeGreaterThan(0n);
    const both = await buildRouteTransaction(web3, { user: PAYER, steps: stepsFor(bought / 2n), nativeIn: true, nativeOut: false, closeWsol: false, recentBlockhash: blockhash });
    const simBoth = await simulateSolanaSwap(rpc, both.transaction, { user: PAYER, inAccount: both.inAccount, outAccount: both.outAccount, inputIsSol: true, outputIsSol: false, amountIn: 20_000_000n, minOut: 1n, overheadLamports: 10_000_000n });
    console.log('boop buy+sell', simBoth.blockers, simBoth.logs.filter((l) => /failed|error/i.test(l)).slice(-2));
    // The sell pays native SOL, so the harness's token-out judgement does not apply; what matters is that the program ran both.
    expect(simBoth.logs.join(' ')).not.toMatch(/failed/);
    // Both the buy and the sell reached the program and finished.
    expect(simBoth.logs.filter((l) => l === 'Program boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4 success').length).toBe(2);
  }, 300_000);

  it('the router quotes and builds a curve swap for a real open curve', async () => {
    const [mint] = await openMints(1);
    const registry = new AretiaDexRegistry(SOLANA_DEXES.filter((e) => e.id === 'boop'));
    const p = new DirectSolanaProvider({ web3: async () => web3, rpc, registry });
    const q = await p.getQuote({ chain: 'solana', from: { chain: 'solana', address: SOL }, to: { chain: 'solana', address: mint! }, amountIn: 20_000_000n, slippageBps: 300, account: { chain: 'solana', address: PAYER } });
    const prepared = await p.buildTransaction(q);
    console.log('router curve', q.expectedOut, prepared.simulation.ok, prepared.simulation.blockers);
    expect(prepared.simulation.blockers).toEqual([]);
  }, 300_000);
});
