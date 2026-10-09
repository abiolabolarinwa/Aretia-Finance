/**
 * Read-only live proof of the Flap launchpad venue on BNB Chain: an open curve is found through the Portal itself,
 * Aretia's router quotes and builds a buy that the real contract accepts when simulated, a sell that follows a buy in the
 * same simulated block is accepted, and the contract refuses a floor set above what it pays.
 * Nothing is signed or sent; the sender buys what it later sells inside one simulated block.
 */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { EVM_NATIVE_ADDRESS, type TokenRef } from '../core/types.js';
import { encodeFunction } from '../engine/abiGeneric.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildFlapSwap, EvmFlapAdapter } from './evmFlap.js';
import { DirectEvmProvider } from './directEvm.js';

const entry = EVM_LAUNCHPADS.find((e) => e.id === 'flap-bnb')!;
const read = publicRead('bnb');
/** A large public BNB holder, used only as the simulated sender: nothing is ever signed with it. */
const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
async function openTokens(limit: number): Promise<string[]> {
  const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=flap');
  const body = (await res.json()) as { pairs?: { chainId: string; dexId: string; baseToken: { address: string } }[] };
  const adapter = new EvmFlapAdapter(entry, read);
  const out: string[] = [];
  for (const p of body.pairs ?? []) {
    if (p.chainId !== 'bsc' || !/(8888|7777)$/i.test(p.baseToken.address)) continue;
    if (await adapter.isOpen(p.baseToken.address) && !out.includes(p.baseToken.address.toLowerCase())) out.push(p.baseToken.address.toLowerCase());
    if (out.length >= limit) break;
  }
  return out;
}

describe('live: Flap launchpad on BNB Chain, simulation only', () => {
  it('finds open curves through the Portal', async () => {
    const tokens = await openTokens(3);
    console.log('flap open curves', tokens.length);
    expect(tokens.length).toBeGreaterThan(0);
  }, 120_000);

  it('the router quotes a buy and builds a transaction the real contract accepts, and the floor is enforced', async () => {
    const [token] = await openTokens(1);
    const registry = new AretiaDexRegistry([entry]);
    const p = new DirectEvmProvider({ registry, read: () => read });
    const from: TokenRef = { chain: 'bnb', address: EVM_NATIVE_ADDRESS };
    const to: TokenRef = { chain: 'bnb', address: token! };
    const q = await p.getQuote({ chain: 'bnb', from, to, amountIn: 10n ** 16n, slippageBps: 300, account: { chain: 'bnb', address: SENDER } });
    console.log('flap quote', q.expectedOut, q.minOut, q.priceImpactBps);
    const prepared = await p.buildTransaction(q);
    console.log('flap prepared', prepared.simulation);
    expect(prepared.simulation.blockers).toEqual([]);
    const bad = buildFlapSwap(entry, { token: token!, buying: true, amountIn: 10n ** 16n, minOut: q.expectedOut * 10n });
    await expect(read('eth_call', [{ from: SENDER, to: bad.to, data: bad.data, value: '0x' + bad.value.toString(16) }, 'latest'])).rejects.toThrow();
  }, 180_000);

  it('a real sell, after a real buy in the same simulated block, is accepted, and refused with an impossible floor', async () => {
    const [token] = await openTokens(1);
    const adapter = new EvmFlapAdapter(entry, read);
    const buy = buildFlapSwap(entry, { token: token!, buying: true, amountIn: 10n ** 16n, minOut: 1n });
    const approve = (amount: bigint): string => encodeFunction('approve(address,uint256)', [entry.router, amount]);
    // `eth_simulateV1` runs several calls in order against the same state, so the sender really owns what it sells.
    const run = async (calls: { to: string; data: string; value?: string }[]) => {
      const out = (await read('eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map((c) => ({ from: SENDER, ...c })) }], validation: false }, 'latest'])) as { calls: { status: string; returnData: string }[] }[];
      return out[0]!.calls;
    };
    const first = await run([{ to: buy.to, data: buy.data, value: '0x' + buy.value.toString(16) }]);
    expect(first[0]!.status).toBe('0x1');
    const bought = BigInt(first[0]!.returnData);
    expect(bought).toBeGreaterThan(0n);
    const half = bought / 2n;
    const sold = await adapter.quoteSell(token!, half);
    expect(sold).not.toBeNull();
    const sell = buildFlapSwap(entry, { token: token!, buying: false, amountIn: half, minOut: 1n });
    const ok = await run([{ to: buy.to, data: buy.data, value: '0x' + buy.value.toString(16) }, { to: token!, data: approve(half) }, { to: sell.to, data: sell.data }]);
    console.log('flap buy+approve+sell statuses', ok.map((c) => c.status));
    expect(ok.map((c) => c.status)).toEqual(['0x1', '0x1', '0x1']);
    const bad = buildFlapSwap(entry, { token: token!, buying: false, amountIn: half, minOut: 10n ** 30n });
    const refused = await run([{ to: buy.to, data: buy.data, value: '0x' + buy.value.toString(16) }, { to: token!, data: approve(half) }, { to: bad.to, data: bad.data }]);
    expect(refused[2]!.status).toBe('0x0');
    expect(sell.approval).toEqual({ token: token!.toLowerCase(), spender: entry.router!.toLowerCase(), amount: half });
  }, 180_000);
});
