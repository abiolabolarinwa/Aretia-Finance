/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The EVM curve page around the deployed, immutable AretiaCurve: the share of supply outside a curve (review M-3), a graduation blocked by a
 * pre-made exchange pair, the "Graduate anyway" rescue through AretiaCurveRescue and its strict inspector (M-4, L-12), and the plain
 * words for the exchange's refusals. The helper itself is tested against the real contracts in contracts-evm/test/rescue.test.mjs.
 */
import { describe, expect, it } from 'vitest';
import rescueArtifact from '../../../contracts-evm/AretiaCurveRescue.artifact.json';
import {
  EVM_CURVE_RESCUE_ADDRESSES,
  createAddress,
  evmCurveChain,
  evmDerive,
  evmOutsideWarning,
  evmPairBlocks,
  evmSupplyOutside,
  parseRescuePlan,
  type EvmCurveState,
} from './walletCurveEvmCore';
import { EvmCurveFlow, type EvmCurveFlowDeps } from './walletCurveEvmFlow';
import { CURVE_SEL, RESCUE_SEL, buildApproveTx, buildRescueTx, inspectRescue, inspectRescueApprove } from './walletCurveEvmTx';
import { SEL as PAIR_SEL } from './walletPoolEvmTx';

const ETH = 10n ** 18n;
const ME = '0x00000000000000000000000000000000000c0de1';
const OTHER = '0x00000000000000000000000000000000000b0b01';
const CURVE = '0x2222222222222222222222222222222222222222';
const HELPER = '0x4444444444444444444444444444444444444444';
const PAIR = '0x5555555555555555555555555555555555555555';
const plain = evmCurveChain('ethereum', { ethereum: CURVE }, {})!;
const chain = evmCurveChain('ethereum', { ethereum: CURVE }, { ethereum: HELPER })!;
const TOKEN = createAddress(chain.factory, 4n);
const w32 = (n: bigint) => n.toString(16).padStart(64, '0');
const hex = (n: bigint) => '0x' + n.toString(16);
const d = evmDerive(10n ** 27n, 3n * ETH)!;
const soldOut: EvmCurveState = { status: 'soldOut', creator: ME, createdAt: 1n, soldOutAt: 1n, feeBps: 58n, target: 3n * ETH, vSol0: d.vSol0, curveTokens: d.curveTokens, lpTokens: d.lpTokens, vSol: d.vSol0 + 3n * ETH, vTok: d.vTok0 - d.curveTokens, realSol: 3n * ETH, realTok: 0n };
const planWords = (o: Partial<Record<'tokensIn' | 'coinIn' | 'tokensOut' | 'coinOut', bigint>> = {}) => [BigInt(PAIR), 0n, 1n, 50_000_000n, 1n, o.tokensIn ?? 0n, o.coinIn ?? 0n, o.tokensOut ?? 0n, o.coinOut ?? 0n, 0n, 0n];

describe('supply outside the curve (M-3)', () => {
  it('counts what the curve holds against the total supply, rounding the outside share up', () => {
    const o = evmSupplyOutside(1000n, { curveTokens: 80n, lpTokens: 20n });
    expect(o).toMatchObject({ committed: 100n, outside: 900n, outsideBps: 9000, committedBps: 1000 });
    expect(evmSupplyOutside(1000n, { curveTokens: 800n, lpTokens: 200n }).outside).toBe(0n);
    expect(evmSupplyOutside(3n, { curveTokens: 1n, lpTokens: 1n }).outsideBps).toBe(3334);
  });
  it('warns with the share, the amount and the opener’s live balance, and says nothing when all of it is on the curve', () => {
    const text = evmOutsideWarning(evmSupplyOutside(1000n, { curveTokens: 80n, lpTokens: 20n }), 600n, (x) => x.toString());
    expect(text).toMatch(/^90% of supply \(900 tokens\) is outside this curve; holders of it can sell ahead of you\./);
    expect(text).toMatch(/opened this curve holds 600 of them right now/);
    expect(evmOutsideWarning(evmSupplyOutside(100n, { curveTokens: 80n, lpTokens: 20n }), 0n, String)).toBeNull();
  });
});

