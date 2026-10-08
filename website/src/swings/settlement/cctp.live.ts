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
const provider = (mode: 'fast' | 'standard') => new CctpSettlementProvider({ mode, read: (c) => publicRead(c) });

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
});
