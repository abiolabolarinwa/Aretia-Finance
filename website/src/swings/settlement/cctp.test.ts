import { describe, expect, it } from 'vitest';
import { CCTP_CONTRACTS, CCTP_USDC, CctpSettlementProvider, cctpProviders, feeFor } from './cctp.js';
import { SettlementQuoteEngine } from './engine.js';
import { encodeFunction } from '../engine/abiGeneric.js';
import type { ChainId } from '../core/types.js';
import type { SettlementIntent } from './types.js';

const NOW = 5_000_000;
const SENDER = '0x' + 'a'.repeat(40);
const RECIPIENT = '0x' + 'b'.repeat(40);
const word = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const intent = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({
  sourceChain: 'ethereum',
  sourceAsset: { chain: 'ethereum', address: CCTP_USDC.ethereum! },
  sourceAmount: 1_000_000_000n,
  destinationChain: 'base',
  destinationAsset: { chain: 'base', address: CCTP_USDC.base! },
  sender: SENDER,
  recipient: RECIPIENT,
  ...over,
});

interface World {
  fees?: unknown;
  feeStatus?: number;
  irisDown?: boolean;
  burnLimit?: bigint;
  allowance?: bigint;
  fastAllowance?: number;
  message?: unknown;
  nonceUsed?: boolean;
  calls: string[];
}
const world = (w: Partial<World> = {}): { w: World; fetchImpl: typeof fetch; read: (c: ChainId) => (m: string, p: unknown[]) => Promise<unknown> } => {
  const state: World = { fees: [{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }], burnLimit: 10_000_000_000n, allowance: 0n, fastAllowance: 500_000, calls: [], ...w };
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string) => {
    state.calls.push(String(url));
    if (state.irisDown) throw new Error('offline');
    if (String(url).includes('/fees/')) return json(state.feeStatus ?? 200, state.fees);
    if (String(url).includes('/allowance')) return json(200, { allowance: state.fastAllowance });
    if (String(url).includes('/messages/')) return state.message === undefined ? json(404, {}) : json(200, state.message);
    return json(404, {});
  }) as unknown as typeof fetch;
  const sel = (sig: string, args: unknown[]): string => encodeFunction(sig, args).slice(0, 10);
  const read = (): ((m: string, p: unknown[]) => Promise<unknown>) => async (_m, params) => {
    const data = String((params[0] as { data: string }).data);
    if (data.startsWith(sel('burnLimitsPerMessage(address)', [CCTP_USDC.ethereum]))) return word(state.burnLimit!);
    if (data.startsWith(sel('allowance(address,address)', [SENDER, CCTP_CONTRACTS.tokenMessenger]))) return word(state.allowance!);
    if (data.startsWith(sel('usedNonces(bytes32)', ['0x' + '0'.repeat(64)]))) return word(state.nonceUsed ? 1n : 0n);
    throw new Error('unexpected call ' + data.slice(0, 10));
  };
  return { w: state, fetchImpl, read };
};
const provider = (mode: 'fast' | 'standard', w: Partial<World> = {}) => {
  const x = world(w);
  return { p: new CctpSettlementProvider({ mode, read: x.read as never, fetchImpl: x.fetchImpl, now: () => NOW }), x };
};

describe('feeFor', () => {
  it('rounds up so the cap never falls below the charge, and handles fractional basis points', () => {
    expect(feeFor(1_000_000_000n, 1.3)).toBe(130_000n);
    expect(feeFor(1n, 1.3)).toBe(1n);
    expect(feeFor(1_000_000n, 0)).toBe(0n);
  });
});

describe('CCTP support is decided, with a reason, never assumed', () => {
  it('refuses BNB Chain, non-USDC assets and Solana legs it cannot build, each with a reason', async () => {
    const { p } = provider('standard');
    expect((await p.supports(intent({ destinationChain: 'bnb', destinationAsset: { chain: 'bnb', address: '0x' + '1'.repeat(40) } }))).reason).toMatch(/BNB Chain/);
    expect((await p.supports(intent({ sourceAsset: { chain: 'ethereum', address: '0x' + '1'.repeat(40) } }))).reason).toMatch(/native USDC/);
    const sol = await p.supports(intent({ destinationChain: 'solana', destinationAsset: { chain: 'solana', address: CCTP_USDC.solana! } }));
    expect(sol.supported).toBe(false);
    expect(sol.reason).toMatch(/Solana side/);
  });

  it('refuses fast transfer from a chain without it, but standard works', async () => {
    const fromAvax = intent({ sourceChain: 'avalanche', sourceAsset: { chain: 'avalanche', address: CCTP_USDC.avalanche! } });
    expect((await provider('fast').p.supports(fromAvax)).reason).toMatch(/does not offer fast transfer/);
  });

  it('says so when Circle rejects the pair, is down, or when the chain reports no burn limit', async () => {
    expect((await provider('standard', { feeStatus: 400 }).p.supports(intent())).reason).toMatch(/does not support this pair/);
    expect((await provider('standard', { irisDown: true }).p.supports(intent())).reason).toMatch(/could not be reached/);
    expect((await provider('standard', { burnLimit: 0n }).p.supports(intent())).reason).toMatch(/no burn limit/);
  });

  it('supports an Ethereum to Base transfer when everything agrees', async () => {
    expect(await provider('fast').p.supports(intent())).toEqual({ supported: true, reason: null });
  });
});