describe('the rescue helper table and its answers', () => {
  it('is null on every chain until the helper is deployed, so no chain offers "Graduate anyway" yet', () => {
    expect(Object.values(EVM_CURVE_RESCUE_ADDRESSES).every((a) => a === null)).toBe(true);
    expect(evmCurveChain('ethereum')?.rescue ?? null).toBeNull();
    expect(chain.rescue).toBe(HELPER);
  });
  it('the selectors are the compiled helper’s', () => {
    const sel = rescueArtifact.helper.selectors as Record<string, string>;
    expect(RESCUE_SEL.rescue).toBe('0x' + sel['rescue(address,uint256)']);
    expect(RESCUE_SEL.quote).toBe('0x' + sel['quote(address)']);
    expect(RESCUE_SEL.curve).toBe('0x' + sel['curve()']);
  });
  it('parses the 11-word quote and refuses anything else', () => {
    const p = parseRescuePlan('0x' + planWords({ tokensIn: 7n }).map(w32).join(''));
    expect(p).toMatchObject({ pair: PAIR, tokensIn: 7n, coinIn: 0n, reserveCoin: 1n });
    expect(parseRescuePlan('0x' + planWords().slice(0, 9).map(w32).join(''))).toBeNull();
    expect(parseRescuePlan('0x' + planWords({ tokensOut: 1n, coinOut: 1n }).map(w32).join(''))).toBeNull();
    expect(evmPairBlocks(null)).toBe(false);
    expect(evmPairBlocks({ pair: PAIR, reserveToken: 0n, reserveCoin: 0n, unsyncedToken: 0n, unsyncedCoin: 1n })).toBe(true);
  });
});

describe('the rescue inspector', () => {
  const ok = { chain, from: ME, token: TOKEN, maxTokens: 40_000_000n, wei: 5n, maxWei: 5n };
  const tx = buildRescueTx(ME, HELPER, TOKEN, 40_000_000n, 5n);
  it('passes exactly what was built, on the right network only', () => {
    expect(inspectRescue(tx, ok, 1)).toEqual([]);
    expect(inspectRescue(tx, ok, 56).length).toBeGreaterThan(0);
  });
  it('refuses another destination, sender, token, cap, more coin than the plan, an extra field, or any changed digit', () => {
    expect(inspectRescue({ ...tx, to: CURVE }, ok, 1).join(' ')).toMatch(/rescue helper/);
    expect(inspectRescue({ ...tx, from: OTHER }, ok, 1).length).toBeGreaterThan(0);
    expect(inspectRescue(buildRescueTx(ME, HELPER, OTHER, 40_000_000n, 5n), ok, 1).join(' ')).toMatch(/different token/);
    expect(inspectRescue(buildRescueTx(ME, HELPER, TOKEN, 40_000_001n, 5n), ok, 1).join(' ')).toMatch(/most tokens/);
    expect(inspectRescue(buildRescueTx(ME, HELPER, TOKEN, 40_000_000n, 6n), ok, 1).join(' ')).toMatch(/more than the rescue needs/);
    expect(inspectRescue({ ...tx, nonce: '0x1' } as any, ok, 1).length).toBeGreaterThan(0);
    const data = tx.data as string;
    for (let i = 2; i < data.length; i++) expect(inspectRescue({ ...tx, data: data.slice(0, i) + (data[i] === 'a' ? 'b' : 'a') + data.slice(i + 1) }, ok, 1).length, `digit ${i}`).toBeGreaterThan(0);
    expect(inspectRescue({ ...tx, data: data + '00' }, ok, 1).length).toBeGreaterThan(0);
    expect(inspectRescue(tx, { ...ok, chain: plain }, 1).join(' ')).toMatch(/no rescue helper/);
  });
  it('an approval for a rescue must name the helper, for exactly the planned tokens', () => {
    const a = { chain, from: ME, token: TOKEN, amount: 9n };
    expect(inspectRescueApprove(buildApproveTx(ME, TOKEN, HELPER, 9n), a, 1)).toEqual([]);
    expect(inspectRescueApprove(buildApproveTx(ME, TOKEN, CURVE, 9n), a, 1).join(' ')).toMatch(/someone other than Aretia’s rescue helper/);
    expect(inspectRescueApprove(buildApproveTx(ME, TOKEN, HELPER, 10n), a, 1).join(' ')).toMatch(/different amount/);
    expect(inspectRescueApprove(buildApproveTx(ME, TOKEN, HELPER, (1n << 256n) - 1n), a, 1).join(' ')).toMatch(/different amount/);
  });
});

