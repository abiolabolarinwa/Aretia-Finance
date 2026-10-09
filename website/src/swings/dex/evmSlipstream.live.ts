/**
 * Read-only live proof of Slipstream (Aerodrome on Base): the addresses are the venue's own, the
 * quote comes from its quoter, and the transaction Aretia builds, with the 0.29% fee, is accepted by the real router in
 * simulation. Nothing is signed or sent.
 */
import { describe, expect, it } from 'vitest';
import { publicRead, type EvmRead } from '../chains/evmSession.js';
import { liveFeeConfig } from '../core/fee.js';
import { EVM_NATIVE_ADDRESS, type ChainId } from '../core/types.js';
import { encodeCall } from '../engine/abi.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_SLIPSTREAM } from './entries.js';

const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const FEE_ADDRESS = '0x' + '9'.repeat(40);
const word = (r: string): string => '0x' + r.slice(-40);
const USDC: Record<string, string> = { base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', optimism: '0x0b2c639c533813f4aa9d7837caf62653d097ff85' };
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';

const funded = (real: EvmRead): EvmRead => async (method, params) => {
  if (method === 'eth_getBalance' && String(params[0]).toLowerCase() === SENDER) return '0x' + (10n ** 21n).toString(16);
  if (method === 'eth_call') return real('eth_call', [params[0], params[1] ?? 'latest', { [SENDER]: { balance: '0x' + (10n ** 21n).toString(16) } }]);
  return real(method, params);
};

describe('live: Slipstream, simulation only', () => {
  for (const entry of EVM_SLIPSTREAM) {
    it(`${entry.name}: the addresses belong together on the chain`, async () => {
      const read = publicRead(entry.chain);
      const factoryOf = async (to: string): Promise<string> => word((await read('eth_call', [{ to, data: encodeCall('factory()', []) }, 'latest'])) as string);
      expect(await factoryOf(entry.router!)).toBe(entry.factory);
      expect(await factoryOf(entry.quoter!)).toBe(entry.factory);
      const weth = word((await read('eth_call', [{ to: entry.router!, data: encodeCall('WETH9()', []) }, 'latest'])) as string);
      expect(weth).toBe(entry.wrappedNative!.toLowerCase());
    }, 60_000);
  }

  it('quotes ETH for USDC, builds with the fee, and the real router accepts it', async () => {
    for (const entry of EVM_SLIPSTREAM) {
      const chain: ChainId = entry.chain;
      const read = funded(publicRead(chain));
      const provider = new DirectEvmProvider({ registry: new AretiaDexRegistry([entry]), read: () => read, fee: liveFeeConfig(FEE_ADDRESS) });
      const q = await provider.getQuote({ chain, from: { chain, address: EVM_NATIVE_ADDRESS }, to: { chain, address: USDC[chain]! }, amountIn: 10n ** 16n, slippageBps: 100, account: { chain, address: SENDER } });
      const prepared = await provider.buildTransaction(q);
      console.log(entry.id, 'out', q.expectedOut, 'fee', q.costs.aretiaFee.amount, 'ok', prepared.simulation.ok, prepared.simulation.blockers, q.route.legs.map((l) => l.venue));
      expect(q.expectedOut).toBeGreaterThan(0n);
      expect(q.costs.aretiaFee.amount).toBe((10n ** 16n * 29n) / 10_000n);
      expect(prepared.simulation.blockers).toEqual([]);
    }
  }, 240_000);

  it('Base: ETH for AERO, a token whose deepest pool is a Slipstream one', async () => {
    const entry = EVM_SLIPSTREAM[0]!;
    const read = funded(publicRead('base'));
    const provider = new DirectEvmProvider({ registry: new AretiaDexRegistry([entry]), read: () => read, fee: liveFeeConfig(FEE_ADDRESS) });
    const q = await provider.getQuote({ chain: 'base', from: { chain: 'base', address: EVM_NATIVE_ADDRESS }, to: { chain: 'base', address: AERO }, amountIn: 10n ** 16n, slippageBps: 100, account: { chain: 'base', address: SENDER } });
    const prepared = await provider.buildTransaction(q);
    console.log('AERO out', q.expectedOut, 'ok', prepared.simulation.ok, prepared.simulation.blockers);
    expect(prepared.simulation.blockers).toEqual([]);
  }, 120_000);
});
