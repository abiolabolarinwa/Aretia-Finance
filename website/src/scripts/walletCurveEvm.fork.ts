/**
 * Runs the compiled curve against the REAL Ethereum mainnet contracts, locally: a copy of mainnet state (read lazily over a public RPC,
 * read-only) is loaded into an in-process EVM, and the curve is deployed INTO that copy. It uses Aretia's real, deployed token factory
 * and the real Uniswap V2 router, factory and pair code. Nothing is sent to the network, nothing is spent, no key is involved.
 *
 * Not part of `npm test` (it needs the network). Run it with
 *   npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util @ethereumjs/block @ethereumjs/statemanager
 *   npm run test:curve-fork
 * Set FORK_RPC to use another read-only Ethereum RPC address.
 */
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import curveArtifact from '../../../contracts-evm/AretiaCurve.artifact.json';
import { encodeCreate } from './walletLaunchEvmTx';
import { LAUNCH_EVM_CHAINS } from './walletLaunchEvmCore';
import { POOL_DEXES } from './walletPoolEvmCore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const RPC = process.env.FORK_RPC ?? 'https://ethereum-rpc.publicnode.com';
const ETH = 10n ** 18n;
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const BUYER = '0x00000000000000000000000000000000000b0b01';
const OTHER = '0x00000000000000000000000000000000000b0b02';
const DEAD = '0x000000000000000000000000000000000000dead';
const SUPPLY = 10n ** 27n;
const eth = LAUNCH_EVM_CHAINS.find((c) => c.key === 'ethereum')!;
const dex = POOL_DEXES.find((d) => d.key === 'ethereum')!;

