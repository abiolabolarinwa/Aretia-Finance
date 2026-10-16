/**
 * Runs the real compiled factory (contracts-evm/AretiaTokenFactory.artifact.json) inside an in-process EVM and drives the whole page flow
 * against it: the same calldata the page builds, the same inspector, the same read-back. This is the closest check possible without a
 * network. It is NOT a deployment test: no testnet or mainnet was involved.
 *
 * It needs the EVM library, which is deliberately not a dependency of the website. Install it to run this file:
 *   npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util
 * Without it the whole file is skipped.
 */
import { describe, expect, it } from 'vitest';
import artifact from '../../../contracts-evm/AretiaTokenFactory.artifact.json';
import { SwingsError } from '../swings/core/types.js';
import { LAUNCH_EVM_CHAINS, type EvmLaunchConfig, type LaunchEvmChain } from './walletLaunchEvmCore';
import { CREATE_SELECTOR, FEE_RECIPIENT_SELECTOR, FEE_SELECTOR, TOKEN_CREATED_TOPIC, buildCreateTx, encodeCreate } from './walletLaunchEvmTx';
import { EvmLaunchFlow } from './walletLaunchEvmFlow';

/* eslint-disable @typescript-eslint/no-explicit-any */
let lib: { vm: any; common: any; util: any } | null = null;
try {
  const mod = (name: string): Promise<any> => import(/* @vite-ignore */ name);
  lib = { vm: await mod('@ethereumjs/vm'), common: await mod('@ethereumjs/common'), util: await mod('@ethereumjs/util') };
} catch {
  lib = null;
}

const CREATOR = '0x00000000000000000000000000000000000c0de1';
const FEE_ADDRESS = '0x000000000000000000000000000000000000fee1';
const FEE = 3_000_000_000_000_000n;
const hex = (n: bigint): string => '0x' + n.toString(16);

