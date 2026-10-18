/**
 * A live run of the real web flow (walletAretiaPoolEvmFlow.ts, with its inspector) against a real JSON-RPC node and the real deployed
 * contracts. It signs with a THROWAWAY key from a file, through viem, instead of a browser wallet. It refuses every mainnet chain id.
 *
 * Not part of `npm test`. Run it against a test network (or a local test node) with
 *   npm i --no-save viem
 *   POOL_EVM_KEY_FILE=<file holding a throwaway 0x key with test coins> POOL_EVM_CHAIN=sepolia POOL_EVM_RPC=<node url> \
 *   POOL_EVM_POOL=0x... POOL_EVM_FACTORY=0x... npx vitest run --config vitest.devnet.config.ts src/scripts/walletAretiaPoolEvm.devnet.ts
 * The pool and factory are the ones `scripts/pool-evm.mjs deploy` printed (and `verify` passed on). Skipped without POOL_EVM_KEY_FILE.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { LAUNCH_EVM_CHAINS, FEE_ADDRESS, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { encodeCreate } from './walletLaunchEvmTx';
import { evmPoolChain, validateEvmPool, DEFAULT_EVM_POOL_FORM, poolClaimable } from './walletAretiaPoolEvmCore';
import { EvmPoolFlow, type EvmPoolFlowDeps } from './walletAretiaPoolEvmFlow';

const MAINNETS = new Set([1, 56, 137, 8453, 10, 42161, 43114]);
const keyFile = process.env.POOL_EVM_KEY_FILE;
const chainKey = (process.env.POOL_EVM_CHAIN ?? 'sepolia') as LaunchEvmChainKey;
const rpc = process.env.POOL_EVM_RPC;
const poolAddress = process.env.POOL_EVM_POOL;
const factoryAddress = process.env.POOL_EVM_FACTORY;
const ETH = 10n ** 18n;

describe.skipIf(!keyFile || !rpc || !poolAddress || !factoryAddress)('Aretia Pool on a test network, through the real web flow', () => {
  it('creates, trades, adds, claims, redirects fees, locks and transfers, and every read-back matches', { timeout: 900_000 }, async () => {
    const entry = LAUNCH_EVM_CHAINS.find((c) => c.key === chainKey)!;
    if (!entry.testnet || MAINNETS.has(entry.chainId)) throw new Error('This run only works on a test network.');
    const require = createRequire(import.meta.url);
    const viem = require('viem');
    const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
    const key = readFileSync(keyFile!, 'utf8').trim();
    const account = privateKeyToAccount(key);
    const pub = viem.createPublicClient({ transport: viem.http(rpc!, { timeout: 180_000 }) });
    const wallet = viem.createWalletClient({ account, transport: viem.http(rpc!, { timeout: 180_000 }) });
    if ((await pub.getChainId()) !== entry.chainId) throw new Error('The node is not the chain named.');

    const chain = evmPoolChain(chainKey, { [chainKey]: poolAddress!.toLowerCase() }, { [chainKey]: factoryAddress!.toLowerCase() })!;
    const read = async (method: string, params: unknown[]): Promise<unknown> => pub.request({ method, params });
    const send = async (tx: { to: string; data: string; value: string; gas?: string }): Promise<string> => {
      const gas = BigInt((await read('eth_estimateGas', [{ ...tx, from: account.address }])) as string);
      return wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), gas: (gas * 13n) / 10n, chain: null });
    };
    let currentChainId = entry.chainId;
    const deps: EvmPoolFlowDeps = {
      adapter: { getAccounts: async () => [account.address.toLowerCase()], getChainId: async () => currentChainId, switchChain: async (id: number) => void (currentChainId = id), sendTransaction: send as never },
      read: read as never,
      now: () => Date.now(),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    };
    const flow = new EvmPoolFlow(deps);
    const me = account.address.toLowerCase();
    const feeBefore = BigInt(await pub.getBalance({ address: FEE_ADDRESS }));

    // A token, from Aretia's factory on this network.
    const SUPPLY = 10n ** 27n;
    const makeHash = await send({ to: chain.factory, data: encodeCreate({ name: 'Pool Test', symbol: 'PLT', decimals: 18, supply: SUPPLY } as never), value: '0x' + chain.creationFee.toString(16) });
    const made = await pub.waitForTransactionReceipt({ hash: makeHash });
    const log = made.logs.find((l: { address: string }) => l.address.toLowerCase() === chain.factory)!;
    const token = ('0x' + log.topics[1]!.slice(-40)).toLowerCase();
    const t = (await flow.loadToken(chain, me, token))!;
    expect(t.factoryNonce).not.toBeNull();

    // Create with a first buy: the real approval, the real creation.
    const form = { ...DEFAULT_EVM_POOL_FORM, chain: chainKey, token, tokenAmount: '1,000,000,000', startPrice: '0.0000000001', feeTier: '1', firstBuy: '0.0001' };
    const v = validateEvmPool(form, me, t, false, { [chainKey]: chain.pool }, { [chainKey]: chain.factory });
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    const review = await flow.prepareCreate(v.config);
    expect(review.blockers).toEqual([]);
    const created = await flow.run(review);
    expect(created.differences).toEqual([]);
    const pool0 = (await flow.loadPool(chain, token))!;
    expect(pool0.feeBps).toBe(100n);
    const pos0 = (await flow.loadPosition(chain, token, me))!;
    expect(pos0).toMatchObject({ open: true, shares: v.config.l0, locked: v.config.l0 });

    // Buy, sell.
    let pool = pool0;
    const buy = await flow.prepareBuy(chain, me, pool, token, ETH / 10_000n);
    expect(buy.blockers).toEqual([]);
    expect((await flow.run(buy)).differences).toEqual([]);
    pool = (await flow.loadPool(chain, token))!;
    const held = (await flow.loadToken(chain, me, token))!.held;
    const sell = await flow.prepareSell(chain, me, pool, token, held / 10n);
    expect(sell.blockers).toEqual([]);
    expect((await flow.run(sell)).differences).toEqual([]);

    // Add liquidity from the same wallet, then take it out again (the creator's own is locked for good).
    pool = (await flow.loadPool(chain, token))!;
    const add = await flow.prepareAdd(chain, me, pool, token, 10n ** 13n);
    expect(add.blockers).toEqual([]);
    expect((await flow.run(add)).differences).toEqual([]);
    pool = (await flow.loadPool(chain, token))!;
    let pos = (await flow.loadPosition(chain, token, me))!;
    const lockedBefore = pos.locked;
    const rem = await flow.prepareRemove(chain, me, pool, pos, token, 10n ** 13n);
    expect(rem.blockers).toEqual([]);
    expect((await flow.run(rem)).differences).toEqual([]);
    pos = (await flow.loadPosition(chain, token, me))!;
    expect(pos.locked).toBe(lockedBefore);
    // Locked liquidity cannot be taken out: the page refuses before anything is sent.
    pool = (await flow.loadPool(chain, token))!;
    expect((await flow.prepareRemove(chain, me, pool, pos, token, pos.locked)).blockers.join(' ')).toMatch(/not locked/);

    // Claim while locked, redirect the fees to a fresh wallet, trade again, claim to it.
    pool = (await flow.loadPool(chain, token))!;
    expect(poolClaimable(pool, pos)).toBeGreaterThan(0n);
    const claim = await flow.prepareClaim(chain, me, pool, pos, token);
    expect(claim.blockers).toEqual([]);
    expect((await flow.run(claim)).differences).toEqual([]);
    const fresh = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    pos = (await flow.loadPosition(chain, token, me))!;
    const rec = await flow.prepareRecipient(chain, me, pos, token, fresh);
    expect((await flow.run(rec)).differences).toEqual([]);
    const buy2 = await flow.prepareBuy(chain, me, (await flow.loadPool(chain, token))!, token, ETH / 10_000n);
    expect((await flow.run(buy2)).differences).toEqual([]);
    pool = (await flow.loadPool(chain, token))!;
    pos = (await flow.loadPosition(chain, token, me))!;
    const owed = poolClaimable(pool, pos);
    const claim2 = await flow.prepareClaim(chain, me, pool, pos, token);
    expect((await flow.run(claim2)).differences).toEqual([]);
    expect(BigInt(await pub.getBalance({ address: fresh }))).toBe(owed);

    // Aretia was paid inside the trades: the creation fee, plus the token-creation fee, plus 20% of every trading fee.
    const feeAfter = BigInt(await pub.getBalance({ address: FEE_ADDRESS }));
    expect(feeAfter - feeBefore).toBeGreaterThan(chain.creationFee * 2n);

    // Lock the (empty) unlocked part is nothing; transfer the whole position to the fresh wallet.
    const tr = await flow.prepareTransfer(chain, me, pos, token, fresh);
    expect(tr.blockers).toEqual([]);
    expect((await flow.run(tr)).differences).toEqual([]);
    expect((await flow.loadPosition(chain, token, fresh))!.locked).toBe(lockedBefore);
    process.stdout.write(`POOL TEST OK ${chainKey} pool ${chain.pool} token ${token}\n`);
  });
});
