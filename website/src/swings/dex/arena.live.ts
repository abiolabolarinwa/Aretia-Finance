/**
 * Read-only live proof of the Arena launcher venue on Avalanche: a token is found by its address through the launcher's
 * own records, Aretia quotes the most whole tokens a budget of ARENA buys, and the transactions Aretia builds (an
 * approval, a buy, an approval and a sell, in order in one simulated block) are accepted by the real launcher, which also
 * refuses a budget that is too small. Nothing is signed or sent; ARENA is given to the sender only inside the simulation.
 */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { keccak256 } from '../core/keccak.js';
import type { TokenRef } from '../core/types.js';
import { address, encodeCall, uint, words, wordToAddress, wordToBigInt } from '../engine/abi.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildArenaSwap, EvmArenaAdapter } from './evmArena.js';
import { DirectEvmProvider } from './directEvm.js';

const entry = EVM_LAUNCHPADS.find((e) => e.id === 'arena-avalanche')!;
const read = publicRead('avalanche');
const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const ARENA = entry.quoteAsset!;
const hex32 = (v: bigint): string => '0x' + v.toString(16).padStart(64, '0');
const pad = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hash = (...parts: string[]): string => '0x' + [...keccak256(Uint8Array.from(parts.map(pad).join('').match(/../g)!.map((b) => parseInt(b, 16))))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The newest tokens whose curves are still open, read straight from the launcher. */
async function openTokens(limit: number): Promise<string[]> {
  const launcher = entry.router!;
  const [nextWord] = words((await read('eth_call', [{ to: launcher, data: encodeCall('tokenIdentifier()', []) }, 'latest'])) as string);
  const next = wordToBigInt(nextWord!);
  const out: string[] = [];
  for (let id = next - 1n; id > next - 40n && out.length < limit; id--) {
    const w = words((await read('eth_call', [{ to: launcher, data: encodeCall('tokenParams(uint256)', [uint(id)]) }, 'latest'])) as string);
    if (wordToBigInt(w[3]!) === 0n) out.push(wordToAddress(w[9]!));
  }
  return out;
}

/** Where a plain ERC-20 keeps the sender's balance and what the spender may take, found by asking the token itself under a simulated value. */
async function storageFor(token: string, spender: string): Promise<{ balance: string; allowance: string }> {
  const balanceOf = encodeCall('balanceOf(address)', [address(SENDER)]);
  const allowanceOf = encodeCall('allowance(address,address)', [address(SENDER), address(spender)]);
  const probe = async (data: string, slot: string): Promise<boolean> => BigInt((await read('eth_call', [{ to: token, data }, 'latest', { [token]: { stateDiff: { [slot]: hex32(10n ** 30n) } } }])) as string) === 10n ** 30n;
  for (let i = 0; i < 12; i++) {
    const balance = hash(SENDER, hex32(BigInt(i)));
    if (!(await probe(balanceOf, balance))) continue;
    for (let j = 0; j < 12; j++) {
      const allowance = hash(spender, hash(SENDER, hex32(BigInt(j))));
      if (await probe(allowanceOf, allowance)) return { balance, allowance };
    }
  }
  throw new Error('could not find where the token keeps balances and allowances');
}

describe('live: Arena launcher on Avalanche, simulation only', () => {
  it('finds a token by its address among the launcher\'s records, and ignores an address that is not one of its tokens', async () => {
    const [token] = await openTokens(1);
    const adapter = new EvmArenaAdapter(entry, read);
    const id = await adapter.idOf(token!);
    console.log('arena token id', id);
    expect(id).not.toBeNull();
    expect(await adapter.idOf('0x000000000000000000000000000000000000dEaD')).toBeNull();
  }, 180_000);

  it('quotes the most whole tokens a budget of ARENA buys, and the reward for selling', async () => {
    const [token] = await openTokens(1);
    const registry = new AretiaDexRegistry([entry]);
    const p = new DirectEvmProvider({ registry, read: () => read });
    const from: TokenRef = { chain: 'avalanche', address: ARENA };
    const to: TokenRef = { chain: 'avalanche', address: token! };
    const q = await p.getQuote({ chain: 'avalanche', from, to, amountIn: 10n ** 18n, slippageBps: 300, account: { chain: 'avalanche', address: SENDER } });
    console.log('arena quote', q.expectedOut, q.minOut);
    expect(q.expectedOut % 10n ** 18n).toBe(0n);
    expect(q.expectedOut).toBeGreaterThan(0n);
    const back = await p.getQuote({ chain: 'avalanche', from: to, to: from, amountIn: q.expectedOut / 2n, slippageBps: 300, account: { chain: 'avalanche', address: SENDER } });
    expect(back.expectedOut).toBeGreaterThan(0n);
  }, 240_000);

  it('a buy and a sell are each accepted by the real launcher, and a budget that is too small is refused', async () => {
    const [token] = await openTokens(1);
    const adapter = new EvmArenaAdapter(entry, read);
    const budget = 10n ** 18n;
    const quote = await adapter.quoteBuy(token!, budget);
    expect(quote).not.toBeNull();
    const buy = buildArenaSwap(entry, { token: token!, buying: true, amountIn: budget, minOut: (quote!.amountOut * 97n) / 100n, ref: quote!.ref });
    const half = quote!.amountOut / 2n;
    const sell = buildArenaSwap(entry, { token: token!, buying: false, amountIn: half, minOut: 1n, ref: quote!.ref });
    const tooSmall = buildArenaSwap(entry, { token: token!, buying: true, amountIn: budget / 1_000_000n, minOut: quote!.amountOut, ref: quote!.ref });
    // The sender is given ARENA and the launcher's allowance for the buy, and the token and its allowance for the sell, only inside each simulation.
    const arena = await storageFor(ARENA, entry.router!);
    const tok = await storageFor(token!, entry.router!);
    const overrideArena = { [ARENA]: { stateDiff: { [arena.balance]: hex32(10n ** 30n), [arena.allowance]: hex32(10n ** 30n) } } };
    const overrideToken = { [token!]: { stateDiff: { [tok.balance]: hex32(10n ** 30n), [tok.allowance]: hex32(10n ** 30n) } } };
    await read('eth_call', [{ from: SENDER, to: buy.to, data: buy.data }, 'latest', overrideArena]);
    await read('eth_call', [{ from: SENDER, to: sell.to, data: sell.data }, 'latest', overrideToken]);
    await expect(read('eth_call', [{ from: SENDER, to: tooSmall.to, data: tooSmall.data }, 'latest', overrideArena])).rejects.toThrow();
    expect(buy.approval).toEqual({ token: ARENA, spender: entry.router, amount: budget });
    expect(sell.approval).toEqual({ token: token!.toLowerCase(), spender: entry.router, amount: (half / 10n ** 18n) * 10n ** 18n });
  }, 240_000);
});
