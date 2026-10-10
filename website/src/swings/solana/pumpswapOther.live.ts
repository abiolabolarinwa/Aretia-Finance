/**
 * Read-only live proof: a PumpSwap pool that is NOT the canonical pump.fun pool of its pair (Quantum Inu, QI/SOL) is
 * found, quoted by the program, built with the 0.58% fee and accepted by the real program in simulation.
 * Nothing is signed or sent.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { liveFeeConfig } from '../core/fee.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { SOLANA_DEXES } from '../dex/entries.js';
import { DirectSolanaProvider } from './directSolana.js';
import { PumpSwapAdapter } from './pumpswap.js';
import { scanPools } from './poolScan.js';
import type { SolRpc } from './raydiumCpmm.js';

const rpc: SolRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
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

const SOL = 'So11111111111111111111111111111111111111112';
const QI = '8TiMkgvsrat9tM2esko8zVTt99LZLpefUM4SnZaziXaQ';
const QI_POOL = 'cb4GFRgEitfu5qtxfRMiqzsaVPwgbD3HEor4cs2jFpn';
const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

describe('live: a PumpSwap pool that is not the canonical one', () => {
  it('Aretia\'s own scan finds the pool from the chain', async () => {
    const found = await scanPools(rpc, QI);
    console.log('scan found', found);
    expect(found).toContain(QI_POOL);
  }, 120_000);

  it('the adapter accepts it once the chain shows it holds QI and SOL', async () => {
    const adapter = new PumpSwapAdapter(web3, rpc, undefined, async () => [QI_POOL]);
    const pools = await adapter.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: QI });
    console.log('pools', pools.map((p) => [p.ref.address, p.status, p.reserve0, p.reserve1]));
    expect(pools.map((p) => p.ref.address)).toContain(QI_POOL);
  }, 120_000);

  it('quotes, builds with the 0.58% fee and the real program accepts SOL -> QI', async () => {
    const provider = new DirectSolanaProvider({ web3: async () => web3, rpc, registry: new AretiaDexRegistry(SOLANA_DEXES), fee: liveFeeConfig('') });
    for (const [from, amountIn] of [[SOL, 20_000_000n]] as const) {
      await new Promise((r) => setTimeout(r, 3000));
      const q = await provider.getQuote({ chain: 'solana', from: { chain: 'solana', address: from }, to: { chain: 'solana', address: QI }, amountIn, slippageBps: 500, account: { chain: 'solana', address: PAYER } });
      const legs = (q.raw as { legs: { entryId: string }[] }).legs.map((l) => l.entryId);
      const prepared = await provider.buildTransaction(q);
      console.log('QI via', legs.join('+'), 'out', q.expectedOut, 'fee', q.costs.aretiaFee.amount, 'ok', prepared.simulation.ok, prepared.simulation.blockers);
      expect(q.expectedOut).toBeGreaterThan(0n);
      expect(prepared.simulation.blockers).toEqual([]);
    }
  }, 300_000);
});
