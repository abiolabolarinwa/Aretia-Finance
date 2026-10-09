/**
 * Read-only live proof of the Meteora DBC venue: pools are found through DexScreener hints verified on-chain, and the transactions Aretia
 * builds (a buy, then a buy and sell together) are run through the real program with `simulateTransaction`.
 * Nothing is signed or sent.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { AretiaDexRegistry } from '../engine/registry.js';
import { SOLANA_DEXES } from '../dex/entries.js';
import { DirectSolanaProvider } from './directSolana.js';
import { buildRouteTransaction } from './builder.js';
import { DbcAdapter, dbcSwapInstruction } from './meteoraDbc.js';
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
  for (let attempt = 0; listed === null && attempt < 8; attempt++) {
    const res = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/dexes/meteora-dbc/pools?page=1');
    if (res.ok) listed = (await res.json()) as typeof listed;
    else await new Promise((r) => setTimeout(r, 10_000));
  }
  const adapter = new DbcAdapter(web3, rpc);
  const out: string[] = [];
  for (const p of listed!.data) {
    const mint = p.relationships.base_token.data.id.replace('solana_', '');
    const pools = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: mint }).catch(() => []);
    if (pools.some((x) => x.status === 'active' && x.token1.address === SOL)) out.push(mint);
    if (out.length >= limit) break;
  }
  return out;
}

describe('live: Meteora DBC, simulation only', () => {
  it('finds open curves by derivation', async () => {
    const mints = await openMints(3);
    console.log('dbc open pools found', mints.length);
    expect(mints.length).toBeGreaterThan(0);
  }, 180_000);

  it('buy, then buy and sell together, are accepted by the real program', async () => {
    const [mint] = await openMints(1);
    const adapter = new DbcAdapter(web3, rpc);
    const [pool] = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: mint! });
    expect(pool).toBeDefined();
    const quote = { chain: 'solana' as const, address: SOL };
    const token = { chain: 'solana' as const, address: mint! };
    const baseProgram = pool!.extra!.baseProgram!;
    const blockhash = (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    const stepsFor = (sellAmount: bigint | null) => [
      { tokenIn: quote, tokenOut: token, programIn: TOKEN_PROGRAM_ID, programOut: baseProgram, amountIn: 20_000_000n, label: 'buy', swapInstruction: async (i: string, o: string) => dbcSwapInstruction(web3, adapter, PAYER, pool!, quote, i, o, 20_000_000n, 1n) },
      ...(sellAmount === null ? [] : [{ tokenIn: token, tokenOut: quote, programIn: baseProgram, programOut: TOKEN_PROGRAM_ID, amountIn: sellAmount, label: 'sell', swapInstruction: async (i: string, o: string) => dbcSwapInstruction(web3, adapter, PAYER, pool!, token, i, o, sellAmount, 1n) }]),
    ];
    const buyOnly = await buildRouteTransaction(web3, { user: PAYER, steps: stepsFor(null), nativeIn: true, nativeOut: false, closeWsol: true, recentBlockhash: blockhash });
    const simBuy = await simulateSolanaSwap(rpc, buyOnly.transaction, { user: PAYER, inAccount: buyOnly.inAccount, outAccount: buyOnly.outAccount, inputIsSol: true, outputIsSol: false, amountIn: 20_000_000n, minOut: 1n, overheadLamports: 10_000_000n });
    console.log('dbc buy', simBuy.blockers, simBuy.verdict.received, simBuy.logs.slice(-14));
    expect(simBuy.blockers).toEqual([]);
    const bought = simBuy.verdict.received ?? 0n;
    expect(bought).toBeGreaterThan(0n);
    const both = await buildRouteTransaction(web3, { user: PAYER, steps: stepsFor(bought / 2n), nativeIn: true, nativeOut: true, closeWsol: true, recentBlockhash: blockhash });
    const simBoth = await simulateSolanaSwap(rpc, both.transaction, { user: PAYER, inAccount: both.inAccount, outAccount: both.outAccount, inputIsSol: true, outputIsSol: true, amountIn: 20_000_000n, minOut: 1n, overheadLamports: 10_000_000n });
    console.log('dbc buy+sell', simBoth.blockers, simBoth.logs.filter((l) => /failed|error/i.test(l)).slice(-2));
    expect(simBoth.logs.join(' ')).not.toMatch(/failed/);
  }, 300_000);

  it('the router quotes and builds a curve swap for a real open pool', async () => {
    const [mint] = await openMints(1);
    const registry = new AretiaDexRegistry(SOLANA_DEXES.filter((e) => e.id === 'meteora-dbc'));
    const p = new DirectSolanaProvider({ web3: async () => web3, rpc, registry });
    const q = await p.getQuote({ chain: 'solana', from: { chain: 'solana', address: SOL }, to: { chain: 'solana', address: mint! }, amountIn: 20_000_000n, slippageBps: 300, account: { chain: 'solana', address: PAYER } });
    const prepared = await p.buildTransaction(q);
    console.log('router dbc', q.expectedOut, prepared.simulation.ok, prepared.simulation.blockers);
    expect(prepared.simulation.blockers).toEqual([]);
  }, 300_000);
});
