/**
 * Aretia's Move USDC fee: 0.1% (MOVE_FEE_BPS) of the amount entered, ADDED ON TOP, on every CCTP move, both routes, every source
 * chain. The amount entered is what the recipient receives (Circle's fee is added on top as well). These tests pin the math, the
 * steps and their order, the inspector, the "never pay a fee for a move that cannot happen" and "never twice" rules, the Solana
 * transaction, and the hardening against restored or crafted quotes.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CCTP_CONTRACTS, CCTP_USDC, CctpSettlementProvider, cctpSettlementProblems, cctpTransactionProblems, circleFeeOnTop, DEPOSIT_FOR_BURN_V2, feeFor, largestEnteredFor, MOVE_CAP_RAW, MOVE_FEE_BPS, moveFeeFor, moveTotalFor, normaliseEvmFeeAddress } from './cctp.js';
import { buildDepositForBurn, evmAddressBytes32, SOLANA_USDC, solanaFeeUsdcAccount, TOKEN_MESSENGER_MINTER_V2 } from './cctpSolana.js';
import { assessSettlement, type SafetyContext } from './safety.js';
import { encodeFunction } from '../engine/abiGeneric.js';
import { MOVE_FEE_PERCENT } from '../core/fee.js';
import { SwingsError, type ChainId } from '../core/types.js';
import { viewQuote } from '../crosschain/view.js';
import { CrossChainOrchestrator, type ExecutionGateway } from '../orchestrator/orchestrator.js';
import { InMemoryExecutionStore } from '../orchestrator/store.js';
import { MoveFeeLedger, moveFeeKey, MOVE_FEE_PAID_WINDOW_MS } from '../orchestrator/feeLedger.js';
import { transactionProblems } from '../wallet/safety.js';
import { ataAddress, SWAP_FEE_WALLET, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, transferCheckedInstruction } from '../../scripts/walletTools.js';
import type { SettlementIntent, SettlementQuote, SettlementTransaction } from './types.js';

const NOW = 5_000_000;
const SENDER = '0x' + 'a'.repeat(40);
const ATTACKER = '0x' + 'e'.repeat(40);
const FEE_ADDRESS = '0x' + '7'.repeat(40);
const ZERO32 = '0x' + '0'.repeat(64);
const USDC = 1_000_000n;
const word = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const sel = (sig: string, args: unknown[]): string => encodeFunction(sig, args).slice(0, 10);

const intent = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 1_000n * USDC, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: SENDER, recipient: SENDER, ...over });

/** Circle's service and the source chain. `simulate` decides whether the burn's eth_call succeeds, call by call. */
function evmWorld(o: { allowance?: bigint; simulate?: () => boolean; feeAddress?: string | null; circleBps?: number } = {}) {
  const calls = { simulations: 0 };
  const read = () => async (_m: string, params: unknown[]): Promise<unknown> => {
    const data = String((params[0] as { data: string }).data);
    if (data.startsWith(sel('burnLimitsPerMessage(address)', [CCTP_USDC.ethereum]))) return word(10n ** 12n);
    if (data.startsWith(sel('allowance(address,address)', [SENDER, CCTP_CONTRACTS.tokenMessenger]))) return word(o.allowance ?? 0n);
    if (data.startsWith(sel('usedNonces(bytes32)', [ZERO32]))) return word(0n);
    if (data.startsWith('0x8e0250ee')) {
      calls.simulations++;
      if (o.simulate && !o.simulate()) throw new Error('execution reverted: ERC20: transfer amount exceeds balance');
      return '0x';
    }
    throw new Error('unexpected read ' + data.slice(0, 10));
  };
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status });
    if (u.includes('/fees/')) return json([{ finalityThreshold: 1000, minimumFee: o.circleBps ?? 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]);
    if (u.includes('/allowance')) return json({ allowance: 10_000_000 });
    return json({}, 404);
  }) as unknown as typeof fetch;
  const provider = (mode: 'fast' | 'standard' = 'standard') => new CctpSettlementProvider({ mode, read: read as never, fetchImpl, now: () => NOW, simulateRetryMs: 0, ...(o.feeAddress === null ? {} : { evmFeeAddress: o.feeAddress ?? FEE_ADDRESS }) });
  return { provider, calls };
}