/** A scripted chain with a sold-out curve, an exchange pair that may be poisoned, and a rescue helper. */
function world(o: { pair?: [bigint, bigint] | null; plan?: bigint[]; estimateError?: string; helperCurve?: string } = {}) {
  const state = { sent: [] as any[], allowance: 0n, migrated: false, tokens: 10n ** 24n };
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    const p = params as any[];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x6080';
    if (method === 'eth_getBalance') return hex(10n * ETH);
    if (method === 'eth_gasPrice') return hex(10n ** 9n);
    if (method === 'eth_estimateGas') {
      if (o.estimateError) throw new Error(o.estimateError);
      return hex(100_000n);
    }
    if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
    if (method === 'eth_call') {
      const { to, data } = p[0] as { to: string; data: string };
      if (data.startsWith(PAIR_SEL.getPair)) return '0x' + w32(o.pair ? BigInt(PAIR) : 0n);
      if (to === PAIR && data.startsWith(PAIR_SEL.getReserves)) return '0x' + w32(o.pair![0]) + w32(o.pair![1]) + w32(0n);
      if (to === PAIR && data.startsWith(PAIR_SEL.token0)) return '0x' + w32(BigInt(TOKEN));
      if (data.startsWith('0x70a08231')) return '0x' + w32(data.endsWith(PAIR.slice(2)) ? 0n : state.tokens);
      if (data.startsWith(CURVE_SEL.allowance)) return '0x' + w32(state.allowance);
      if (to === HELPER && data.startsWith(RESCUE_SEL.curve)) return '0x' + w32(BigInt(o.helperCurve ?? CURVE));
      if (to === HELPER && data.startsWith(RESCUE_SEL.quote)) return '0x' + (o.plan ?? planWords({ tokensIn: 40_000_000n })).map(w32).join('');
      if (data.startsWith(CURVE_SEL.curves)) {
        const s = state.migrated ? 3n : 2n;
        return '0x' + [s, BigInt(ME), 1n, 1n, 58n, 3n * ETH, d.vSol0, d.curveTokens, d.lpTokens, soldOut.vSol, soldOut.vTok, state.migrated ? 0n : 3n * ETH, 0n].map(w32).join('');
      }
      return '0x';
    }
    throw new Error(`unexpected ${method}`);
  };
  const adapter = {
    getAccounts: async () => [ME],
    getChainId: async () => 1,
    switchChain: async () => undefined,
    sendTransaction: async (tx: any) => {
      state.sent.push(tx);
      if (tx.to === TOKEN) state.allowance = BigInt('0x' + tx.data.slice(74));
      if (tx.to === HELPER) state.migrated = true;
      return '0x' + state.sent.length.toString(16).padStart(64, '0');
    },
  };
  const deps = { adapter, read, now: (() => { let t = 0; return () => (t += 1000); })(), nowSeconds: () => 1_700_000_000, sleep: async () => undefined } as unknown as EvmCurveFlowDeps;
  return { state, flow: new EvmCurveFlow(deps) };
}

