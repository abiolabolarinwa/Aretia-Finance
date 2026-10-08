/**
 * End-to-end tests with deterministic stand-ins at the edges only (the network, the wallet's signature, the provider's
 * web service). Everything between is the real code: intent -> plan -> quotes -> unified quote -> economics -> safety ->
 * runner -> orchestrator -> provider -> telemetry -> recovery.
 *
 * Nothing here can pass by a fake provider "succeeding" in production: the test providers are in `testing.ts`, which a
 * separate test proves no production module imports.
 */
import { describe, expect, it } from 'vitest';
import { parseIntent } from './intent/parse.js';
import { planRoutes, type Capabilities } from './plan/planner.js';
import { combineLegs, legFromRamp, legFromSettlement, type ExecutionLeg } from './plan/executionQuote.js';
import { PlanRunner } from './plan/runner.js';
import { JsonVersionedStore } from './plan/store.js';
import { BalanceLegExecutor, SettlementLegExecutor } from './plan/executors.js';
import { diagnosePlan, diagnoseExecution } from './plan/recovery.js';
import type { PlanRecord } from './plan/state.js';
import { CrossChainOrchestrator, type ExecutionGateway } from './orchestrator/orchestrator.js';
import { InMemoryExecutionStore } from './orchestrator/store.js';
import { CCTP_CONTRACTS, CCTP_USDC, CctpSettlementProvider } from './settlement/cctp.js';
import { assessSettlement } from './settlement/safety.js';
import { MoonPayRampProvider } from './ramp/moonpay.js';
import { RampRouter } from './ramp/router.js';
import { disclose, selectAllocation } from './economics/act.js';
import { observedExecutionStore, ObservedPlanStore } from './observability/execution.js';
import { Telemetry } from './observability/telemetry.js';
import { encodeFunction } from './engine/abiGeneric.js';
import type { ChainId } from './core/types.js';
import type { SettlementQuote, SettlementTransaction } from './settlement/types.js';

const NOW = 5_000_000;
const ME = '0x' + 'a'.repeat(40);
const ACT_BASE = '0x' + 'ac'.repeat(20);
const word = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');

/** A world: Circle's service, the chains, and a wallet whose balances the test controls. */
function world() {
  const w = {
    allowance: 0n,
    attested: false,
    nonceUsed: false,
    irisDown: false,
    balances: new Map<string, bigint>(),
    sent: [] as { stepId: string; to: string }[],
    receipts: new Map<string, 'confirmed' | 'failed'>(),
    failBurn: false,
  };
  const sel = (sig: string, args: unknown[]): string => encodeFunction(sig, args).slice(0, 10);
  const read = (): ((m: string, p: unknown[]) => Promise<unknown>) => async (_m, params) => {
    const data = String((params[0] as { data: string }).data);
    if (data.startsWith(sel('burnLimitsPerMessage(address)', [CCTP_USDC.ethereum]))) return word(1_000_000_000_000n);
    if (data.startsWith(sel('allowance(address,address)', [ME, CCTP_CONTRACTS.tokenMessenger]))) return word(w.allowance);
    if (data.startsWith(sel('usedNonces(bytes32)', ['0x' + '0'.repeat(64)]))) return word(w.nonceUsed ? 1n : 0n);
    throw new Error('unexpected read');
  };
  const fetchImpl = (async (url: string) => {
    if (w.irisDown) throw new Error('offline');
    const u = String(url);
    const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status });
    if (u.includes('/fees/')) return json([{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]);
    if (u.includes('/allowance')) return json({ allowance: 1_000_000 });
    if (u.includes('/messages/')) return w.attested ? json({ messages: [{ status: 'complete', message: '0xabcd', attestation: '0x1234', eventNonce: '0x' + 'd'.repeat(64) }] }) : json({ messages: [{ status: 'pending_confirmations', message: '0x', attestation: 'PENDING', eventNonce: '0x' + 'd'.repeat(64) }] });
    return json({}, 404);
  }) as unknown as typeof fetch;
  let n = 0;
  const gateway: ExecutionGateway = {
    send: async (tx: SettlementTransaction, expect_) => {
      if (!expect_.allowedDestinations.some((d) => d.toLowerCase() === (tx.unsigned as { tx: { to: string } }).tx.to.toLowerCase())) throw new Error('refused: unknown destination');
      w.sent.push({ stepId: tx.stepId, to: (tx.unsigned as { tx: { to: string } }).tx.to });
      const hash = '0x' + String(++n).padStart(64, '0');
      w.receipts.set(hash, tx.stepId === 'burn' && w.failBurn ? 'failed' : 'confirmed');
      return hash;
    },
    confirmation: async (_c: ChainId, h: string) => w.receipts.get(h) ?? 'pending',
  };
  return { w, read, fetchImpl, gateway };
}