describe('quotes', () => {
  it('fast: charges the published fee out of the amount, needs an exact approval, and shows the time', async () => {
    const { p } = provider('fast');
    const q = await p.getQuote(intent());
    expect(q.settlementFee.amount).toBe(130_000n);
    expect(q.destinationAmount).toBe(1_000_000_000n - 130_000n);
    expect(q.route.steps.map((s) => s.id)).toEqual(['approve', 'burn', 'attest', 'mint']);
    expect(q.route.steps.at(-1)!.kind).toBe('receive');
    expect(q.estimatedSeconds).toBeLessThan(120);
    expect(q.networkFees).toBeNull();
  });

  it('standard: no fee, a long wait, and no approval when the allowance already covers it', async () => {
    const { p } = provider('standard', { allowance: 1_000_000_000n });
    const q = await p.getQuote(intent());
    expect(q.settlementFee.amount).toBe(0n);
    expect(q.destinationAmount).toBe(q.sourceAmount);
    expect(q.route.steps.map((s) => s.id)).toEqual(['burn', 'attest', 'mint']);
    expect(q.estimatedSeconds).toBeGreaterThan(15 * 60);
  });

  it('rejects an amount above the burn limit, above the fast allowance, or too small for the fee', async () => {
    await expect(provider('standard', { burnLimit: 5n }).p.getQuote(intent())).rejects.toThrow(/largest single/);
    await expect(provider('fast', { fastAllowance: 10 }).p.getQuote(intent())).rejects.toThrow(/fast-transfer allowance/);
    await expect(provider('fast').p.getQuote(intent({ sourceAmount: 1n }))).rejects.toThrow(/too small/);
  });

  it('passes the engine\'s own checks, and the engine ranks fast against standard', async () => {
    const x = world({ allowance: 10n ** 12n });
    const providers = cctpProviders({ read: x.read as never, fetchImpl: x.fetchImpl, now: () => NOW });
    const engine = new SettlementQuoteEngine(providers, { now: () => NOW });
    const search = await engine.quote(intent(), 'cheapest');
    expect(search.failures).toEqual([]);
    expect(search.quotes.map((q) => q.providerId)).toEqual(['circle-cctp-standard', 'circle-cctp-fast']);
    expect((await engine.quote(intent(), 'fastest')).quotes[0]!.providerId).toBe('circle-cctp-fast');
  });
});

describe('transactions', () => {
  it('builds an approval for exactly the amount and a burn to the stated recipient, nothing more', async () => {
    const { p } = provider('standard');
    const q = await p.getQuote(intent());
    const txs = await p.buildSettlement(q);
    expect(txs.map((t) => t.stepId)).toEqual(['approve', 'burn']);
    const approve = txs[0]!.unsigned as { tx: { to: string; data: string } };
    expect(approve.tx.to).toBe(CCTP_USDC.ethereum);
    expect(approve.tx.data).toBe(encodeFunction('approve(address,uint256)', [CCTP_CONTRACTS.tokenMessenger, 1_000_000_000n]));
    const burn = txs[1]!.unsigned as { tx: { to: string; data: string; from: string } };
    expect(burn.tx.to).toBe(CCTP_CONTRACTS.tokenMessenger);
    expect(burn.tx.from).toBe(SENDER);
    expect(burn.tx.data.toLowerCase()).toContain('b'.repeat(40));
  });

  it('refuses to build from an expired quote', async () => {
    const x = world();
    let t = NOW;
    const p = new CctpSettlementProvider({ mode: 'standard', read: x.read as never, fetchImpl: x.fetchImpl, now: () => t });
    const q = await p.getQuote(intent());
    t += 10 * 60_000;
    await expect(p.buildSettlement(q)).rejects.toThrow(/expired/);
  });
});

describe('following a settlement', () => {
  const hash = '0x' + 'c'.repeat(64);
  const nonce = '0x' + 'd'.repeat(64);
  const done = { messages: [{ status: 'complete', message: '0xabcd', attestation: '0x1234', eventNonce: nonce }] };

  it('is not complete on the source transaction alone', async () => {
    const { p } = provider('standard', { message: { messages: [{ status: 'pending_confirmations', message: '0x', attestation: 'PENDING', eventNonce: nonce }] } });
    const q = await p.getQuote(intent());
    const s = await p.trackSettlement(p.executionIdFor('ethereum', hash), q);
    expect(s.code).toBe('source-confirmed');
  });

  it('is ready to complete once attested, and completed only when the destination nonce is used', async () => {
    const a = provider('standard', { message: done });
    const q = await a.p.getQuote(intent());
    const id = a.p.executionIdFor('ethereum', hash);
    expect((await a.p.trackSettlement(id, q)).code).toBe('ready-to-complete');
    const tx = await a.p.buildDestination(q, id);
    expect(tx!.chain).toBe('base');
    expect((tx!.unsigned as { tx: { to: string } }).tx.to).toBe(CCTP_CONTRACTS.messageTransmitter);
    const b = provider('standard', { message: done, nonceUsed: true });
    expect((await b.p.trackSettlement(id, q)).code).toBe('completed');
    expect(await b.p.buildDestination(q, id)).toBeNull(); // never mint twice
  });

  it('says unknown, not failed or complete, when Circle cannot be asked, and refuses foreign or malformed ids', async () => {
    const { p } = provider('standard', { irisDown: true });
    expect((await p.trackSettlement(p.executionIdFor('ethereum', hash))).code).toBe('unknown');
    expect((await p.trackSettlement('garbage')).code).toBe('unknown');
    expect((await p.trackSettlement(`other:ethereum:${hash}`)).code).toBe('unknown');
    const none = provider('standard');
    expect((await none.p.trackSettlement(none.p.executionIdFor('ethereum', hash))).code).toBe('awaiting-source');
  });
});