const sel = (sig: string): string => Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8);
const word = (v: bigint | string): string => (typeof v === 'string' ? v.replace(/^0x/, '').toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
const call = (sig: string, ...args: (bigint | string)[]): string => '0x' + sel(sig) + args.map(word).join('');

describe('the compiled curve against real Ethereum mainnet contracts (a local copy)', () => {
  it('graduates into the real Uniswap V2, and refuses a pool someone made at another price', { timeout: 600_000 }, async () => {
    const mod = (name: string): Promise<any> => import(/* @vite-ignore */ name);
    const [vmLib, commonLib, util, blockLib, smLib] = await Promise.all([mod('@ethereumjs/vm'), mod('@ethereumjs/common'), mod('@ethereumjs/util'), mod('@ethereumjs/block'), mod('@ethereumjs/statemanager')]);
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const pinned = await rpc('eth_blockNumber', []);
    const stamp = BigInt((await rpc('eth_getBlockByNumber', [pinned, false])).timestamp);
    // Public nodes do not serve eth_getProof, which the stock RPC state manager uses for accounts: read the three plain fields instead.
    class Fork extends smLib.RPCStateManager {
      async getAccountFromProvider(address: any) {
        const a = address.toString();
        const [bal, nonce, code] = await Promise.all([rpc('eth_getBalance', [a, pinned]), rpc('eth_getTransactionCount', [a, pinned]), rpc('eth_getCode', [a, pinned])]);
        const empty = util.hexToBytes('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
        return util.createAccount({ balance: BigInt(bal), nonce: BigInt(nonce), codeHash: code === '0x' ? empty : keccak_256(util.hexToBytes(code)), storageRoot: util.KECCAK256_RLP });
      }
    }
    const common = new commonLib.Common({ chain: commonLib.Mainnet, hardfork: commonLib.Hardfork.Shanghai });
    const vm = await vmLib.createVM({ common, stateManager: new (Fork as any)({ provider: RPC, blockTag: BigInt(pinned) }) });
    const addr = (a: string) => util.createAddressFromString(a);
    const toHex = (b: Uint8Array) => util.bytesToHex(b);
    const now = stamp + 60n;
    const reason = (ret: Uint8Array): string => {
      const h = toHex(ret);
      if (!h.startsWith('0x08c379a0')) return h.slice(0, 80);
      const len = Number(BigInt('0x' + h.slice(2 + 8 + 64, 2 + 8 + 128)));
      return Buffer.from(h.slice(2 + 8 + 128, 2 + 8 + 128 + len * 2), 'hex').toString();
    };
    const exec = async (from: string, to: string | null, data: string, value = 0n, commit = true) => {
      const block = blockLib.createBlock({ header: { timestamp: now, number: BigInt(pinned) + 1n, gasLimit: 60_000_000n } }, { common });
      if (!commit) await vm.stateManager.checkpoint();
      const r = await vm.evm.runCall({ caller: addr(from), ...(to ? { to: addr(to) } : {}), data: util.hexToBytes(data), value, gasLimit: 50_000_000n, block });
      if (!commit) await vm.stateManager.revert();
      return r;
    };
    const send = async (from: string, to: string, data: string, value = 0n) => {
      const r = await exec(from, to, data, value);
      if (r.execResult.exceptionError) throw new Error(reason(r.execResult.returnValue) || String(r.execResult.exceptionError.error));
      return r;
    };
    const fails = async (from: string, to: string, data: string, value = 0n) => {
      const r = await exec(from, to, data, value);
      expect(r.execResult.exceptionError, 'expected a revert').toBeDefined();
      return reason(r.execResult.returnValue);
    };
    const view = async (to: string, data: string) => toHex((await exec(CREATOR, to, data, 0n, false)).execResult.returnValue);
    const give = async (a: string, wei: bigint) => {
      const acc = (await vm.stateManager.getAccount(addr(a))) ?? util.createAccount({ balance: 0n });
      acc.balance += wei;
      await vm.stateManager.putAccount(addr(a), acc);
    };
    for (const a of [CREATOR, BUYER, OTHER]) await give(a, 10n ** 24n);

    // The real checks first: the addresses this project trusts really are what it says.
    expect(BigInt(await view(dex.router, '0xad5c4648'))).toBe(BigInt(dex.wrapped));
    expect(BigInt(await view(dex.router, '0xc45a0155'))).toBe(BigInt(dex.factory));
    expect(BigInt(await view(eth.factory!, '0x' + sel('fee()')))).toBe(eth.feeWei);

    // The curve, deployed into the copy, wired to the real factory and the real router.
    const deployed = await exec(CREATOR, null, '0x' + curveArtifact.curve.bytecode + word(eth.factory!) + word(eth.feeAddress!) + word(dex.router), 0n);
    expect(deployed.execResult.exceptionError).toBeUndefined();
    const curve = deployed.createdAddress!.toString().toLowerCase();
    expect(BigInt(await view(curve, '0x' + sel('weth()')))).toBe(BigInt(dex.wrapped));

    /** Makes a token with Aretia's real factory. Its CREATE nonce is the factory account's nonce just before. */
    const makeToken = async (creator: string) => {
      const nonce = (await vm.stateManager.getAccount(addr(eth.factory!))).nonce as bigint;
      const r = await send(creator, eth.factory!, encodeCreate({ name: 'Fork Test', symbol: 'FORK', decimals: 18, supply: SUPPLY } as any), eth.feeWei);
      const log = r.execResult.logs.find((l: any) => toHex(l[0]).toLowerCase() === eth.factory)!;
      return { token: '0x' + toHex(log[1][1]).slice(-40), nonce };
    };
    const approve = (from: string, token: string, spender: string, amount: bigint) => send(from, token, '0x095ea7b3' + word(spender) + word(amount));
    const tokenBal = async (token: string, who: string) => BigInt(await view(token, '0x70a08231' + word(who)));
    const status = async (token: string) => Number(BigInt('0x' + (await view(curve, call('curves(address)', token))).slice(2, 66)));
    const open = async (creator: string, target: bigint) => {
      const t = await makeToken(creator);
      await approve(creator, t.token, curve, SUPPLY);
      await send(creator, curve, call('createCurve(address,uint256,uint256,uint256)', t.token, t.nonce, SUPPLY, target));
      return t;
    };
    const getPair = async (token: string) => '0x' + (await view(dex.factory, call('getPair(address,address)', token, dex.wrapped))).slice(-40);

    // 1. The happy path. A 3 ETH curve, bought out, then graduated into the real Uniswap V2.
    const a = await open(CREATOR, 3n * ETH);
    expect(await status(a.token)).toBe(1);
    await send(BUYER, curve, call('buy(address,uint256)', a.token, 0n), 100n * ETH);
    expect(await status(a.token)).toBe(2);
    const raised = BigInt('0x' + (await view(curve, call('curves(address)', a.token))).slice(2 + 64 * 11, 2 + 64 * 12));
    const lp = BigInt('0x' + (await view(curve, call('curves(address)', a.token))).slice(2 + 64 * 8, 2 + 64 * 9));
    expect(await getPair(a.token)).toBe('0x0000000000000000000000000000000000000000');
    const grad = await send(OTHER, curve, call('graduate(address)', a.token));
    process.stdout.write(`GAS graduate (real Uniswap V2, new pair) ${grad.execResult.executionGasUsed}
`);
    expect(await status(a.token)).toBe(3);
    const pair = await getPair(a.token);
    expect(pair).not.toBe('0x0000000000000000000000000000000000000000');
    expect(await tokenBal(a.token, pair)).toBeGreaterThanOrEqual(lp - lp / 1000n);
    expect(await tokenBal(dex.wrapped, pair)).toBeGreaterThanOrEqual(raised - raised / 1000n);
    // The pool's liquidity tokens are held by the dead address: locked for good.
    const supply = BigInt(await view(pair, '0x18160ddd'));
    expect(supply > 0n).toBe(true);
    expect(await tokenBal(pair, DEAD)).toBe(supply - 1000n); // Uniswap keeps the first 1000 units of liquidity itself
    // The curve owes nothing and holds no loose liquidity.
    expect(BigInt(await view(curve, '0x' + sel('totalOwed()')))).toBe(0n);
    expect(await tokenBal(pair, curve)).toBe(0n);

    // 2. A pool someone made first at another price: graduation must refuse, and holders can leave after a week.
    const b = await open(CREATOR, 3n * ETH);
    await send(BUYER, curve, call('buy(address,uint256)', b.token, 0n), 100n * ETH);
    // OTHER takes some tokens from the curve and opens the pool at a far-off price on the real router.
    const give2 = (await tokenBal(b.token, BUYER)) / 10n;
    await send(BUYER, b.token, '0xa9059cbb' + word(OTHER) + word(give2));
    await approve(OTHER, b.token, dex.router, give2);
    await send(OTHER, dex.router, '0xf305d719' + word(b.token) + word(give2) + word(give2) + word(ETH / 100n) + word(OTHER) + word(now + 3600n), ETH / 100n);
    expect(await getPair(b.token)).not.toBe('0x0000000000000000000000000000000000000000');
    const why = await fails(OTHER, curve, call('graduate(address)', b.token));
    expect(['UniswapV2Router: INSUFFICIENT_A_AMOUNT', 'UniswapV2Router: INSUFFICIENT_B_AMOUNT', 'pool price']).toContain(why);
    // What happens after that refusal (the curve stays sold out, then after a week holders sell back) is tested in walletCurveEvmContract.test.ts,
    // where a failed call rolls back as the EVM specifies. The lazy mainnet-copy state manager used here does not undo storage writes of a
    // reverted call, so the state after a revert is not checked here.
  });
});
