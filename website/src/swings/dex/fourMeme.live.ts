/**
 * Read-only live proof of the Four.meme launchpad venue on BNB Chain: an open curve is found through the launchpad's own
 * helper contract, Aretia's router quotes and builds a buy that the real contract accepts when simulated, a sell is
 * accepted with a (simulated) token balance and approval, and both contracts refuse a floor set above what they pay.
 * Nothing is signed or sent; balances and allowances are given to the sender only inside the simulation.
 */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { keccak256 } from '../core/keccak.js';
import { EVM_NATIVE_ADDRESS, type TokenRef } from '../core/types.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildFourMemeSwap, EvmFourMemeAdapter } from './evmFourMeme.js';
import { DirectEvmProvider } from './directEvm.js';

const entry = EVM_LAUNCHPADS.find((e) => e.id === 'fourmeme-bnb')!;
const read = publicRead('bnb');
/** A large public BNB holder, used only as the simulated sender: nothing is ever signed with it. */
const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const hex32 = (v: bigint): string => '0x' + v.toString(16).padStart(64, '0');
const pad = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const slot = (key: string, index: string): string => '0x' + [...keccak256(Uint8Array.from((pad(key) + pad(index)).match(/../g)!.map((b) => parseInt(b, 16))))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function openTokens(limit: number): Promise<string[]> {
  const res = await fetch('https://four.meme/meme-api/v1/public/token/ranking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'NEW', pageSize: 20 }) });
  const body = (await res.json()) as { data?: { tokenAddress?: string }[] };
  const adapter = new EvmFourMemeAdapter(entry, read);
  const out: string[] = [];
  for (const t of body.data ?? []) {
    if (typeof t.tokenAddress !== 'string') continue;
    if (await adapter.info(t.tokenAddress)) out.push(t.tokenAddress.toLowerCase());
    if (out.length >= limit) break;
  }
  return out;
}

describe('live: Four.meme launchpad on BNB Chain, simulation only', () => {
  it('finds open curves through the launchpad helper', async () => {
    const tokens = await openTokens(3);
    console.log('four.meme open curves', tokens.length);
    expect(tokens.length).toBeGreaterThan(0);
  }, 120_000);

  it('the router quotes a buy and builds a transaction the real contract accepts, and the floor is enforced', async () => {
    const [token] = await openTokens(1);
    const registry = new AretiaDexRegistry([entry]);
    const p = new DirectEvmProvider({ registry, read: () => read });
    const from: TokenRef = { chain: 'bnb', address: EVM_NATIVE_ADDRESS };
    const to: TokenRef = { chain: 'bnb', address: token! };
    const q = await p.getQuote({ chain: 'bnb', from, to, amountIn: 10n ** 16n, slippageBps: 300, account: { chain: 'bnb', address: SENDER } });
    console.log('four.meme quote', q.expectedOut, q.minOut, q.priceImpactBps);
    const prepared = await p.buildTransaction(q);
    console.log('four.meme prepared', prepared.simulation);
    expect(prepared.simulation.blockers).toEqual([]);
    // A floor above what the contract pays must be refused by the contract itself.
    const bad = buildFourMemeSwap(entry, { token: token!, buying: true, amountIn: 10n ** 16n, minOut: q.expectedOut * 10n });
    await expect(read('eth_call', [{ from: SENDER, to: bad.to, data: bad.data, value: '0x' + bad.value.toString(16) }, 'latest'])).rejects.toThrow();
  }, 180_000);

  it('a sell is accepted with a simulated balance and approval, and refused with an impossible floor', async () => {
    const [token] = await openTokens(1);
    const amount = 10n ** 18n;
    const adapter = new EvmFourMemeAdapter(entry, read);
    const sold = await adapter.quoteSell(token!, amount);
    expect(sold).not.toBeNull();
    const plan = buildFourMemeSwap(entry, { token: token!, buying: false, amountIn: amount, minOut: (sold!.amountOut * 97n) / 100n });
    // Give the sender the tokens and the approval only inside the simulation (balance mapping slot 0, allowance slot 1).
    const balanceSlot = slot(SENDER, '0');
    const allowanceSlot = slot(plan.to, slot(SENDER, '1'));
    const overrides = { [token!]: { stateDiff: { [balanceSlot]: hex32(10n ** 24n), [allowanceSlot]: hex32(10n ** 24n) } } };
    await read('eth_call', [{ from: SENDER, to: plan.to, data: plan.data }, 'latest', overrides]);
    const bad = buildFourMemeSwap(entry, { token: token!, buying: false, amountIn: amount, minOut: sold!.amountOut * 10n });
    await expect(read('eth_call', [{ from: SENDER, to: bad.to, data: bad.data }, 'latest', overrides])).rejects.toThrow();
    expect(plan.approval).toEqual({ token: token!.toLowerCase(), spender: entry.router!.toLowerCase(), amount });
  }, 180_000);
});