describe('graduating past a pre-made pair (M-4, L-12)', () => {
  it('without a helper: explains the pre-made pool and the 7-day unwind, and offers no rescue', async () => {
    const r = await world({ pair: [0n, 1n] }).flow.prepareGraduate(plain, ME, soldOut, TOKEN);
    expect(r.rescuable).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/already made this token’s pool on Uniswap V2 and left 1 wei of wrapped ETH in it/);
    expect(r.blockers.join(' ')).toMatch(/rescue helper.*not deployed on Ethereum yet.*Seven days/);
  });
  it('with a helper: says so and marks the review for "Graduate anyway"', async () => {
    const r = await world({ pair: [1n, 1n] }).flow.prepareGraduate(chain, ME, soldOut, TOKEN);
    expect(r.rescuable).toBe(true);
    expect(r.blockers.join(' ')).toMatch(/Graduate anyway/);
  });
  it('an empty pair or no pair does not block, and the exchange’s refusal is put in words', async () => {
    expect((await world({ pair: [0n, 0n] }).flow.prepareGraduate(chain, ME, soldOut, TOKEN)).blockers).toEqual([]);
    const r = await world({ pair: null, estimateError: 'execution reverted: UniswapV2Library: INSUFFICIENT_LIQUIDITY' }).flow.prepareGraduate(chain, ME, soldOut, TOKEN);
    expect(r.blockers.join(' ')).toMatch(/already made on the exchange with almost nothing in it/);
  });
  it('the curve’s own "exists" is matched only as its own reason, not inside other messages', async () => {
    const own = await world({ pair: null, estimateError: 'execution reverted: exists' }).flow.prepareGraduate(chain, ME, soldOut, TOKEN);
    expect(own.blockers.join(' ')).toMatch(/a curve for this token already exists/);
    const other = await world({ pair: null, estimateError: 'execution reverted: pool already exists with liquidity' }).flow.prepareGraduate(chain, ME, soldOut, TOKEN);
    expect(other.blockers.join(' ')).not.toMatch(/a curve for this token already exists/);
  });
  it('"Graduate anyway": approves exactly the planned tokens to the helper, then sends exactly rescue(token, tokens) with the planned coin', async () => {
    const x = world({ pair: [0n, 1n], plan: planWords({ tokensIn: 40_000_000n, coinIn: 3n }) });
    const r = await x.flow.prepareRescue(chain, ME, soldOut, TOKEN);
    expect(r.blockers).toEqual([]);
    expect(r.maxTokens).toBe(40_000_000n);
    expect(r.wei).toBe(3n);
    const out = await x.flow.rescue(r);
    expect(out.differences).toEqual([]);
    expect(x.state.sent).toHaveLength(2);
    expect(x.state.sent[0]).toMatchObject({ to: TOKEN });
    expect(x.state.sent[1]).toEqual({ from: ME, to: HELPER, data: RESCUE_SEL.rescue + w32(BigInt(TOKEN)) + w32(40_000_000n), value: '0x3' });
  });
  it('needs no approval when the repair needs no tokens, and refuses a helper bound to another curve or a missing helper', async () => {
    const x = world({ pair: [10n ** 20n, 0n], plan: planWords({ coinIn: 5n * ETH, tokensOut: 10n ** 20n }) });
    const r = await x.flow.prepareRescue(chain, ME, soldOut, TOKEN);
    expect(r.approveTx).toBeNull();
    await x.flow.rescue(r);
    expect(x.state.sent).toHaveLength(1);
    expect((await world({ pair: [0n, 1n], helperCurve: OTHER }).flow.prepareRescue(chain, ME, soldOut, TOKEN)).blockers.join(' ')).toMatch(/not the one for this curve/);
    expect((await world({ pair: [0n, 1n] }).flow.prepareRescue(plain, ME, soldOut, TOKEN)).blockers.join(' ')).toMatch(/not deployed/);
  });
  it('will not sign a rescue whose transaction was changed after review', async () => {
    const x = world({ pair: [0n, 1n], plan: planWords({ tokensIn: 0n, coinIn: 1n }) });
    const r = await x.flow.prepareRescue(chain, ME, soldOut, TOKEN);
    await expect(x.flow.rescue({ ...r, tx: { ...r.tx, value: '0x2' } })).rejects.toThrow(/Not signing/);
    expect(x.state.sent).toEqual([]);
  });
});