describe('the fee math', () => {
  it('is 10 bps of the amount entered, rounded up: 1,000 USDC pays 1 USDC, one raw unit pays one raw unit', () => {
    expect(MOVE_FEE_BPS).toBe(10);
    expect(MOVE_FEE_PERCENT).toBe('0.1%');
    expect(moveFeeFor(1_000n * USDC)).toBe(1n * USDC);
    expect(moveFeeFor(1n)).toBe(1n);
    expect(moveFeeFor(10_000n)).toBe(10n);
    expect(moveFeeFor(10_001n)).toBe(11n);
    expect(moveFeeFor(0n)).toBe(0n);
    expect(moveFeeFor(MOVE_CAP_RAW)).toBe(10n * USDC);
  });

  it('adds Circle\'s fee on top so the burn always mints at least the amount entered', () => {
    for (const entered of [1n, 999n, 1_000n * USDC, 7_777_777_777n, MOVE_CAP_RAW]) {
      for (const bps of [0, 1, 1.3, 14]) {
        const m = circleFeeOnTop(entered, bps);
        expect(m).toBeGreaterThanOrEqual(feeFor(entered + m, bps));
        expect(entered + m - feeFor(entered + m, bps)).toBeGreaterThanOrEqual(entered);
      }
    }
    expect(moveTotalFor(1_000n * USDC, 0)).toBe(1_001n * USDC);
  });

  it('finds the largest amount a balance can move, fees on top', () => {
    for (const [balance, bps] of [[1_001n * USDC, 0], [1_001n * USDC - 1n, 0], [5_000_123_456n, 1.3], [2n, 0], [1n, 0]] as const) {
      const most = largestEnteredFor(balance, bps);
      if (most > 0n) expect(moveTotalFor(most, bps)).toBeLessThanOrEqual(balance);
      expect(moveTotalFor(most + 1n, bps)).toBeGreaterThan(balance);
    }
    expect(largestEnteredFor(1_001n * USDC, 0)).toBe(1_000n * USDC);
  });
});

