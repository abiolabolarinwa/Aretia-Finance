/**
 * Regression tests for audit finding H-3 (docs/audit/2026-10-full-review, poc/tx-builders/cctp.poc.test.ts): a recovery
 * record written by an attacker must not make the page approve USDC to the attacker or burn USDC to the attacker's
 * recipient. Three independent layers are checked: the builder derives everything from Aretia's tables, the inspector
 * decodes every transaction, and the orchestrator never signs from a saved quote.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CCTP_CONTRACTS, CCTP_USDC, CctpSettlementProvider, cctpTransactionProblems, DEPOSIT_FOR_BURN_V2, MOVE_CAP_RAW } from './cctp.js';
import { buildDepositForBurn, evmAddressBytes32, SOLANA_USDC } from './cctpSolana.js';
import { encodeFunction } from '../engine/abiGeneric.js';
import { transactionProblems } from '../wallet/safety.js';
import { CrossChainOrchestrator, type ExecutionGateway } from '../orchestrator/orchestrator.js';
import { InMemoryExecutionStore } from '../orchestrator/store.js';
import { RecordMirror, restoreFromCode } from '../orchestrator/remote.js';
import { encode } from '../plan/store.js';
import type { ExecutionRecord } from '../orchestrator/states.js';
import type { SettlementIntent, SettlementQuote, SettlementTransaction } from './types.js';

const NOW = 1000;
const VICTIM = '0x' + 'a'.repeat(40);
const ATTACKER = '0x' + 'e'.repeat(40);
const ZERO32 = '0x' + '0'.repeat(64);
const AMOUNT = 100_000_000n;

const provider = (): CctpSettlementProvider => new CctpSettlementProvider({ mode: 'standard', read: (() => async () => '0x') as never, fetchImpl: (async () => new Response('{}')) as never, now: () => NOW });
const intentOf = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: AMOUNT, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: VICTIM, recipient: VICTIM, ...over });
const quoteOf = (over: { intent?: Partial<SettlementIntent>; raw?: Record<string, unknown>; sourceAmount?: bigint } = {}): SettlementQuote => {
  const intent = intentOf(over.intent);
  return {
    id: 'circle-cctp-standard:1000:ethereum:base',
    providerId: 'circle-cctp-standard',
    intent,
    route: { providerId: 'circle-cctp-standard', mechanism: 'm', kind: 'transfer', steps: [] },
    sourceAmount: over.sourceAmount ?? intent.sourceAmount,
    destinationAmount: intent.sourceAmount,
    settlementFee: { chain: 'ethereum', asset: intent.sourceAsset, amount: 0n, description: '' },
    networkFees: null,
    estimatedSeconds: 60,
    limits: { min: 1n, max: 10n ** 12n },
    expiresAt: 9e15,
    risk: { level: 'low', trust: '', factors: [] },
    requirements: [],
    raw: { mode: 'standard', srcDomain: 0, dstDomain: 6, usdc: CCTP_USDC.ethereum, amount: intent.sourceAmount, maxFee: 0n, minFinalityThreshold: 2000, needsApproval: true, tokenMessenger: CCTP_CONTRACTS.tokenMessenger, ...over.raw },
  } as SettlementQuote;
};

describe('H-3: the builder derives contracts from Aretia\'s tables and refuses a quote that disagrees', () => {
  it('PoC variant A: an attacker\'s token messenger in the quote is refused, so no approval to the attacker is built', async () => {
    await expect(provider().buildSettlement(quoteOf({ raw: { tokenMessenger: ATTACKER } }))).rejects.toThrow(/not Circle's token messenger/);
  });

  it('refuses a substituted token, wrong domains, a different kind of transfer, mismatched amounts, an amount over the cap and a fee over the ceiling', async () => {
    const p = provider();
    await expect(p.buildSettlement(quoteOf({ raw: { usdc: ATTACKER } }))).rejects.toThrow(/not native USDC/);
    await expect(p.buildSettlement(quoteOf({ intent: { sourceAsset: { chain: 'ethereum', address: ATTACKER } }, raw: { usdc: ATTACKER } }))).rejects.toThrow(/not for native USDC/);
    await expect(p.buildSettlement(quoteOf({ raw: { dstDomain: 3 } }))).rejects.toThrow(/wrong Circle domains/);
    await expect(p.buildSettlement(quoteOf({ raw: { minFinalityThreshold: 1000 } }))).rejects.toThrow(/different kind/);
    await expect(p.buildSettlement(quoteOf({ raw: { amount: 10_000_000_000n } }))).rejects.toThrow(/amounts do not agree/);
    await expect(p.buildSettlement(quoteOf({ raw: { amount: '100000000' } }))).rejects.toThrow(/amounts do not agree/);
    await expect(p.buildSettlement(quoteOf({ intent: { sourceAmount: 10_000_000_000n } }))).rejects.toThrow(/above the limit/);
    await expect(p.buildSettlement(quoteOf({ intent: { sourceAmount: MOVE_CAP_RAW + 1n } }))).rejects.toThrow(/above the limit/);
    await expect(p.buildSettlement(quoteOf({ raw: { maxFee: 2_000_000n } }))).rejects.toThrow(/fee above the ceiling/); // 2% of the amount
    await expect(p.buildSettlement(quoteOf({ raw: { maxFee: -1n } }))).rejects.toThrow(/fee above the ceiling/);
  });

  it('builds an honest quote: the approval names Circle\'s messenger for exactly the amount, and both pass the inspector', async () => {
    const q = quoteOf();
    const txs = await provider().buildSettlement(q);
    expect(txs.map((t) => t.stepId)).toEqual(['approve', 'burn']);
    for (const t of txs) expect(cctpTransactionProblems(q.intent, t)).toEqual([]);
    const allowed = provider().allowedDestinations('ethereum');
    for (const t of txs) expect(transactionProblems(t.unsigned, { address: VICTIM } as never, { address: VICTIM, chain: 'ethereum', allowedDestinations: allowed })).toEqual([]);
  });
});

describe('H-3: the CCTP inspector decodes every field', () => {
  const evmTx = (stepId: string, to: string, data: string, value = '0x0'): SettlementTransaction => ({ stepId, chain: 'ethereum', description: '', unsigned: { kind: 'evm', chainId: 1, tx: { from: VICTIM, to, data, value } } });
  const burnData = (o: Partial<{ amount: bigint; domain: number; recipient: string; token: string; caller: string; maxFee: bigint; finality: number }> = {}): string => encodeFunction(DEPOSIT_FOR_BURN_V2, [o.amount ?? AMOUNT, o.domain ?? 6, o.recipient ?? '0x' + '0'.repeat(24) + VICTIM.slice(2), o.token ?? CCTP_USDC.ethereum, o.caller ?? ZERO32, o.maxFee ?? 0n, o.finality ?? 2000]);
  const intent = intentOf();

  it('uses Circle\'s V2 depositForBurn selector, the one the builder encodes', () => {
    expect(burnData().slice(0, 10)).toBe('0x8e0250ee');
  });

  it('accepts the honest approval and burn', () => {
    expect(cctpTransactionProblems(intent, evmTx('approve', CCTP_USDC.ethereum!, encodeFunction('approve(address,uint256)', [CCTP_CONTRACTS.tokenMessenger, AMOUNT])))).toEqual([]);
    expect(cctpTransactionProblems(intent, evmTx('burn', CCTP_CONTRACTS.tokenMessenger, burnData()))).toEqual([]);
  });

  it('refuses an approval to another spender, for another amount, or on another token', () => {
    expect(cctpTransactionProblems(intent, evmTx('approve', CCTP_USDC.ethereum!, encodeFunction('approve(address,uint256)', [ATTACKER, AMOUNT])))).toContainEqual(expect.stringMatching(/other than Circle's token messenger/));
    expect(cctpTransactionProblems(intent, evmTx('approve', CCTP_USDC.ethereum!, encodeFunction('approve(address,uint256)', [CCTP_CONTRACTS.tokenMessenger, 2n ** 256n - 1n])))).toContainEqual(expect.stringMatching(/different amount/));
    expect(cctpTransactionProblems(intent, evmTx('approve', ATTACKER, encodeFunction('approve(address,uint256)', [CCTP_CONTRACTS.tokenMessenger, AMOUNT])))).toContainEqual(expect.stringMatching(/not on native USDC/));
    expect(cctpTransactionProblems(intent, evmTx('approve', CCTP_USDC.ethereum!, encodeFunction('increaseAllowance(address,uint256)', [ATTACKER, AMOUNT])))).toContainEqual(expect.stringMatching(/not an approve call/));
    // Dirty high bits in the spender word are not the canonical encoding.
    const dirty = encodeFunction('approve(address,uint256)', [CCTP_CONTRACTS.tokenMessenger, AMOUNT]).replace(/^(0x095ea7b3)000000000000000000000000/, '$1ffffffffffffffffffffffff');
    expect(cctpTransactionProblems(intent, evmTx('approve', CCTP_USDC.ethereum!, dirty))).toContainEqual(expect.stringMatching(/standard form/));
  });

  it('PoC variant B and friends: refuses a burn to another recipient, network, token, caller, contract, fee, finality or amount', () => {
    const one = (data: string, to: string = CCTP_CONTRACTS.tokenMessenger): string[] => cctpTransactionProblems(intent, evmTx('burn', to, data));
    expect(one(burnData({ recipient: '0x' + '0'.repeat(24) + ATTACKER.slice(2) }))).toContainEqual(expect.stringMatching(/different recipient/));
    expect(one(burnData({ domain: 3 }))).toContainEqual(expect.stringMatching(/different network/));
    expect(one(burnData({ token: ATTACKER }))).toContainEqual(expect.stringMatching(/not native USDC/));
    expect(one(burnData({ caller: '0x' + '0'.repeat(24) + ATTACKER.slice(2) }))).toContainEqual(expect.stringMatching(/restricts who may claim/));
    expect(one(burnData(), ATTACKER)).toContainEqual(expect.stringMatching(/not Circle's token messenger/));
    expect(one(burnData({ maxFee: AMOUNT - 1n }))).toContainEqual(expect.stringMatching(/fee above the ceiling/));
    expect(one(burnData({ finality: 1 }))).toContainEqual(expect.stringMatching(/unknown finality/));
    expect(one(burnData({ amount: AMOUNT * 2n }))).toContainEqual(expect.stringMatching(/different amount/));
    expect(one(burnData() + '00')).toContainEqual(expect.stringMatching(/not a depositForBurn call/));
    expect(cctpTransactionProblems(intent, evmTx('burn', CCTP_CONTRACTS.tokenMessenger, burnData(), '0x1'))).toContainEqual(expect.stringMatching(/sends coin/));
    expect(cctpTransactionProblems(intent, { ...evmTx('burn', CCTP_CONTRACTS.tokenMessenger, burnData()), unsigned: { kind: 'evm', chainId: 1, tx: { from: ATTACKER, to: CCTP_CONTRACTS.tokenMessenger, data: burnData() } } })).toContainEqual(expect.stringMatching(/different account/));
  });

  it('checks a Solana burn\'s decoded instruction: owner, token account, recipient and amount', () => {
    const owner = web3.Keypair.generate().publicKey.toBase58();
    const sIntent = intentOf({ sourceChain: 'solana', sourceAsset: { chain: 'solana', address: SOLANA_USDC }, sender: owner });
    const make = (recipient: string, amount = AMOUNT): SettlementTransaction => ({ stepId: 'burn', chain: 'solana', description: '', unsigned: { kind: 'solana', transaction: buildDepositForBurn(web3, { owner, amount, destinationDomain: 6, mintRecipient: evmAddressBytes32(recipient), maxFee: 0n, minFinalityThreshold: 2000, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), messageEventKey: web3.Keypair.generate() }) } });
    expect(cctpTransactionProblems(sIntent, make(VICTIM), web3)).toEqual([]);
    expect(cctpTransactionProblems(sIntent, make(ATTACKER), web3)).toContainEqual(expect.stringMatching(/different recipient/));
    expect(cctpTransactionProblems(sIntent, make(VICTIM, AMOUNT + 1n), web3)).toContainEqual(expect.stringMatching(/different amount/));
    expect(cctpTransactionProblems(sIntent, make(VICTIM))).toContainEqual(expect.stringMatching(/cannot be checked/));
  });
});

describe('H-3: a restored record is never signed from', () => {
  class Gateway implements ExecutionGateway {
    sent: SettlementTransaction[] = [];
    async send(tx: SettlementTransaction): Promise<string> {
      this.sent.push(tx);
      return '0x' + String(this.sent.length).repeat(64);
    }
    async confirmation(): Promise<'confirmed'> {
      return 'confirmed';
    }
  }
  const orchestrator = (store: InMemoryExecutionStore, gateway: Gateway) => new CrossChainOrchestrator({ store, providers: [provider()], gateway, now: () => NOW, sleep: async () => undefined, confirmTimeoutMs: 0 });
  /** The attacker's record, served by a recovery-copy endpoint that accepts anything (as the PoC showed the server does). */
  const crafted = (quote: SettlementQuote, state: ExecutionRecord['state'] = 'QUOTED'): ExecutionRecord => ({ id: 'attacker_chosen_recovery_code_0001', version: 3, state, quote, createdAt: NOW, updatedAt: NOW, steps: {}, executionId: null, destinationTxHash: null, refundTxHash: null, failure: null, needsAttention: null, history: [] });
  const mirrorServing = (rec: ExecutionRecord): RecordMirror => new RecordMirror((async () => new Response(JSON.stringify({ record: JSON.parse(encode(rec)) }))) as unknown as typeof fetch);

  for (const [name, quote] of [
    ['variant A (attacker messenger)', quoteOf({ intent: { recipient: ATTACKER }, raw: { tokenMessenger: ATTACKER } })],
    ['variant B (genuine messenger, attacker recipient)', quoteOf({ intent: { recipient: ATTACKER } })],
  ] as const) {
    for (const state of ['QUOTED', 'AWAITING_SIGNATURE'] as const) {
      it(`${name}, restored in ${state}: Continue retires the record and nothing reaches the wallet`, async () => {
        const store = new InMemoryExecutionStore();
        const gateway = new Gateway();
        const rec = await restoreFromCode('attacker_chosen_recovery_code_0001', mirrorServing(crafted(quote, state)), store);
        const orch = orchestrator(store, gateway);
        expect(orch.canSign(rec.id)).toBe(false);
        const out = await orch.start(rec.id);
        expect(out.state).toBe('EXPIRED');
        expect(out.history.at(-1)!.note).toMatch(/never signs a saved quote/);
        expect(gateway.sent).toEqual([]);
      });
    }
  }

  it('a crafted record claiming the approval was already sent is failed, not continued to the burn', async () => {
    const store = new InMemoryExecutionStore();
    const gateway = new Gateway();
    const rec = { ...crafted(quoteOf({ intent: { recipient: ATTACKER } }), 'AWAITING_SIGNATURE'), steps: { approve: { stepId: 'approve', chain: 'ethereum' as const, status: 'confirmed' as const, hash: '0x' + '9'.repeat(64), updatedAt: NOW } } };
    await store.restore(rec);
    const out = await orchestrator(store, gateway).start(rec.id);
    expect(out.state).toBe('FAILED');
    expect(gateway.sent).toEqual([]);
  });

  it('a quote accepted on this page is signed, after the inspector passed every transaction', async () => {
    const store = new InMemoryExecutionStore();
    const gateway = new Gateway();
    const orch = orchestrator(store, gateway);
    const rec = await orch.create(quoteOf());
    expect(orch.canSign(rec.id)).toBe(true);
    expect((await orch.start(rec.id)).state).toBe('SETTLEMENT_PENDING');
    expect(gateway.sent.map((t) => t.stepId)).toEqual(['approve', 'burn']);
  });

  it('a record overwritten under a fresh id is still built from the quote accepted on this page', async () => {
    const store = new InMemoryExecutionStore();
    const gateway = new Gateway();
    const orch = orchestrator(store, gateway);
    const rec = await orch.create(quoteOf());
    await store.restore({ ...rec, version: rec.version + 5, quote: quoteOf({ intent: { recipient: ATTACKER } }) });
    await orch.start(rec.id);
    const burn = gateway.sent.find((t) => t.stepId === 'burn')!;
    expect((burn.unsigned as { tx: { data: string } }).tx.data.toLowerCase()).not.toContain('e'.repeat(40));
  });
});

