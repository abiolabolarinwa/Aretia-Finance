/**
 * Read-only live proof of the Uniswap V4 venue: a hookless pool is found through the PoolManager's StateView, priced by the
 * V4 quoter, and the transactions Aretia builds are accepted by the real Universal Router: a buy with the native coin, and a
 * sell of a token through Permit2 (both approvals, then the swap, in order in one simulated block), which also refuses an
 * impossible floor. Nothing is signed or sent; the sender is given balances only inside the simulation.
 */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { keccak256 } from '../core/keccak.js';
import { EVM_NATIVE_ADDRESS, type ChainId, type TokenRef } from '../core/types.js';
import { address, encodeCall } from '../engine/abi.js';
import { encodeFunction } from '../engine/abiGeneric.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { EVM_V4 } from './entries.js';
import { buildV4Swap, EvmV4Adapter, PERMIT2, permit2ApproveCall, ZERO_ADDRESS } from './evmV4.js';
import { DirectEvmProvider } from './directEvm.js';

const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const USDC: Record<string, string> = { ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' };
const SIM_RPC: Record<string, string> = { ethereum: 'https://ethereum-rpc.publicnode.com', base: 'https://base-rpc.publicnode.com' };
const hex32 = (v: bigint): string => '0x' + v.toString(16).padStart(64, '0');
const pad = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hash = (...parts: string[]): string => '0x' + [...keccak256(Uint8Array.from(parts.map(pad).join('').match(/../g)!.map((b) => parseInt(b, 16))))].map((b) => b.toString(16).padStart(2, '0')).join('');

for (const chain of ['ethereum', 'base'] as const) {
  const entry = EVM_V4.find((e) => e.chain === chain)!;
  const read = publicRead(chain);
  const usdc = USDC[chain]!;

  describe(`live: Uniswap V4 on ${chain}, simulation only`, () => {
    it('finds a hookless ETH/USDC pool and prices it both ways', async () => {
      const a = new EvmV4Adapter(entry, read);
      const buy = await a.bestRoute(ZERO_ADDRESS, usdc, 10n ** 17n);
      console.log(chain, 'v4 buy USDC for 0.1 ETH', buy && [buy.key.fee, buy.amountOut]);
      expect(buy).not.toBeNull();
      const sell = await a.bestRoute(usdc, ZERO_ADDRESS, buy!.amountOut);
      console.log(chain, 'v4 sell that USDC', sell && [sell.key.fee, sell.amountOut]);
      expect(sell).not.toBeNull();
    }, 120_000);

    it('the router quotes the native coin for USDC and builds a transaction the real router accepts, and refuses an impossible floor', async () => {
      const registry = new AretiaDexRegistry([entry]);
      const p = new DirectEvmProvider({ registry, read: () => read });
      const from: TokenRef = { chain: chain as ChainId, address: EVM_NATIVE_ADDRESS };
      const to: TokenRef = { chain: chain as ChainId, address: usdc };
      const q = await p.getQuote({ chain, from, to, amountIn: 10n ** 16n, slippageBps: 100, account: { chain, address: SENDER } });
      console.log(chain, 'v4 quote', q.expectedOut, q.minOut, q.priceImpactBps);
      const plan = buildV4Swap(entry, { key: (q.raw as { v4: { key: Parameters<typeof buildV4Swap>[1]['key'] } }).v4.key, zeroForOne: true, amountIn: 10n ** 16n, minOut: q.minOut, deadline: Math.floor(Date.now() / 1000) + 1200 });
      // A sender with ETH is simulated by giving it a balance, so the check does not depend on who holds ETH today.
      const withBalance = { [SENDER]: { balance: '0x' + (10n ** 20n).toString(16) } };
      await read('eth_call', [{ from: SENDER, to: plan.to, data: plan.data, value: '0x' + plan.value.toString(16) }, 'latest', withBalance]);
      const bad = buildV4Swap(entry, { key: (q.raw as { v4: { key: Parameters<typeof buildV4Swap>[1]['key'] } }).v4.key, zeroForOne: true, amountIn: 10n ** 16n, minOut: q.expectedOut * 10n, deadline: Math.floor(Date.now() / 1000) + 1200 });
      await expect(read('eth_call', [{ from: SENDER, to: bad.to, data: bad.data, value: '0x' + bad.value.toString(16) }, 'latest', withBalance])).rejects.toThrow();
    }, 180_000);

    it('a token sell is accepted after its two approvals, in order in one simulated block', async () => {
      const a = new EvmV4Adapter(entry, read);
      const sellAmount = 50_000_000n;
      const route = await a.bestRoute(usdc, ZERO_ADDRESS, sellAmount);
      expect(route).not.toBeNull();
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const plan = buildV4Swap(entry, { key: route!.key, zeroForOne: route!.zeroForOne, amountIn: sellAmount, minOut: (route!.amountOut * 99n) / 100n, deadline });
      expect(plan.approval).toEqual({ token: usdc, spender: PERMIT2, amount: sellAmount });
      // Find where USDC keeps the sender's balance, by asking the token itself under a simulated value.
      const balanceOf = encodeCall('balanceOf(address)', [address(SENDER)]);
      let slot: string | null = null;
      for (let i = 0; i < 12 && slot === null; i++) {
        const s = hash(SENDER, hex32(BigInt(i)));
        const got = (await read('eth_call', [{ to: usdc, data: balanceOf }, 'latest', { [usdc]: { stateDiff: { [s]: hex32(10n ** 12n) } } }])) as string;
        if (BigInt(got) === 10n ** 12n) slot = s;
      }
      expect(slot).not.toBeNull();
      const res = await fetch(SIM_RPC[chain]!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_simulateV1',
          params: [{ blockStateCalls: [{ stateOverrides: { [usdc]: { stateDiff: { [slot!]: hex32(10n ** 12n) } } }, calls: [
            { from: SENDER, to: usdc, data: encodeFunction('approve(address,uint256)', [PERMIT2, sellAmount]) },
            { from: SENDER, to: PERMIT2, data: permit2ApproveCall(usdc, entry.router!, sellAmount, deadline + 3600) },
            { from: SENDER, to: plan.to, data: plan.data },
          ] }], validation: false }, 'latest'],
        }),
      });
      const body = (await res.json()) as { result?: { calls: { status: string; error?: { message: string } }[] }[]; error?: { message: string } };
      const calls = body.result?.[0]?.calls;
      console.log(chain, 'v4 approve+permit2+sell statuses', calls?.map((c) => c.status), body.error?.message ?? calls?.find((c) => c.error)?.error?.message);
      expect(calls?.map((c) => c.status)).toEqual(['0x1', '0x1', '0x1']);
    }, 180_000);
  });
}