describe('the quote: amount entered, Aretia fee, Circle fee, amount received', () => {
  it('standard, 1,000 USDC entered: the recipient gets at least 1,000, the fee is 1, the user sends 1,001', async () => {
    const q = await evmWorld().provider('standard').getQuote(intent());
    expect(q.sourceAmount).toBe(1_000n * USDC);
    expect(q.destinationAmount).toBe(1_000n * USDC);
    expect(q.aretiaFee!.amount).toBe(1n * USDC);
    expect(q.settlementFee.amount).toBe(0n);
    expect(q.sourceTotal).toBe(1_001n * USDC);
    expect(q.route.steps.map((s) => s.id)).toEqual(['approve', 'fee', 'burn', 'attest', 'mint']);
  });

  it('fast, 1,000 USDC entered: Circle\'s largest fee is added on top too, and the recipient still gets at least 1,000', async () => {
    const q = await evmWorld().provider('fast').getQuote(intent());
    const circle = circleFeeOnTop(1_000n * USDC, 1.3);
    expect(q.settlementFee.amount).toBe(circle);
    expect(q.destinationAmount).toBe(1_000n * USDC);
    expect(q.sourceTotal).toBe(1_001n * USDC + circle);
  });

  it('is shown line by line: amount entered, Aretia fee 0.1%, Circle fee, amount received, and the total sent', async () => {
    const v = viewQuote(await evmWorld().provider('fast').getQuote(intent()), NOW);
    expect(v.amountEntered).toBe('1000 USDC');
    expect(v.youSend).toBe(`1001.130017 USDC on Ethereum`);
    expect(v.youReceive).toBe('at least 1000 USDC on Base');
    expect(v.fees[0]).toEqual({ label: 'Aretia fee (0.1%)', value: '1 USDC, added on top' });
    expect(v.fees[1]).toEqual({ label: 'Circle fee', value: 'at most 0.130017 USDC, added on top' });
    expect(v.requirements.join(' ')).toMatch(/Aretia's fee of 0\.1% \(1 USDC\) is added on top/);
  });

  it('refuses a move from an EVM chain when no fee address is configured, and never uses a default', async () => {
    const p = evmWorld({ feeAddress: null }).provider();
    expect((await p.supports(intent())).reason).toMatch(/fee address for EVM networks is not set up/);
    await expect(p.getQuote(intent())).rejects.toThrow(/not set up/);
    expect(normaliseEvmFeeAddress('0x' + '0'.repeat(40))).toBeNull();
    expect(normaliseEvmFeeAddress('not an address')).toBeNull();
    expect(evmWorld({ feeAddress: '0x' + '0'.repeat(40) }).provider().evmFeeAddress).toBeNull();
    // A quote made with a configured address cannot be built by a provider without one.
    const q = await evmWorld().provider().getQuote(intent());
    await expect(p.buildSettlement(q)).rejects.toThrow(/not set up/);
  });
});

describe('the balance must cover the amount plus the fees', () => {
  const ctx = (q: SettlementQuote, p: CctpSettlementProvider, balance: bigint): SafetyContext => ({ now: NOW, provider: p, enabledChains: ['ethereum', 'base'], sourceBalance: balance, destinationNativeBalance: 10n ** 16n, existing: [], maxAmount: MOVE_CAP_RAW });
  it('exactly enough passes; one raw unit short is refused, with the largest amount that fits', async () => {
    const p = evmWorld().provider('standard');
    const q = await p.getQuote(intent());
    expect(assessSettlement(q, ctx(q, p, 1_001n * USDC)).verdict).toBe('allow');
    const short = assessSettlement(q, ctx(q, p, 1_001n * USDC - 1n));
    expect(short.verdict).toBe('block');
    expect(short.blockers.join(' ')).toMatch(/less than the 1001 USDC this move needs/);
    expect(short.blockers.join(' ')).toMatch(new RegExp(`most you can move with your balance is ${(Number(largestEnteredFor(1_001n * USDC - 1n, 0)) / 1e6).toString().replace('.', '\\.')} USDC`));
    // Holding just the amount entered is not enough any more.
    expect(assessSettlement(q, ctx(q, p, 1_000n * USDC)).verdict).toBe('block');
  });

  it('the cap applies to the amount entered: 10,000 USDC passes and builds, 10,000.000001 is refused', async () => {
    const p = evmWorld().provider('fast');
    const q = await p.getQuote(intent({ sourceAmount: MOVE_CAP_RAW }));
    expect(assessSettlement(q, ctx(q, p, 20_000n * USDC)).verdict).toBe('allow');
    const txs = await p.buildSettlement(q);
    const burn = txs.find((t) => t.stepId === 'burn')!;
    // The burn exceeds the cap by Circle's fee only, and the inspector accepts it.
    expect((burn.unsigned as { tx: { data: string } }).tx.data).toBe(encodeFunction(DEPOSIT_FOR_BURN_V2, [MOVE_CAP_RAW + q.settlementFee.amount, 6, '0x' + '0'.repeat(24) + SENDER.slice(2), CCTP_USDC.ethereum, ZERO32, q.settlementFee.amount, 1000]));
    const over = await p.getQuote(intent({ sourceAmount: MOVE_CAP_RAW + 1n }));
    expect(assessSettlement(over, ctx(over, p, 20_000n * USDC)).blockers.join(' ')).toMatch(/above the limit/);
    await expect(p.buildSettlement(over)).rejects.toThrow(/above the limit/);
  });
});

describe('the EVM steps and the inspector', () => {
  const ENTERED = 1_000n * USDC;
  const FEE = moveFeeFor(ENTERED);
  const i = intent();
  const tx = (stepId: string, to: string, data: string, over: Partial<{ from: string; value: string; chainId: number }> = {}): SettlementTransaction => ({ stepId, chain: 'ethereum', description: '', unsigned: { kind: 'evm', chainId: over.chainId ?? 1, tx: { from: over.from ?? SENDER, to, data, value: over.value ?? '0x0' } } });
  const fee = (to = FEE_ADDRESS, amount = FEE, token = CCTP_USDC.ethereum!) => tx('fee', token, encodeFunction('transfer(address,uint256)', [to, amount]));
  const approve = (amount: bigint) => tx('approve', CCTP_USDC.ethereum!, encodeFunction('approve(address,uint256)', [CCTP_CONTRACTS.tokenMessenger, amount]));
  const burn = (maxFee = 0n) => tx('burn', CCTP_CONTRACTS.tokenMessenger, encodeFunction(DEPOSIT_FOR_BURN_V2, [ENTERED + maxFee, 6, '0x' + '0'.repeat(24) + SENDER.slice(2), CCTP_USDC.ethereum, ZERO32, maxFee, maxFee > 0n ? 1000 : 2000]));
  const problems = (t: SettlementTransaction, feeAddress: string | null = FEE_ADDRESS) => cctpTransactionProblems(i, t, undefined, feeAddress);

  it('builds approve (exactly the burn), then the fee, then the burn, and the inspector accepts them', async () => {
    const p = evmWorld().provider('fast');
    const q = await p.getQuote(intent());
    const txs = await p.buildSettlement(q);
    expect(txs.map((t) => t.stepId)).toEqual(['approve', 'fee', 'burn']);
    const burnAmount = ENTERED + q.settlementFee.amount;
    expect((txs[0]!.unsigned as { tx: { data: string } }).tx.data).toBe(encodeFunction('approve(address,uint256)', [CCTP_CONTRACTS.tokenMessenger, burnAmount]));
    expect((txs[1]!.unsigned as { tx: { data: string; to: string } }).tx).toMatchObject({ to: CCTP_USDC.ethereum, data: encodeFunction('transfer(address,uint256)', [FEE_ADDRESS, FEE]) });
    expect(cctpSettlementProblems(q.intent, txs, undefined, FEE_ADDRESS)).toEqual([]);
  });

  it('accepts the honest fee step and refuses a wrong recipient, amount, token, sender, value, network or a missing fee address', () => {
    expect(problems(fee())).toEqual([]);
    expect(problems(fee(ATTACKER)).join(' ')).toMatch(/not Aretia's fee address/);
    expect(problems(fee(FEE_ADDRESS, FEE + 1n)).join(' ')).toMatch(/not 0\.1% of this move/);
    expect(problems(fee(FEE_ADDRESS, FEE - 1n)).join(' ')).toMatch(/not 0\.1% of this move/);
    expect(problems(fee(FEE_ADDRESS, FEE, ATTACKER)).join(' ')).toMatch(/not paid in native USDC/);
    expect(problems(tx('fee', CCTP_USDC.ethereum!, encodeFunction('transfer(address,uint256)', [FEE_ADDRESS, FEE]), { from: ATTACKER })).join(' ')).toMatch(/different account/);
    expect(problems(tx('fee', CCTP_USDC.ethereum!, encodeFunction('transfer(address,uint256)', [FEE_ADDRESS, FEE]), { value: '0x1' })).join(' ')).toMatch(/sends coin/);
    expect(problems(tx('fee', CCTP_USDC.ethereum!, encodeFunction('transfer(address,uint256)', [FEE_ADDRESS, FEE]), { chainId: 8453 })).join(' ')).toMatch(/different network/);
    expect(problems(tx('fee', CCTP_USDC.ethereum!, encodeFunction('approve(address,uint256)', [FEE_ADDRESS, FEE]))).join(' ')).toMatch(/not a USDC transfer/);
    expect(problems(tx('fee', CCTP_USDC.ethereum!, encodeFunction('transferFrom(address,address,uint256)', [SENDER, FEE_ADDRESS, FEE]))).join(' ')).toMatch(/not a USDC transfer/);
    expect(problems(fee(), null).join(' ')).toMatch(/fee address is not set up/);
  });

  it('refuses two fee steps, no fee step, the steps out of order, or an approval that is not exactly the burn', () => {
    const set = (txs: SettlementTransaction[]) => cctpSettlementProblems(i, txs, undefined, FEE_ADDRESS);
    expect(set([approve(ENTERED), fee(), burn()])).toEqual([]);
    expect(set([fee(), burn()])).toEqual([]);
    expect(set([approve(ENTERED), fee(), fee(), burn()]).join(' ')).toMatch(/exactly once/);
    expect(set([approve(ENTERED), burn()]).join(' ')).toMatch(/exactly once/);
    expect(set([approve(ENTERED), burn(), fee()]).join(' ')).toMatch(/in that order/);
    // Approving the amount plus Aretia's fee, or the amount entered when the burn carries Circle's fee: refused.
    expect(set([approve(ENTERED + FEE), fee(), burn()]).join(' ')).toMatch(/exactly the amount the burn takes/);
    expect(set([approve(ENTERED), fee(), burn(130_017n)]).join(' ')).toMatch(/exactly the amount the burn takes/);
    expect(set([approve(ENTERED + 130_017n), fee(), burn(130_017n)])).toEqual([]);
    // Per transaction: an approval above the amount by more than Circle's fee ceiling, or below it, is refused.
    expect(problems(approve(ENTERED * 2n)).join(' ')).toMatch(/different amount/);
    expect(problems(approve(ENTERED - 1n)).join(' ')).toMatch(/different amount/);
  });

  it('refuses a burn that would deliver less than the amount entered', () => {
    const short = tx('burn', CCTP_CONTRACTS.tokenMessenger, encodeFunction(DEPOSIT_FOR_BURN_V2, [ENTERED - FEE, 6, '0x' + '0'.repeat(24) + SENDER.slice(2), CCTP_USDC.ethereum, ZERO32, 0n, 2000]));
    expect(problems(short).join(' ')).toMatch(/different amount/);
    const feeEaten = tx('burn', CCTP_CONTRACTS.tokenMessenger, encodeFunction(DEPOSIT_FOR_BURN_V2, [ENTERED, 6, '0x' + '0'.repeat(24) + SENDER.slice(2), CCTP_USDC.ethereum, ZERO32, 130_000n, 1000]));
    expect(problems(feeEaten).join(' ')).toMatch(/different amount/);
  });
});

describe('a fee is never paid for a move that cannot happen, and never twice', () => {
  class Gateway implements ExecutionGateway {
    sent: string[] = [];
    outcome = new Map<string, 'confirmed' | 'failed'>();
    failBurn = false;
    n = 0;
    async send(t: SettlementTransaction): Promise<string> {
      this.sent.push(t.stepId);
      const h = '0x' + String(++this.n).padStart(64, '0');
      this.outcome.set(h, t.stepId === 'burn' && this.failBurn ? 'failed' : 'confirmed');
      return h;
    }
    async confirmation(_c: ChainId, h: string): Promise<'confirmed' | 'failed' | 'pending'> {
      return this.outcome.get(h) ?? 'pending';
    }
  }
  const orch = (p: CctpSettlementProvider, g: Gateway, ledger = new MoveFeeLedger(null, () => NOW)) => new CrossChainOrchestrator({ store: new InMemoryExecutionStore(), providers: [p], gateway: g, now: () => NOW, sleep: async () => undefined, confirmTimeoutMs: 0, feeLedger: ledger });

  it('when the burn simulation fails, the approval may go but the fee and the burn do not', async () => {
    const w = evmWorld({ simulate: () => false });
    const p = w.provider();
    const g = new Gateway();
    const o = orch(p, g);
    const rec = await o.create(await p.getQuote(intent()));
    await expect(o.start(rec.id)).rejects.toThrow(/neither Aretia's fee nor the transfer was sent/);
    expect(g.sent).toEqual(['approve']);
    expect(w.calls.simulations).toBe(3); // asked three times before it counts
    expect((await o.get(rec.id))!.steps['fee']).toBeUndefined();
  });

  it('with no approval needed, a failing simulation sends nothing at all', async () => {
    const p = evmWorld({ allowance: 10n ** 12n, simulate: () => false }).provider();
    const g = new Gateway();
    const o = orch(p, g);
    const rec = await o.create(await p.getQuote(intent()));
    await expect(o.start(rec.id)).rejects.toBeInstanceOf(SwingsError);
    expect(g.sent).toEqual([]);
  });

  it('simulates before the fee and again before the burn; if the second check fails, the fee is not charged again on retry', async () => {
    let n = 0;
    const p = evmWorld({ allowance: 10n ** 12n, simulate: () => ++n === 1 || n > 4 }).provider();
    const g = new Gateway();
    const o = orch(p, g);
    const rec = await o.create(await p.getQuote(intent()));
    await expect(o.start(rec.id)).rejects.toThrow(/already paid and is not charged again/);
    expect(g.sent).toEqual(['fee']);
    const out = await o.start(rec.id);
    expect(out.state).toBe('SETTLEMENT_PENDING');
    expect(g.sent).toEqual(['fee', 'burn']);
  });

  it('a burn that fails on the network leaves the fee recorded: a new quote for the same move skips the fee, until a burn confirms', async () => {
    const p = evmWorld({ allowance: 10n ** 12n }).provider();
    const g = new Gateway();
    const ledger = new MoveFeeLedger(null, () => NOW);
    const o = orch(p, g, ledger);
    g.failBurn = true;
    const first = await o.create(await p.getQuote(intent()));
    expect((await o.start(first.id)).state).toBe('FAILED');
    expect(g.sent).toEqual(['fee', 'burn']);
    const paidHash = (await o.get(first.id))!.steps['fee']!.hash!;
    expect(ledger.paid(moveFeeKey(intent()))).toBe(paidHash);

    g.failBurn = false;
    const second = await o.create(await p.getQuote(intent()));
    const done = await o.start(second.id);
    expect(done.state).toBe('SETTLEMENT_PENDING');
    expect(g.sent).toEqual(['fee', 'burn', 'burn']); // no second fee
    expect(done.steps['fee']).toMatchObject({ status: 'confirmed', hash: paidHash });
    expect(ledger.paid(moveFeeKey(intent()))).toBeNull(); // spent once the burn confirmed

    const third = await o.create(await p.getQuote(intent()));
    await o.start(third.id);
    expect(g.sent).toEqual(['fee', 'burn', 'burn', 'fee', 'burn']); // a genuinely new move pays again
  });

  it('a paid fee only covers the same chain, sender and amount, and lapses after its window', () => {
    let t = NOW;
    const ledger = new MoveFeeLedger(null, () => t);
    ledger.markPaid(moveFeeKey(intent()), '0x01');
    expect(ledger.paid(moveFeeKey(intent({ sourceAmount: 999n * USDC })))).toBeNull();
    expect(ledger.paid(moveFeeKey(intent({ sender: '0x' + 'c'.repeat(40) })))).toBeNull();
    expect(ledger.paid(moveFeeKey(intent({ sender: SENDER.toUpperCase().replace('0X', '0x') })))).toBe('0x01');
    t += MOVE_FEE_PAID_WINDOW_MS;
    expect(ledger.paid(moveFeeKey(intent()))).toBeNull();
  });
});

describe('restored and crafted quotes: the fee comes from the constant, never the record', () => {
  it('refuses to build a quote whose stored fee or burn disagrees with 0.1% added on top', async () => {
    const p = evmWorld().provider();
    const q = await p.getQuote(intent());
    const raw = q.raw as Record<string, unknown>;
    await expect(p.buildSettlement({ ...q, raw: { ...raw, aretiaFee: 0n } })).rejects.toThrow(/Aretia fee is not 0\.1%/);
    await expect(p.buildSettlement({ ...q, aretiaFee: { ...q.aretiaFee!, amount: 1n } })).rejects.toThrow(/Aretia fee is not 0\.1%/);
    await expect(p.buildSettlement({ ...q, aretiaFee: undefined })).rejects.toThrow(/Aretia fee is not 0\.1%/);
    await expect(p.buildSettlement({ ...q, raw: { ...raw, burnAmount: (raw.burnAmount as bigint) - 1n } })).rejects.toThrow(/amounts do not agree/);
  });

  it('a restored record is retired, and the new quote carries the fee worked out again from the constant', async () => {
    const p = evmWorld().provider();
    const q = await p.getQuote(intent());
    const forged = { ...q, aretiaFee: { ...q.aretiaFee!, amount: 0n }, raw: { ...(q.raw as object), aretiaFee: 0n } } as SettlementQuote;
    const store = new InMemoryExecutionStore();
    const rec = { id: 'x_restored_record_0001', version: 1, state: 'QUOTED' as const, quote: forged, createdAt: NOW, updatedAt: NOW, steps: {}, executionId: null, destinationTxHash: null, refundTxHash: null, failure: null, needsAttention: null, history: [] };
    await store.restore(rec);
    const sent: string[] = [];
    const o = new CrossChainOrchestrator({ store, providers: [p], gateway: { send: async (t) => (sent.push(t.stepId), '0x' + '1'.repeat(64)), confirmation: async () => 'confirmed' }, now: () => NOW, sleep: async () => undefined, confirmTimeoutMs: 0, feeLedger: new MoveFeeLedger(null) });
    expect((await o.start(rec.id)).state).toBe('EXPIRED');
    expect(sent).toEqual([]);
    const again = await p.getQuote(forged.intent);
    expect(again.aretiaFee!.amount).toBe(moveFeeFor(forged.intent.sourceAmount));
  });
});

describe('from Solana: the fee rides inside the burn transaction', () => {
  const OWNER = web3.Keypair.generate().publicKey.toBase58();
  const EVM_RECIPIENT = '0x' + 'ab'.repeat(20);
  const solIntent = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({ sourceChain: 'solana', sourceAsset: { chain: 'solana', address: SOLANA_USDC }, sourceAmount: 1_000n * USDC, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: OWNER, recipient: EVM_RECIPIENT, ...over });
  const FEE_ATA = solanaFeeUsdcAccount(web3);
  const OWNER_ATA = ataAddress(web3, OWNER, SOLANA_USDC, TOKEN_PROGRAM_ID);

  function solWorld(o: { feeAccount?: 'ok' | 'missing' | 'wrong-owner' } = {}) {
    const localToken = new Uint8Array(130);
    new DataView(localToken.buffer).setBigUint64(72, 10n ** 12n, true);
    const feeAccount = new Uint8Array(165);
    feeAccount.set(new web3.PublicKey(SOLANA_USDC).toBytes(), 0);
    feeAccount.set(new web3.PublicKey(o.feeAccount === 'wrong-owner' ? OWNER : SWAP_FEE_WALLET).toBytes(), 32);
    const rpc = (async (method: string, params: unknown[]) => {
      if (method === 'getLatestBlockhash') return { value: { blockhash: web3.Keypair.generate().publicKey.toBase58() } };
      if (method === 'getAccountInfo') {
        const a = String(params[0]);
        if (a === FEE_ATA) return { value: o.feeAccount === 'missing' ? null : { data: [Buffer.from(feeAccount).toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID } };
        return { value: { data: [Buffer.from(localToken).toString('base64'), 'base64'], owner: TOKEN_MESSENGER_MINTER_V2 } };
      }
      throw new Error('unexpected rpc ' + method);
    }) as never;
    const fetchImpl = (async (url: string) => (String(url).includes('/fees/') ? new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }])) : new Response(JSON.stringify({ allowance: 10_000_000 })))) as unknown as typeof fetch;
    return new CctpSettlementProvider({ mode: 'standard', read: (() => async () => '0x') as never, fetchImpl, now: () => NOW, solana: { rpc, web3: async () => web3 } });
  }

  const burnTx = (o: { feeTo?: string; feeAmount?: bigint; extra?: web3.TransactionInstruction[]; noFee?: boolean } = {}): SettlementTransaction => {
    const t = buildDepositForBurn(web3, { owner: OWNER, amount: 1_000n * USDC, destinationDomain: 6, mintRecipient: evmAddressBytes32(EVM_RECIPIENT), maxFee: 0n, minFinalityThreshold: 2000, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), messageEventKey: web3.Keypair.generate(), ...(o.noFee ? {} : { aretiaFee: { destination: o.feeTo ?? FEE_ATA, amount: o.feeAmount ?? USDC } }) });
    for (const ix of o.extra ?? []) t.add(ix);
    return { stepId: 'burn', chain: 'solana', description: '', unsigned: { kind: 'solana', transaction: t } };
  };
  const problems = (t: SettlementTransaction) => cctpTransactionProblems(solIntent(), t, web3);

  it('builds one transaction holding exactly one TransferChecked of the fee to the fee wallet\'s USDC account, and the burn', async () => {
    const p = solWorld();
    const q = await p.getQuote(solIntent());
    expect(q.aretiaFee!.amount).toBe(USDC);
    expect(q.sourceTotal).toBe(1_001n * USDC);
    expect(q.route.steps.map((s) => s.id)).toEqual(['burn', 'attest', 'mint']);
    const txs = await p.buildSettlement(q);
    expect(txs).toHaveLength(1);
    const t = (txs[0]!.unsigned as { transaction: web3.Transaction }).transaction;
    const fees = t.instructions.filter((ix) => ix.programId.toBase58() === TOKEN_PROGRAM_ID);
    expect(fees).toHaveLength(1);
    expect(fees[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual([OWNER_ATA, SOLANA_USDC, FEE_ATA, OWNER]);
    expect(Buffer.from(fees[0]!.data).readBigUInt64LE(1)).toBe(USDC);
    expect(cctpTransactionProblems(q.intent, txs[0]!, web3)).toEqual([]);
    expect(await p.permittedTokenTransfer(q)).toMatchObject({ source: OWNER_ATA, destination: FEE_ATA, amount: USDC, owner: OWNER });
  });

  it('the inspector refuses the fee to another account, another amount, two fee transfers, no fee, or a Token-2022 instruction', () => {
    expect(problems(burnTx())).toEqual([]);
    expect(problems(burnTx({ feeTo: ataAddress(web3, OWNER, SOLANA_USDC, TOKEN_PROGRAM_ID) })).join(' ')).toMatch(/not Aretia's USDC fee account/);
    expect(problems(burnTx({ feeAmount: USDC - 1n })).join(' ')).toMatch(/not 0\.1% of this move/);
    expect(problems(burnTx({ noFee: true })).join(' ')).toMatch(/exactly once/);
    const second = transferCheckedInstruction(web3, TOKEN_PROGRAM_ID, OWNER_ATA, SOLANA_USDC, FEE_ATA, OWNER, USDC, 6);
    expect(problems(burnTx({ extra: [second] })).join(' ')).toMatch(/exactly once/);
    const t22 = transferCheckedInstruction(web3, TOKEN_2022_PROGRAM_ID, OWNER_ATA, SOLANA_USDC, FEE_ATA, OWNER, USDC, 6);
    expect(problems(burnTx({ extra: [t22] })).join(' ')).toMatch(/program other than Circle's/);
    // The burn amount is the amount entered (standard route): Aretia's fee is on top of it, never out of it.
    expect(cctpTransactionProblems(solIntent({ sourceAmount: 1_000n * USDC + 1n }), burnTx(), web3).join(' ')).toMatch(/different amount/);
  });

  it('the wallet gateway lets exactly that one transfer through, and no other', async () => {
    const q = await solWorld().getQuote(solIntent());
    const permitted = await solWorld().permittedTokenTransfer(q);
    const session = { address: OWNER } as never;
    const expectation = { address: OWNER, chain: 'solana' as const, allowedDestinations: [TOKEN_MESSENGER_MINTER_V2, TOKEN_PROGRAM_ID, 'ComputeBudget111111111111111111111111111111'], permittedTokenTransfer: permitted };
    expect(transactionProblems(burnTx().unsigned, session, expectation)).toEqual([]);
    expect(transactionProblems(burnTx().unsigned, session, { ...expectation, permittedTokenTransfer: null }).join(' ')).toMatch(/transfers tokens/);
    expect(transactionProblems(burnTx({ feeTo: OWNER_ATA }).unsigned, session, expectation).join(' ')).toMatch(/transfers tokens/);
    const second = transferCheckedInstruction(web3, TOKEN_PROGRAM_ID, OWNER_ATA, SOLANA_USDC, FEE_ATA, OWNER, USDC, 6);
    expect(transactionProblems(burnTx({ extra: [second] }).unsigned, session, expectation).join(' ')).toMatch(/transfers tokens/);
  });

  it('a missing (or foreign) fee account refuses the move with a clear reason, and Aretia never creates it for the user', async () => {
    const missing = solWorld({ feeAccount: 'missing' });
    expect((await missing.supports(solIntent())).reason).toMatch(/fee account for USDC on Solana has not been opened yet/);
    await expect(missing.getQuote(solIntent())).rejects.toThrow(/has not been opened yet/);
    const q = await solWorld().getQuote(solIntent());
    await expect(missing.buildSettlement(q)).rejects.toThrow(/has not been opened yet/);
    expect((await solWorld({ feeAccount: 'wrong-owner' }).supports(solIntent())).reason).toMatch(/not the expected account/);
    const t = (await solWorld().buildSettlement(q))[0]!.unsigned as { transaction: web3.Transaction };
    expect(t.transaction.instructions.some((ix) => ix.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')).toBe(false);
  });
});
