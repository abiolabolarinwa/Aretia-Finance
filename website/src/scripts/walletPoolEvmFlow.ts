/**
 * Aretia Launch, Ethereum-style chains: the steps that open a pool, with every outside dependency passed in so each path can be tested without
 * a network or a wallet. walletPoolEvm.ts connects it to the page.
 *
 *   prepare   read the exchange from the chain and refuse it unless its factory and wrapped coin are the ones this page expects; check the token,
 *             the balances, and that no pool with liquidity already exists for the pair
 *   create    approval for exactly the tokens (inspect, simulate, send, wait, read the allowance back), then the pool transaction (new deadline,
 *             inspect, simulate, send, wait), then read the pool back and compare its reserves and where the liquidity went with the approval
 * The approval and the pool are two transactions. If the second cannot go ahead, the approval stays in place for exactly the tokens approved and
 * nothing else has happened; the error says so.
 */
import { SwingsError } from '../swings/core/types.js';
import type { EvmFlowDeps } from './walletLaunchEvmFlow';
import { toHexQuantity } from './walletLaunchEvmTx';
import type { PoolConfig } from './walletPoolEvmCore';
import { SEL, buildAddTx, buildApproveTx, inspectAddTx, inspectApproveTx } from './walletPoolEvmTx';

export interface PoolFlowDeps extends EvmFlowDeps {
  /** Unix seconds. */
  nowSeconds(): number;
}

export interface PoolReview {
  config: PoolConfig;
  approveTx: import('../swings/chains/evmWallet.js').EvmTxRequest;
  /** A rough ceiling for the gas of both transactions, in wei. Null if it could not be estimated. */
  gasCostWei: bigint | null;
  coinBalance: bigint;
  tokenBalance: bigint;
  blockers: string[];
}

export type PoolProgress = 'checking' | 'approving' | 'confirming-approve' | 'adding' | 'confirming' | 'verifying' | 'done';

export interface PoolOutcome {
  pair: string;
  approveHash: string;
  addHash: string;
  differences: string[];
}

export class PoolError extends Error {
  constructor(
    message: string,
    readonly nothingSent = false,
  ) {
    super(message);
  }
}

const ZERO = '0x0000000000000000000000000000000000000000';
const asBig = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);
const word = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? BigInt(v) : null);
const addr = (v: unknown): string | null => (typeof v === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(v) ? '0x' + v.slice(-40).toLowerCase() : null);
const pad = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');
/** Reserves word pair from getReserves(): [reserve0, reserve1] (the third word is a timestamp). */
const reservesOf = (v: unknown): [bigint, bigint] | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{192}$/.test(v) ? [BigInt('0x' + v.slice(2, 66)), BigInt('0x' + v.slice(66, 130))] : null);

const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;
/** What a first-liquidity transaction costs in gas on these exchanges is a bit under this; used only for the balance check and the shown ceiling. */
const ADD_GAS_CEILING = 450_000n;