describe('the EVM claim must mint to this move (re-audit)', () => {
  const intent = intentOf();
  // Circle's V2 message: header (148 bytes, destination domain at byte 8), then the burn body (mint recipient at body byte 36).
  const message = (domain: number, recipient: string): string => {
    const b = new Uint8Array(148 + 228);
    new DataView(b.buffer).setUint32(8, domain, false);
    b.set(Uint8Array.from(Buffer.from(recipient.slice(2).padStart(64, '0'), 'hex')), 148 + 36);
    return '0x' + Buffer.from(b).toString('hex');
  };
  const claim = (msg: string): SettlementTransaction => ({ stepId: 'mint', chain: 'base', description: '', unsigned: { kind: 'evm', chainId: 8453, tx: { from: VICTIM, to: CCTP_CONTRACTS.messageTransmitter, data: encodeFunction('receiveMessage(bytes,bytes)', [msg, '0x1234']), value: '0x0' } } });

  it('accepts a message that mints to the recipient on the destination', () => {
    expect(cctpTransactionProblems(intent, claim(message(6, VICTIM)))).toEqual([]);
  });
  it('refuses a message that pays someone else, or is for another network, or is too short', () => {
    expect(cctpTransactionProblems(intent, claim(message(6, ATTACKER))).join(' ')).toMatch(/someone other/);
    expect(cctpTransactionProblems(intent, claim(message(3, VICTIM))).join(' ')).toMatch(/different network/);
    expect(cctpTransactionProblems(intent, claim('0xabcd')).join(' ')).toMatch(/too short/);
  });
});