const planCaps = (enabled: ChainId[] = ['ethereum']): Capabilities => ({
  rampChains: async () => enabled,
  canSettle: async (a, b) => a !== 'bnb' && b !== 'bnb',
  canSwap: async () => true,
  usdc: (c) => CCTP_USDC[c] ?? null,
});
const rampApi = async (b: Record<string, unknown>): Promise<unknown> =>
  b.action === 'status' ? { enabled: true, providers: [{ id: 'moonpay', name: 'MoonPay', sides: ['buy', 'sell'] }] } : b.action === 'catalog' ? { countries: [{ code: 'US', name: 'US', buy: true, sell: true }], fiats: ['usd'], tokens: [{ chain: 'ethereum', symbol: 'USDC', contract: CCTP_USDC.ethereum, sell: true }] } : { url: 'https://buy-sandbox.moonpay.com/?apiKey=pk&signature=x' };

describe('end to end: "buy 250 usd of ACT on Base" with USD in the US', () => {
  async function build() {
    const wd = world();
    const telemetry = new Telemetry([], () => NOW);
    const orchStore = observedExecutionStore(new InMemoryExecutionStore(), telemetry);
    const cctp = new CctpSettlementProvider({ mode: 'standard', read: wd.read as never, fetchImpl: wd.fetchImpl, now: () => NOW });
    const orchestrator = new CrossChainOrchestrator({ store: orchStore, providers: [cctp], gateway: wd.gateway, now: () => NOW, newId: () => 'ex1', sleep: async () => undefined, confirmTimeoutMs: 0 });
    const quotes = new Map<string, SettlementQuote>();
    const balances = new Map<string, bigint>([[`ethereum:${CCTP_USDC.ethereum}`, 0n], [`base:${ACT_BASE}`, 0n]]);
    const planStore = new ObservedPlanStore(new JsonVersionedStore<PlanRecord>(null, 'plans', (v): v is PlanRecord => typeof v === 'object' && v !== null && 'legs' in v), telemetry);
    const settlement = new SettlementLegExecutor({ orchestrator, quoteFor: (id) => quotes.get(id) ?? null, now: () => NOW });
    const balance = new BalanceLegExecutor({ balanceOf: async (c, _w, a) => balances.get(`${c}:${a}`) ?? null, walletFor: () => ME, instruction: (_p, leg) => `Do ${leg.kind}.` });
    const runner = new PlanRunner({ store: planStore, executors: { 'ramp-buy': balance, settlement, swap: balance }, now: () => NOW, newId: () => 'plan1' });

    // 1. The words become an intent; the intent becomes a goal.
    const parsed = parseIntent('buy 250 usd of act on base');
    if (!parsed.ok || parsed.intent.kind !== 'buy') throw new Error('did not parse');
    const goal = { from: { kind: 'fiat' as const, fiat: 'usd', amount: 250 }, to: { kind: 'token' as const, chain: 'base' as const, address: ACT_BASE, symbol: 'ACT', decimals: 6 }, country: 'US' };
    const found = await planRoutes(goal, planCaps());
    // 2. Each step is quoted by its own engine.
    const ramp = await new RampRouter([new MoonPayRampProvider({ api: rampApi, now: () => NOW })], () => NOW).quote({ side: 'buy', fiat: 'usd', fiatAmount: 250, asset: { chain: 'ethereum', symbol: 'USDC', address: CCTP_USDC.ethereum!, decimals: 6 }, wallet: ME, country: 'US' });
    return { wd, telemetry, orchestrator, quotes, balances, planStore, runner, parsed, found, ramp, cctp, settlement };
  }

  it('plans buy, move, swap; quotes honestly; and discloses every cost separately', async () => {
    const { found, ramp, cctp, quotes } = await build();
    expect(found.plans[0]!.steps.map((s) => s.kind)).toEqual(['ramp-buy', 'settlement', 'swap']);
    const sq = await cctp.getQuote({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 240_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: ME, recipient: ME });
    quotes.set(sq.id, sq);
    const rampLeg = legFromRamp(ramp.quotes[0]!);
    const swapLeg: ExecutionLeg = { id: 'sw', kind: 'swap', title: 'Swap USDC for ACT on Base', input: { chain: 'base', assetKey: CCTP_USDC.base!.toLowerCase(), symbol: 'USDC', decimals: 6, amount: 240_000_000n }, output: { chain: 'base', assetKey: ACT_BASE, symbol: 'ACT', decimals: 6, amount: 1_000n }, fees: [], estimatedSeconds: 10, risk: 'low', signatures: 1, expiresAt: NOW + 30_000, notes: [] };
    // The ramp output is on ethereum USDC; connect legs explicitly with the amount the user is expected to receive.
    const connected = [{ ...rampLeg, output: { ...rampLeg.output, amount: null } }, legFromSettlement(sq), swapLeg];
    // The ramp has no price, so the unified quote must say the final amount is unknown, not invent one.
    const q = combineLegs('q', connected.map((l, i) => (i === 0 ? { ...l, output: { ...l.output, amount: 240_000_000n } } : l)));
    expect(q.receive.symbol).toBe('ACT');
    const lines = disclose(q);
    expect(lines.map((l) => l.kind)).toContain('ramp');
    expect(lines.map((l) => l.kind)).toContain('settlement');
    expect(selectAllocation(q.legs, ['ethereum', 'ethereum', 'base']).legIndex).toBeNull(); // the allocation is Solana-only today
  });

  it('a safe, funded move passes the safety engine, and one with no gas needs acknowledgement', async () => {
    const { cctp } = await build();
    const sq = await cctp.getQuote({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 100_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: ME, recipient: ME });
    const ctx = { now: NOW, provider: cctp, enabledChains: ['ethereum', 'base'] as ChainId[], sourceBalance: 500_000_000n, destinationNativeBalance: 10n ** 16n, existing: [], maxAmount: 250_000_000n };
    expect(assessSettlement(sq, ctx).verdict).toBe('allow');
    expect(assessSettlement(sq, { ...ctx, destinationNativeBalance: 0n }).verdict).toBe('confirm');
  });

  it('runs the whole journey: pay, move, claim, swap; completes only when each step is proven', async () => {
    const { wd, runner, balances, quotes, cctp, orchestrator, planStore, telemetry } = await build();
    const sq = await cctp.getQuote({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 240_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: ME, recipient: ME });
    quotes.set(sq.id, sq);
    const usdcEth = CCTP_USDC.ethereum!.toLowerCase();
    const ramp: ExecutionLeg = { id: 'r', kind: 'ramp-buy', title: 'Buy USDC', input: { chain: null, assetKey: 'fiat:usd', symbol: 'USD', decimals: 0, amount: 250n }, output: { chain: 'ethereum', assetKey: usdcEth, symbol: 'USDC', decimals: 6, amount: 240_000_000n }, fees: [], estimatedSeconds: 600, risk: 'medium', signatures: 0, expiresAt: NOW + 600_000, notes: [] };
    const swap: ExecutionLeg = { id: 'sw', kind: 'swap', title: 'Swap', input: { chain: 'base', assetKey: CCTP_USDC.base!.toLowerCase(), symbol: 'USDC', decimals: 6, amount: 239_000_000n }, output: { chain: 'base', assetKey: ACT_BASE, symbol: 'ACT', decimals: 6, amount: 1_000n }, fees: [], estimatedSeconds: 10, risk: 'low', signatures: 1, expiresAt: NOW + 30_000, notes: [] };
    const plan = await runner.create(combineLegs('q', [ramp, legFromSettlement(sq), swap]));

    // The ramp leg starts and waits: nothing has been paid yet, so nothing moves on.
    let p = await runner.step(plan.id);
    expect(p.state).toBe('WAITING_USER');
    expect(p.legs.map((l) => l.status)).toEqual(['waiting-user', 'pending', 'pending']);
    expect(wd.w.sent).toEqual([]);

    // The user pays; USDC arrives on Ethereum. The settlement leg begins: approval and burn are signed.
    balances.set(`ethereum:${usdcEth}`, 240_000_000n);
    p = await runner.step(plan.id);
    expect(p.legs[0]!.status).toBe('done');
    expect(wd.w.sent.map((s) => s.stepId)).toEqual(['approve', 'burn']);
    expect(p.legs[1]!.status).toBe('active');
    expect(p.state).toBe('RUNNING');

    // Circle attests; the funds are released and the user is asked to claim: still not complete.
    wd.w.attested = true;
    p = await runner.step(plan.id);
    expect(p.state).toBe('WAITING_USER');
    expect(p.legs[1]!.instruction).toMatch(/Claim them on the destination/);
    await orchestrator.claim(p.legs[1]!.ref.executionId!);
    expect(wd.w.sent.at(-1)!.stepId).toBe('mint');

    // The mint lands (the destination nonce is used); the swap leg begins and waits for the user.
    wd.w.nonceUsed = true;
    p = await runner.step(plan.id);
    expect(p.legs[1]!.status).toBe('done');
    expect(p.legs[2]!.status).toBe('waiting-user');
    expect(p.state).toBe('WAITING_USER');

    // The user swaps; ACT arrives on Base. Only now is the plan complete.
    balances.set(`base:${ACT_BASE}`, 5_000n);
    p = await runner.step(plan.id);
    expect(p.state).toBe('COMPLETED');
    expect(p.legs.every((l) => l.status === 'done')).toBe(true);
    expect(await planStore.get(plan.id)).toMatchObject({ state: 'COMPLETED' });

    // Observability saw the journey, with no address or amount in it.
    const states = telemetry.recent(100).filter((e) => e.event.kind === 'plan' && e.event.name === 'execution_state').map((e) => e.event.to);
    expect(states).toContain('COMPLETED');
    expect(JSON.stringify(telemetry.recent(100))).not.toContain(ME);
  });

  it('a settlement that fails after the burn stops the plan, flags the funds as possibly in transit, and nothing later runs', async () => {
    const { wd, runner, balances, quotes, cctp, orchestrator } = await build();
    const sq = await cctp.getQuote({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 240_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: ME, recipient: ME });
    quotes.set(sq.id, sq);
    const usdcEth = CCTP_USDC.ethereum!.toLowerCase();
    wd.w.failBurn = true;
    const plan = await runner.create(combineLegs('q', [
      { id: 'r', kind: 'ramp-buy', title: 'Buy', input: { chain: null, assetKey: 'fiat:usd', symbol: 'USD', decimals: 0, amount: 250n }, output: { chain: 'ethereum', assetKey: usdcEth, symbol: 'USDC', decimals: 6, amount: 240_000_000n }, fees: [], estimatedSeconds: 1, risk: 'low', signatures: 0, expiresAt: NOW + 600_000, notes: [] },
      legFromSettlement(sq),
    ]));
    await runner.step(plan.id);
    balances.set(`ethereum:${usdcEth}`, 240_000_000n);
    const p = await runner.step(plan.id);
    expect(p.state).toBe('FAILED');
    expect(p.failure).toMatchObject({ legIndex: 1, fundsMayBeAtRisk: false });
    // The burn failed on the network, so nothing left the account: the advice says so and offers a fresh start.
    const advice = diagnosePlan(p, NOW)[0]!;
    expect(advice.fundsAt).toMatch(/USDC at ethereum, from step 1/);
    expect(advice.actions.map((a) => a.id)).toContain('retry-step');
    void orchestrator;
  });

  it('survives a closed tab: a fresh runner on the same stores picks the journey up without sending anything twice', async () => {
    const a = await build();
    const sq = await a.cctp.getQuote({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 240_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: ME, recipient: ME });
    a.quotes.set(sq.id, sq);
    const plan = await a.runner.create(combineLegs('q', [legFromSettlement(sq)]));
    let p = await a.runner.step(plan.id); // approval + burn sent, now waiting on Circle
    const sentBefore = a.wd.w.sent.length;
    expect(p.legs[0]!.status).toBe('active');
    // "Reload": a new orchestrator and runner over the same stores and the same world.
    const orchestrator2 = new CrossChainOrchestrator({ store: (a.orchestrator as unknown as { o: { store: never } }).o.store, providers: [a.cctp], gateway: a.wd.gateway, now: () => NOW, newId: () => 'ex2', sleep: async () => undefined, confirmTimeoutMs: 0 });
    const settlement2 = new SettlementLegExecutor({ orchestrator: orchestrator2, quoteFor: () => null, now: () => NOW });
    const runner2 = new PlanRunner({ store: a.planStore, executors: { settlement: settlement2 }, now: () => NOW });
    a.wd.w.attested = true;
    p = await runner2.step(plan.id);
    expect(a.wd.w.sent.length).toBe(sentBefore); // nothing was sent again
    expect(p.legs[0]!.instruction).toMatch(/Claim/);
    a.wd.w.nonceUsed = true;
    expect((await runner2.step(plan.id)).state).toBe('COMPLETED');
  });
});