describe.skipIf(lib === null)('the compiled factory, driven by the page flow', () => {
  async function world() {
    const { vm: vmLib, common: commonLib, util } = lib!;
    const common = new commonLib.Common({ chain: commonLib.Mainnet, hardfork: commonLib.Hardfork.Shanghai });
    const vm = await vmLib.createVM({ common });
    const addr = (a: string) => util.createAddressFromString(a);
    await vm.stateManager.putAccount(addr(CREATOR), util.createAccount({ balance: 10n ** 20n }));
    const toBytes = (h: string) => util.hexToBytes(h);
    const toHex = (b: Uint8Array) => util.bytesToHex(b);
    // The factory is deployed with constructor arguments (fee recipient, fee) appended to its creation code.
    const args = FEE_ADDRESS.slice(2).padStart(64, '0') + FEE.toString(16).padStart(64, '0');
    const deployed = await vm.evm.runCall({ caller: addr(CREATOR), data: toBytes(artifact.factory.bytecode + args), gasLimit: 10_000_000n });
    expect(deployed.execResult.exceptionError).toBeUndefined();
    const factory = deployed.createdAddress!.toString().toLowerCase();

    const receipts = new Map<string, { status: string; logs: unknown[] }>();
    let nonce = 0;
    const run = (call: { from?: string; to: string; data?: string; value?: string }, commit: boolean) =>
      vm.evm.runCall({ caller: addr(call.from ?? CREATOR), to: addr(call.to), data: toBytes(call.data ?? '0x'), value: BigInt(call.value ?? '0x0'), gasLimit: 15_000_000n, skipBalance: true, ...(commit ? {} : {}) });

    const read = async (method: string, params: unknown[]): Promise<unknown> => {
      const p = params as any[];
      if (method === 'eth_chainId') return hex(BigInt(chain.chainId));
      if (method === 'eth_getCode') return toHex(await vm.stateManager.getCode(addr(p[0])));
      if (method === 'eth_getBalance') return hex((await vm.stateManager.getAccount(addr(p[0])))?.balance ?? 0n);
      if (method === 'eth_gasPrice') return hex(1_000_000_000n);
      if (method === 'eth_estimateGas' || method === 'eth_call') {
        const snapshot = await vm.stateManager.checkpoint();
        const r = await run(p[0], false);
        await vm.stateManager.revert();
        void snapshot;
        if (r.execResult.exceptionError) throw new SwingsError('invalid', 'execution reverted');
        return method === 'eth_call' ? toHex(r.execResult.returnValue) : hex(r.execResult.executionGasUsed);
      }
      if (method === 'eth_getTransactionReceipt') return receipts.get(p[0]) ?? null;
      throw new Error(`unexpected ${method}`);
    };

    const sent: any[] = [];
    let wrongChain = false;
    const adapter = {
      getAccounts: async () => [CREATOR],
      getChainId: async () => (wrongChain ? 1 : chain.chainId),
      switchChain: async () => undefined,
      sendTransaction: async (tx: any) => {
        sent.push(tx);
        const before = (await vm.stateManager.getAccount(addr(FEE_ADDRESS)))?.balance ?? 0n;
        void before;
        const r = await run(tx, true);
        nonce += 1;
        const hash = '0x' + nonce.toString(16).padStart(64, '0');
        receipts.set(hash, {
          status: r.execResult.exceptionError ? '0x0' : '0x1',
          logs: (r.execResult.logs ?? []).map((l: any[]) => ({ address: toHex(l[0]), topics: l[1].map(toHex), data: toHex(l[2]) })),
        });
        return hash;
      },
    };
    const chain: LaunchEvmChain = { ...LAUNCH_EVM_CHAINS.find((c) => c.key === 'sepolia')!, feeWei: FEE, factory, feeAddress: FEE_ADDRESS };
    const config = (over: Partial<EvmLaunchConfig> = {}): EvmLaunchConfig => ({ chain, creator: CREATOR, name: 'Aretia Test Token', symbol: 'ATEST', decimals: 18, totalSupplyRaw: 1_000_000n * 10n ** 18n, ...over });
    const flow = new EvmLaunchFlow({ adapter, read, now: () => Date.now(), sleep: async () => undefined });
    return { vm, addr, read, adapter, sent, flow, config, chain, factory, setWrongChain: () => (wrongChain = true), balanceOf: async (a: string) => (await vm.stateManager.getAccount(addr(a)))?.balance ?? 0n };
  }

  it('has the selectors and event topic the page computes', () => {
    expect(artifact.factory.selectors['create(string,string,uint8,uint256)']).toBe(CREATE_SELECTOR.slice(2));
    expect(artifact.factory.selectors['fee()']).toBe(FEE_SELECTOR.slice(2));
    expect(artifact.factory.selectors['feeRecipient()']).toBe(FEE_RECIPIENT_SELECTOR.slice(2));
    expect(TOKEN_CREATED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('creates the token, mints the whole supply to the creator, forwards exactly the fee, and the page reads it all back', async () => {
    const w = await world();
    const review = await w.flow.prepare(w.config());
    expect(review.blockers).toEqual([]);
    const feeBefore = await w.balanceOf(FEE_ADDRESS);
    const out = await w.flow.create(review);
    expect(out.differences).toEqual([]);
    expect((await w.balanceOf(FEE_ADDRESS)) - feeBefore).toBe(FEE);
    expect(await w.balanceOf(w.factory)).toBe(0n);
    expect(w.sent).toHaveLength(1);
  });

  it('the token has no owner, mint, pause or admin function: only the standard ERC-20 surface exists', () => {
    const names = Object.keys(artifact.token.selectors).map((s) => s.split('(')[0]).sort();
    expect(names).toEqual(['allowance', 'approve', 'balanceOf', 'decimals', 'name', 'symbol', 'totalSupply', 'transfer', 'transferFrom']);
    const factoryNames = Object.keys(artifact.factory.selectors).map((s) => s.split('(')[0]).sort();
    expect(factoryNames).toEqual(['create', 'fee', 'feeRecipient']);
  });

  it('the token transfers and enforces balances and allowances', async () => {
    const w = await world();
    const out = await w.flow.create(await w.flow.prepare(w.config()));
    const other = '0x00000000000000000000000000000000000000b2';
    const pad = (a: string) => a.slice(2).padStart(64, '0');
    const call = async (from: string, data: string) => (await w.vm.evm.runCall({ caller: w.addr(from), to: w.addr(out.token), data: lib!.util.hexToBytes(data), gasLimit: 1_000_000n })).execResult;
    expect((await call(CREATOR, '0xa9059cbb' + pad(other) + (5n).toString(16).padStart(64, '0'))).exceptionError).toBeUndefined();
    expect((await call(other, '0xa9059cbb' + pad(CREATOR) + (6n).toString(16).padStart(64, '0'))).exceptionError).toBeDefined();
    expect((await call(CREATOR, '0xa9059cbb' + pad('0x' + '0'.repeat(40)) + (1n).toString(16).padStart(64, '0'))).exceptionError).toBeDefined();
    expect((await call(other, '0x23b872dd' + pad(CREATOR) + pad(other) + (1n).toString(16).padStart(64, '0'))).exceptionError).toBeDefined();
  });

  it('refuses a wrong fee, an empty name or symbol, zero supply and 19 decimals', async () => {
    const w = await world();
    const run = async (value: bigint, args: Parameters<typeof encodeCreate>[0]) =>
      (await w.vm.evm.runCall({ caller: w.addr(CREATOR), to: w.addr(w.factory), data: lib!.util.hexToBytes(encodeCreate(args)), value, gasLimit: 15_000_000n })).execResult.exceptionError;
    const ok = { name: 'A', symbol: 'A', decimals: 6, supply: 1n };
    expect(await run(FEE, ok)).toBeUndefined();
    expect(await run(FEE - 1n, ok)).toBeDefined();
    expect(await run(FEE + 1n, ok)).toBeDefined();
    expect(await run(0n, ok)).toBeDefined();
    expect(await run(FEE, { ...ok, name: '' })).toBeDefined();
    expect(await run(FEE, { ...ok, symbol: '' })).toBeDefined();
    expect(await run(FEE, { ...ok, supply: 0n })).toBeDefined();
    expect(await run(FEE, { ...ok, decimals: 19 })).toBeDefined();
    expect(await run(FEE, { ...ok, name: 'x'.repeat(33) })).toBeDefined();
  });

  it('prepare refuses a factory whose on-chain fee or recipient differs from the page table', async () => {
    const w = await world();
    const wrongFee = await w.flow.prepare(w.config({ chain: { ...w.chain, feeWei: FEE + 1n } }));
    expect(wrongFee.blockers.join(' ')).toMatch(/different fee/);
    const wrongTo = await w.flow.prepare(w.config({ chain: { ...w.chain, feeAddress: '0x000000000000000000000000000000000000dead' } }));
    expect(wrongTo.blockers.join(' ')).toMatch(/different address/);
    const noFactory = await w.flow.prepare(w.config({ chain: { ...w.chain, factory: '0x000000000000000000000000000000000000beef' } }));
    expect(noFactory.blockers.join(' ')).toMatch(/not on/);
  });

  it('does not send when the wallet is on the wrong network', async () => {
    const w = await world();
    const review = await w.flow.prepare(w.config());
    w.setWrongChain();
    // switchChain does nothing here, so the wallet still reports network 1: the inspector must stop it.
    await expect(w.flow.create(review)).rejects.toThrow(/Not signing/);
    expect(w.sent).toHaveLength(0);
  });

  it('the calldata the builder writes is what the factory decodes (a long, non-ASCII name round-trips)', async () => {
    const w = await world();
    const cfg = w.config({ name: 'Ünïcode Тoken 日本', symbol: 'UNI9' });
    const out = await w.flow.create(await w.flow.prepare(cfg));
    expect(out.differences).toEqual([]);
    expect(buildCreateTx(cfg).data).toBe(encodeCreate({ name: cfg.name, symbol: cfg.symbol, decimals: 18, supply: cfg.totalSupplyRaw }));
  });
});
