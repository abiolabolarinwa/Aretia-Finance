/**
 * Read-only live proof of the Virtuals launchpad venue on Base: open curves are found through Virtuals' own contracts,
 * Aretia's router quotes a VIRTUAL-for-token buy, and the transactions Aretia builds (an approval, a buy, an approval
 * and a sell, in order in one simulated block) are accepted by the real contracts, which also refuse an impossible
 * floor. Nothing is signed or sent; VIRTUAL is given to the sender only inside the simulation.
 */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { keccak256 } from '../core/keccak.js';
import type { TokenRef } from '../core/types.js';
import { address, encodeCall } from '../engine/abi.js';
import { encodeFunction } from '../engine/abiGeneric.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildVirtualsSwap, EvmVirtualsAdapter } from './evmVirtuals.js';
import { DirectEvmProvider } from './directEvm.js';

const entry = EVM_LAUNCHPADS.find((e) => e.id === 'virtuals-base')!;
const read = publicRead('base');
const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const VIRTUAL = entry.quoteAsset!;
const hex32 = (v: bigint): string => '0x' + v.toString(16).padStart(64, '0');
const pad = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hash = (...parts: string[]): string => '0x' + [...keccak256(Uint8Array.from(parts.map(pad).join('').match(/../g)!.map((b) => parseInt(b, 16))))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function openTokens(limit: number): Promise<string[]> {
  const res = await fetch('https://api.virtuals.io/api/virtuals?filters%5Bstatus%5D=1&filters%5Bchain%5D=BASE&sort%5B0%5D=createdAt%3Adesc&pagination%5BpageSize%5D=30&pagination%5Bpage%5D=1');
  const body = (await res.json()) as { data?: { preToken?: string | null }[] };
  const adapter = new EvmVirtualsAdapter(entry, read);
  const out: string[] = [];
  for (const t of body.data ?? []) {
    if (typeof t.preToken !== 'string') continue;
    if ((await adapter.quoteBuy(t.preToken, 10n ** 18n)) !== null) out.push(t.preToken.toLowerCase());
    if (out.length >= limit) break;
  }
  return out;
}

/** The mapping slot VIRTUAL keeps the sender's balance in, found by asking the token itself under a simulated value. */
async function virtualBalanceSlot(): Promise<string> {
  const data = encodeCall('balanceOf(address)', [address(SENDER)]);
  for (let i = 0; i < 12; i++) {
    const slot = hash(SENDER, hex32(BigInt(i)));
    const got = (await read('eth_call', [{ to: VIRTUAL, data }, 'latest', { [VIRTUAL]: { stateDiff: { [slot]: hex32(10n ** 24n) } } }])) as string;
    if (BigInt(got) === 10n ** 24n) return slot;
  }
  throw new Error('could not find the VIRTUAL balance slot');
}

describe('live: Virtuals launchpad on Base, simulation only', () => {
  it('finds open curves through Virtuals contracts, and ignores a token that is not on one', async () => {
    const tokens = await openTokens(3);
    console.log('virtuals open curves', tokens.length);
    expect(tokens.length).toBeGreaterThan(0);
    const adapter = new EvmVirtualsAdapter(entry, read);
    expect(await adapter.quoteBuy(VIRTUAL, 10n ** 18n)).toBeNull();
  }, 120_000);

  it('the router quotes VIRTUAL for an agent token and back', async () => {
    const [token] = await openTokens(1);
    const registry = new AretiaDexRegistry([entry]);
    const p = new DirectEvmProvider({ registry, read: () => read });
    const from: TokenRef = { chain: 'base', address: VIRTUAL };
    const to: TokenRef = { chain: 'base', address: token! };
    const q = await p.getQuote({ chain: 'base', from, to, amountIn: 10n ** 18n, slippageBps: 300, account: { chain: 'base', address: SENDER } });
    console.log('virtuals quote', q.expectedOut, q.minOut, q.priceImpactBps);
    expect(q.expectedOut).toBeGreaterThan(0n);
    const back = await p.getQuote({ chain: 'base', from: to, to: from, amountIn: q.expectedOut / 2n, slippageBps: 300, account: { chain: 'base', address: SENDER } });
    expect(back.expectedOut).toBeGreaterThan(0n);
  }, 180_000);

  it('a buy then a sell are accepted by the real contracts in order, and refused with an impossible floor', async () => {
    const [token] = await openTokens(1);
    const slot = await virtualBalanceSlot();
    const deadline = Math.floor(Date.now() / 1000) + 1200;
    const amount = 10n ** 18n;
    const adapter = new EvmVirtualsAdapter(entry, read);
    const bought = await adapter.quoteBuy(token!, amount);
    expect(bought).not.toBeNull();
    const buy = buildVirtualsSwap(entry, { token: token!, buying: true, amountIn: amount, minOut: (bought!.amountOut * 97n) / 100n, deadline });
    const half = bought!.amountOut / 2n;
    const sell = buildVirtualsSwap(entry, { token: token!, buying: false, amountIn: half, minOut: 1n, deadline });
    const badBuy = buildVirtualsSwap(entry, { token: token!, buying: true, amountIn: amount, minOut: bought!.amountOut * 10n, deadline });
    const approve = (token: string, spender: string, amt: bigint) => ({ to: token, data: encodeFunction('approve(address,uint256)', [spender, amt]) });
    const run = async (calls: { to: string; data: string }[]) => {
      const out = (await read('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides: { [VIRTUAL]: { stateDiff: { [slot]: hex32(10n ** 24n) } } }, calls: calls.map((c) => ({ from: SENDER, ...c })) }], validation: false }, 'latest'])) as { calls: { status: string }[] }[];
      return out[0]!.calls.map((c) => c.status);
    };
    const ok = await run([approve(VIRTUAL, buy.approval!.spender, amount), { to: buy.to, data: buy.data }, approve(token!, sell.approval!.spender, half), { to: sell.to, data: sell.data }]);
    console.log('virtuals approve+buy+approve+sell statuses', ok);
    expect(ok).toEqual(['0x1', '0x1', '0x1', '0x1']);
    const refused = await run([approve(VIRTUAL, buy.approval!.spender, amount), { to: badBuy.to, data: badBuy.data }]);
    expect(refused[1]).toBe('0x0');
    expect(buy.approval).toEqual({ token: VIRTUAL, spender: entry.quoter, amount });
  }, 180_000);
});
