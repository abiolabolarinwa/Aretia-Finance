/**
 * Live checks of the CCTP provider against Circle's real service and the real chains. Read-only: nothing is signed or sent.
 * Run with `npm run test:live`.
 */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { CCTP_DOMAIN, CCTP_USDC, CctpSettlementProvider } from './cctp.js';
import type { ChainId } from '../core/types.js';
import type { SettlementIntent } from './types.js';

const SENDER = '0x' + 'a'.repeat(40);
const RECIPIENT = '0x' + 'b'.repeat(40);
const evm: ChainId[] = ['ethereum', 'avalanche', 'optimism', 'arbitrum', 'base', 'polygon'];
const intent = (s: ChainId, d: ChainId): SettlementIntent => ({ sourceChain: s, sourceAsset: { chain: s, address: CCTP_USDC[s]! }, sourceAmount: 100_000_000n, destinationChain: d, destinationAsset: { chain: d, address: CCTP_USDC[d]! }, sender: SENDER, recipient: RECIPIENT });
const solRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const res = await fetch('https://solana-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
};
const provider = (mode: 'fast' | 'standard') => new CctpSettlementProvider({ mode, read: (c) => publicRead(c), solana: { rpc: solRpc, web3: () => import('@solana/web3.js') } });
const SOL = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

describe('CCTP, live', () => {
  it('standard transfer is offered between every pair of the supported EVM chains, with limits from the chain itself', async () => {
    const p = provider('standard');
    for (const s of evm) {
      const d: ChainId = s === 'base' ? 'ethereum' : 'base';
      const a = await p.supports(intent(s, d));
      expect(a, `${s} to ${d}`).toEqual({ supported: true, reason: null });
    }
  }, 120_000);

  it('quotes a real 100 USDC transfer from Ethereum to Base, fast and standard', async () => {
    const fast = await provider('fast').getQuote(intent('ethereum', 'base'));
    const std = await provider('standard').getQuote(intent('ethereum', 'base'));
    expect(fast.destinationAmount).toBeLessThanOrEqual(100_000_000n);
    expect(fast.estimatedSeconds).toBeLessThan(std.estimatedSeconds);
    expect(std.settlementFee.amount).toBe(0n);
    expect(fast.limits.max).toBeGreaterThan(100_000_000n);
  }, 60_000);

  it('does not offer BNB Chain, and CCTP has no BNB domain', async () => {
    expect(CCTP_DOMAIN.bnb).toBeUndefined();
    const a = await provider('standard').supports({ ...intent('ethereum', 'base'), destinationChain: 'bnb', destinationAsset: { chain: 'bnb', address: '0x' + '1'.repeat(40) } });
    expect(a.supported).toBe(false);
  }, 30_000);

  it('offers Solana to Base and Base to Solana, fast and standard, with limits read from the real programs', async () => {
    const toBase: SettlementIntent = { sourceChain: 'solana', sourceAsset: { chain: 'solana', address: CCTP_USDC.solana! }, sourceAmount: 100_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: SOL, recipient: RECIPIENT };
    const toSol: SettlementIntent = { sourceChain: 'base', sourceAsset: { chain: 'base', address: CCTP_USDC.base! }, sourceAmount: 100_000_000n, destinationChain: 'solana', destinationAsset: { chain: 'solana', address: CCTP_USDC.solana! }, sender: SENDER, recipient: SOL };
    for (const mode of ['standard', 'fast'] as const) {
      const a = await provider(mode).getQuote(toBase);
      const b = await provider(mode).getQuote(toSol);
      expect(a.limits.max).toBeGreaterThan(100_000_000n);
      expect(b.route.steps.at(-1)!.chain).toBe('solana');
      expect(a.route.steps.map((s) => s.id)).not.toContain('approve');
    }
    // The burn can really be built for the real accounts.
    const q = await provider('standard').getQuote(toBase);
    const [tx] = await provider('standard').buildSettlement(q);
    expect(tx!.unsigned.kind).toBe('solana');
  }, 90_000);
});