export class PoolFlow {
  constructor(private readonly d: PoolFlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  private call = (to: string, data: string): Promise<unknown> => this.d.read('eth_call', [{ to, data }, 'latest']);

  async prepare(config: PoolConfig): Promise<PoolReview> {
    const { dex } = config;
    const { read } = this.d;
    const blockers: string[] = [];
    let approveTx = buildApproveTx(config);
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    let tokenBalance = 0n;
    try {
      if (asBig(await read('eth_chainId', [])) !== BigInt(dex.chainId)) blockers.push(`The network node did not answer as the right network. Try again in a moment.`);
      else {
        const [routerCode, tokenCode] = await Promise.all([read('eth_getCode', [dex.router, 'latest']), read('eth_getCode', [config.token, 'latest'])]);
        if (typeof routerCode !== 'string' || routerCode === '0x') blockers.push(`${dex.name}’s router is not on this network at the address this page expects, so nothing was sent.`);
        if (typeof tokenCode !== 'string' || tokenCode === '0x') blockers.push('There is no token at that address on this network.');
        if (blockers.length === 0) {
          const [factory, wrapped] = await Promise.all([this.call(dex.router, SEL.routerFactory), this.call(dex.router, SEL.routerWeth)]);
          if (addr(factory) !== dex.factory || addr(wrapped) !== dex.wrapped) blockers.push(`${dex.name}’s router does not report the factory and wrapped coin this page expects, so nothing was sent.`);
        }
        if (blockers.length === 0) {
          tokenBalance = word(await this.call(config.token, SEL.balanceOf + pad(config.creator))) ?? 0n;
          coinBalance = asBig(await read('eth_getBalance', [config.creator, 'latest'])) ?? 0n;
          if (tokenBalance < config.tokenRaw) blockers.push(`You hold fewer ${config.tokenSymbol} than the amount you want to put in.`);
          const pair = addr(await this.call(dex.factory, SEL.getPair + pad(config.token) + pad(dex.wrapped)));
          if (pair && pair !== ZERO) {
            const r = reservesOf(await this.call(pair, SEL.getReserves));
            if (r === null) blockers.push('A pool for this token already exists and could not be read, so nothing was sent.');
            else if (r[0] > 0n || r[1] > 0n) blockers.push('A pool for this token already exists with liquidity in it, at a price that is not yours. This page only opens a new pool.');
          }
        }
        if (blockers.length === 0) {
          try {
            const gas = asBig(await read('eth_estimateGas', [approveTx]));
            const price = asBig(await read('eth_gasPrice', []));
            if (gas === null || price === null) throw new Error('no estimate');
            const limit = (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
            gasCostWei = (limit + ADD_GAS_CEILING) * price;
            approveTx = { ...approveTx, gas: toHexQuantity(limit) };
          } catch {
            blockers.push('The network would not accept the approval, so nothing was sent.');
          }
          if (blockers.length === 0 && coinBalance < config.coinWei + (gasCostWei ?? 0n)) blockers.push(`You need more ${dex.symbol}: the amount for the pool plus the network gas for both transactions.`);
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this pool. Try again in a moment.');
    }
    return { config, approveTx, gasCostWei, coinBalance, tokenBalance, blockers };
  }

  private async receipt(hash: string): Promise<{ status?: string } | null> {
    const deadline = this.d.now() + 180_000;
    while (this.d.now() < deadline) {
      try {
        const r = (await this.d.read('eth_getTransactionReceipt', [hash])) as { status?: string } | null;
        if (r) return r;
      } catch {
        // not answered yet
      }
      await this.sleep(2_000);
    }
    return null;
  }

  private async send(tx: import('../swings/chains/evmWallet.js').EvmTxRequest, what: string): Promise<string> {
    try {
      return await this.d.adapter.sendTransaction(tx);
    } catch (e) {
      const rejected = e instanceof SwingsError && e.code === 'rejected';
      throw new PoolError(rejected ? 'You closed the wallet without approving.' : `The ${what} was not sent: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160)}`, false);
    }
  }

  async create(review: PoolReview, progress: (p: PoolProgress) => void = () => undefined): Promise<PoolOutcome> {
    const { config } = review;
    const { dex } = config;
    if (review.blockers.length > 0) throw new PoolError(review.blockers.join(' '), true);
    progress('checking');
    const account = (await this.d.adapter.getAccounts())[0];
    if (!account || account.toLowerCase() !== config.creator) throw new PoolError('The account selected in your wallet changed. Start again.', true);
    if ((await this.d.adapter.getChainId()) !== dex.chainId) {
      try {
        await this.d.adapter.switchChain(dex.chainId);
      } catch (e) {
        throw new PoolError(e instanceof Error ? e.message : 'Your wallet could not switch networks.', true);
      }
    }
    const approveProblems = inspectApproveTx(review.approveTx, config, await this.d.adapter.getChainId());
    if (approveProblems.length > 0) throw new PoolError(`Not signing: ${approveProblems.join(' ')}`, true);
    try {
      await this.d.read('eth_call', [{ from: review.approveTx.from, to: review.approveTx.to, data: review.approveTx.data, value: '0x0' }, 'latest']);
    } catch {
      throw new PoolError('The network would refuse the approval, so nothing was sent.', true);
    }

    progress('approving');
    const approveHash = await this.send(review.approveTx, 'approval');
    progress('confirming-approve');
    const ar = await this.receipt(approveHash);
    if (!ar) throw new PoolError(`The approval was sent but has not confirmed yet. Check ${approveHash} on an explorer, then start again.`);
    if (ar.status !== '0x1') throw new PoolError(`The approval failed on the network. Nothing was approved or spent except the gas. (${approveHash})`);
    const allowance = word(await this.call(config.token, SEL.allowance + pad(config.creator) + pad(dex.router)));
    if (allowance !== config.tokenRaw) throw new PoolError(`The approval confirmed but the allowance is not exactly what you approved, so the pool was not opened. Your tokens did not move. (${approveHash})`);

    // The pool transaction is built now, so its deadline starts now.
    const now = this.d.nowSeconds();
    let addTx = buildAddTx(config, now);
    const stuck = 'The approval is in place for exactly the tokens you chose, and nothing else has happened. You can start again to open the pool.';
    const addProblems = inspectAddTx(addTx, config, await this.d.adapter.getChainId(), now);
    if (addProblems.length > 0) throw new PoolError(`Not signing the pool: ${addProblems.join(' ')} ${stuck}`);
    try {
      const gas = asBig(await this.d.read('eth_estimateGas', [addTx]));
      const price = asBig(await this.d.read('eth_gasPrice', []));
      if (gas === null || price === null) throw new Error('no estimate');
      addTx = { ...addTx, gas: toHexQuantity((gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN) };
      await this.d.read('eth_call', [{ from: addTx.from, to: addTx.to, data: addTx.data, value: addTx.value }, 'latest']);
    } catch {
      throw new PoolError(`The network would refuse to open the pool, so it was not sent. ${stuck}`);
    }

    progress('adding');
    const addHash = await this.send(addTx, 'pool transaction').catch((e: PoolError) => {
      throw new PoolError(`${e.message} ${stuck}`);
    });
    progress('confirming');
    const rr = await this.receipt(addHash);
    if (!rr) throw new PoolError(`The pool transaction was sent but has not confirmed yet. Check ${addHash} on an explorer.`);
    if (rr.status !== '0x1') throw new PoolError(`The pool transaction failed on the network. No pool was opened; only gas was spent. ${stuck} (${addHash})`);

    progress('verifying');
    const { pair, differences } = await this.readBack(config);
    progress('done');
    return { pair, approveHash, addHash, differences };
  }

  /** Reads the pool from the chain and lists every difference from what was approved (empty means it matches). */
  async readBack(config: PoolConfig): Promise<{ pair: string; differences: string[] }> {
    const { dex } = config;
    const out: string[] = [];
    let pair = ZERO;
    for (let i = 0; i < 6; i++) {
      try {
        pair = addr(await this.call(dex.factory, SEL.getPair + pad(config.token) + pad(dex.wrapped))) ?? ZERO;
      } catch {
        pair = ZERO;
      }
      if (pair !== ZERO) break;
      await this.sleep(1_000);
    }
    if (pair === ZERO) return { pair, differences: ['The new pool could not be read back from the network.'] };
    try {
      const token0 = addr(await this.call(pair, SEL.token0));
      const r = reservesOf(await this.call(pair, SEL.getReserves));
      if (!token0 || !r) throw new Error('unreadable');
      const [tokenReserve, coinReserve] = token0 === config.token ? [r[0], r[1]] : [r[1], r[0]];
      if (tokenReserve !== config.tokenRaw) out.push('The pool does not hold exactly the tokens you put in.');
      if (coinReserve !== config.coinWei) out.push(`The pool does not hold exactly the ${dex.symbol} you put in.`);
      const lp = word(await this.call(pair, SEL.balanceOf + pad(config.lpTo))) ?? 0n;
      if (lp === 0n) out.push(config.lock ? 'No liquidity tokens reached the dead address.' : 'You did not receive the pool’s liquidity tokens.');
    } catch {
      out.push('The new pool could not be read back from the network.');
    }
    return { pair, differences: out };
  }
}
