/**
 * Read-only live proof of the two-step route on Base: ETH for a Virtuals agent token, through VIRTUAL. The first step (ETH to
 * VIRTUAL, with the 0.58% Aretia fee) is quoted, built and simulated against the real contracts. The second step (VIRTUAL to the
 * agent token) is quoted when the route is quoted, and built from what "arrived": the test plays the part of the first step
 * having been confirmed by giving the sender that VIRTUAL inside each simulation. Nothing is signed or sent.
 */
import { describe, expect, it } from 'vitest';
import { isEvmPayload } from '../chains/evm.js';
import { publicRead, type EvmRead } from '../chains/evmSession.js';
import { keccak256 } from '../core/keccak.js';
import { liveFeeConfig } from '../core/fee.js';
import { EVM_NATIVE_ADDRESS, type TokenRef } from '../core/types.js';
import { address, encodeCall, selector } from '../engine/abi.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { ChainedEvmProvider } from './chainedEvm.js';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_DEXES, EVM_LAUNCHPADS } from './entries.js';
import { EvmVirtualsAdapter } from './evmVirtuals.js';

const entry = EVM_LAUNCHPADS.find((e) => e.id === 'virtuals-base')!;
const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const FEE_ADDRESS = '0x' + '9'.repeat(40);
const VIRTUAL = entry.quoteAsset!;
const hex32 = (v: bigint): string => '0x' + v.toString(16).padStart(64, '0');
const pad = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hash = (...parts: string[]): string => '0x' + [...keccak256(Uint8Array.from(parts.map(pad).join('').match(/../g)!.map((b) => parseInt(b, 16))))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function openToken(read: EvmRead): Promise<string> {
  const res = await fetch('https://api.virtuals.io/api/virtuals?filters%5Bstatus%5D=1&filters%5Bchain%5D=BASE&sort%5B0%5D=createdAt%3Adesc&pagination%5BpageSize%5D=30&pagination%5Bpage%5D=1');
  const body = (await res.json()) as { data?: { preToken?: string | null }[] };
  const adapter = new EvmVirtualsAdapter(entry, read);
  for (const t of body.data ?? []) if (typeof t.preToken === 'string' && (await adapter.quoteBuy(t.preToken, 10n ** 18n)) !== null) return t.preToken.toLowerCase();
  throw new Error('no open Virtuals curve found');
}

async function slots(read: EvmRead): Promise<{ balance: string; allowance: string }> {
  const probe = async (data: string, slot: string): Promise<boolean> => BigInt((await read('eth_call', [{ to: VIRTUAL, data }, 'latest', { [VIRTUAL]: { stateDiff: { [slot]: hex32(10n ** 30n) } } }])) as string) === 10n ** 30n;
  for (let i = 0; i < 12; i++) {
    const balance = hash(SENDER, hex32(BigInt(i)));
    if (!(await probe(encodeCall('balanceOf(address)', [address(SENDER)]), balance))) continue;
    for (let j = 0; j < 12; j++) {
      const allowance = hash(entry.quoter!, hash(SENDER, hex32(BigInt(j))));
      if (await probe(encodeCall('allowance(address,address)', [address(SENDER), address(entry.quoter!)]), allowance)) return { balance, allowance };
    }
  }
  throw new Error('could not find the VIRTUAL storage slots');
}

describe('live: two steps on Base (ETH, then VIRTUAL, then a Virtuals agent token), simulation only', () => {
  it('quotes, builds the first step, and builds the second from what arrived, each accepted by the real contracts', async () => {
    const real = publicRead('base');
    const token = await openToken(real);
    const s = await slots(real);
    let arrived = false;
    // The sender is given ETH for the first step and, once the first step has "arrived", the VIRTUAL it delivered, only inside each simulation.
    const read: EvmRead = async (method, params) => {
      if (method === 'eth_getBalance' && String(params[0]).toLowerCase() === SENDER) return '0x' + (10n ** 21n).toString(16);
      const call = (params[0] ?? {}) as { to?: string; data?: string };
      if (method === 'eth_call' && call.to?.toLowerCase() === VIRTUAL && call.data?.startsWith('0x' + selector('balanceOf(address)'))) return hex32(arrived ? 10n ** 24n : 0n);
      if (method === 'eth_call') {
        const overrides = { [SENDER]: { balance: '0x' + (10n ** 21n).toString(16) }, ...(arrived ? { [VIRTUAL]: { stateDiff: { [s.balance]: hex32(10n ** 24n), [s.allowance]: hex32(10n ** 24n) } } } : {}) };
        return real('eth_call', [params[0], params[1] ?? 'latest', overrides]);
      }
      return real(method, params);
    };
    const registry = new AretiaDexRegistry([...EVM_DEXES.filter((e) => e.chain === 'base')]);
    const first = new DirectEvmProvider({ registry, read: () => read, fee: liveFeeConfig(FEE_ADDRESS) });
    const second = new DirectEvmProvider({ registry, read: () => read });
    const chained = new ChainedEvmProvider({ first, second, registry, read: () => read });

    const from: TokenRef = { chain: 'base', address: EVM_NATIVE_ADDRESS };
    const to: TokenRef = { chain: 'base', address: token };
    const quote = await chained.getQuote({ chain: 'base', from, to, amountIn: 10n ** 16n, slippageBps: 300, account: { chain: 'base', address: SENDER } });
    console.log('chained quote', quote.expectedOut, quote.minOut, quote.route.legs.map((l) => l.venue), 'fee', quote.costs.aretiaFee.amount);
    expect(quote.providerId).toBe('aretia-chain');
    expect(quote.costs.aretiaFee.amount).toBe((10n ** 16n * 58n) / 10_000n);
    expect(quote.route.legs.length).toBeGreaterThanOrEqual(2);
    expect(quote.minOut).toBeGreaterThan(0n);

    const prepared = await chained.buildTransaction(quote);
    console.log('chained first step', prepared.simulation.ok, prepared.simulation.blockers, prepared.simulation.warnings.length);
    expect(prepared.simulation.blockers).toEqual([]);
    expect(isEvmPayload(prepared.payload)).toBe(true);
    const p1 = prepared.payload as { nextStep?: () => Promise<{ swap: { to: string }; fee?: unknown }>; fee?: { amount: bigint }; swap: { to: string } };
    expect(p1.fee?.amount).toBe(quote.costs.aretiaFee.amount);
    expect(typeof p1.nextStep).toBe('function');
    expect(prepared.simulation.warnings.join(' ')).toMatch(/two steps/);

    arrived = true;
    const p2 = await p1.nextStep!();
    console.log('chained second step goes to', p2.swap.to, 'fee on it', p2.fee ?? null);
    expect(p2.swap.to.toLowerCase()).toBe(entry.router!.toLowerCase());
    expect(p2.fee ?? null).toBeNull();
  }, 280_000);
});