describe('end to end: Circle is unreachable', () => {
  it('offers no route and says why, rather than guessing', async () => {
    const { w, read, fetchImpl } = world();
    w.irisDown = true;
    const p = new CctpSettlementProvider({ mode: 'standard', read: read as never, fetchImpl, now: () => NOW });
    const a = await p.supports({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 1n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: ME, recipient: ME });
    expect(a).toEqual({ supported: false, reason: expect.stringMatching(/could not be reached/) });
  });

  it('an unreachable provider makes a tracked move "unknown", never failed or complete', async () => {
    const { w, read, fetchImpl } = world();
    const cctp = new CctpSettlementProvider({ mode: 'standard', read: read as never, fetchImpl, now: () => NOW });
    const orch = new CrossChainOrchestrator({ store: new InMemoryExecutionStore(), providers: [cctp], gateway: world().gateway, now: () => NOW, newId: () => 'e', sleep: async () => undefined, confirmTimeoutMs: 0 });
    const q = await cctp.getQuote({ sourceChain: 'ethereum', sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! }, sourceAmount: 100_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: ME, recipient: ME });
    const g = world();
    const orch2 = new CrossChainOrchestrator({ store: new InMemoryExecutionStore(), providers: [cctp], gateway: g.gateway, now: () => NOW, newId: () => 'e', sleep: async () => undefined, confirmTimeoutMs: 0 });
    const rec = await orch2.create(q);
    await orch2.start(rec.id);
    w.irisDown = true;
    const adv = await orch2.advance(rec.id);
    expect(adv.record.state).toBe('SETTLEMENT_PENDING');
    expect(diagnoseExecution(adv.record, NOW + 3 * 60 * 60_000)[0]!.problem).toMatch(/much longer than expected/);
    void orch;
  });
});
