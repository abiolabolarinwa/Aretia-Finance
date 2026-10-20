/**
 * Aretia Launch, Ethereum-style chains: the steps that open a pool, with every outside dependency passed in so each path can be tested without
 * a network or a wallet. walletPoolEvm.ts connects it to the page.
 *
 *   prepare   read the exchange from the chain and refuse it unless its factory and wrapped coin are the ones this page expects; check the token,
 *             the balances, and that no pool with liquidity already exists for the pair
 *   create    approval for exactly the tokens (inspect, simulate, send, wait, read the allowance back), then the pool transaction (new deadline,
 *             inspect, simulate, send, wait), then read the pool back and compare its reserves and where the liquidity went with the approval
 * If someone made the pair first and left dust in it with no liquidity tokens (review finding M-4), the router cannot open it. Then, when
 * Aretia's pair seeder is deployed for the chain (EVM_PAIR_SEEDER_ADDRESSES), the approval names the seeder and the pool transaction is the
 * seeder's `seed`, which opens the pair at exactly the chosen amounts; otherwise the page explains and sends nothing.
 * The approval and the pool are two transactions. If the second cannot go ahead, the approval stays in place for exactly the tokens approved and
 * nothing else has happened; the error says so.
 */
import { SwingsError } from '../swings/core/types.js';
import type { EvmFlowDeps } from './walletLaunchEvmFlow';
import { toHexQuantity } from './walletLaunchEvmTx';
import { EVM_PAIR_SEEDER_ADDRESSES, type PoolConfig } from './walletPoolEvmCore';
import { SEEDER_SEL, SEL, buildAddTx, buildApproveTx, buildFeeTx, buildSeedApproveTx, buildSeedTx, inspectAddTx, inspectApproveTx, inspectFeeTx, inspectSeedTx, seederQuoteData } from './walletPoolEvmTx';

export interface PoolFlowDeps extends EvmFlowDeps {
  /** Unix seconds. */
  nowSeconds(): number;
}

export interface PoolReview {
  config: PoolConfig;
  feeTx: import('../swings/chains/evmWallet.js').EvmTxRequest;
  approveTx: import('../swings/chains/evmWallet.js').EvmTxRequest;
  /** What the person holds of the stablecoin the fee is paid in, in its smallest unit. */
  feeBalance: bigint;
  /** A rough ceiling for the gas of both transactions, in wei. Null if it could not be estimated. */
  gasCostWei: bigint | null;
  coinBalance: bigint;
  tokenBalance: bigint;
  blockers: string[];
  /** Set when the pool must be opened through Aretia's pair seeder (a pair made first with dust in it): the seeder and what it will take. */
  seed?: { seeder: string; pair: string; tokensPaid: bigint; coinPaid: bigint } | null;
}

export type PoolProgress = 'checking' | 'paying-fee' | 'confirming-fee' | 'approving' | 'confirming-approve' | 'adding' | 'confirming' | 'verifying' | 'done';

export interface PoolOutcome {
  /** Aretia's fee transaction, or null if it has not been paid (the pool then exists but the fee is owed: see `payFee`). */
  feeHash: string | null;
  feeError: string | null;
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
  constructor(
    private readonly d: PoolFlowDeps,
    private readonly seeders: Readonly<Partial<Record<string, string | null>>> = EVM_PAIR_SEEDER_ADDRESSES,
  ) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  private call = (to: string, data: string): Promise<unknown> => this.d.read('eth_call', [{ to, data }, 'latest']);

  /** The seeder must have code and be built for this exchange's router, before anything is approved to it (re-audit N-3). */
  private async seederIsGenuine(seeder: string, router: string): Promise<boolean> {
    const code = await this.d.read('eth_getCode', [seeder, 'latest']);
    if (typeof code !== 'string' || code === '0x') return false;
    const r = await this.call(seeder, SEEDER_SEL.router);
    return typeof r === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r) && r.slice(-40).toLowerCase() === router.slice(2).toLowerCase();
  }

  async prepare(config: PoolConfig): Promise<PoolReview> {
    const { dex } = config;
    const { read } = this.d;
    const blockers: string[] = [];
    let approveTx = buildApproveTx(config);
    const feeTx = buildFeeTx(config);
    let feeBalance = 0n;
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    let tokenBalance = 0n;
    let seed: PoolReview['seed'] = null;
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
          // The stablecoin's decimals are read again: the fee amount depends on them, so a contract that reports something else is refused.
          if (word(await this.call(config.fee.token, '0x313ce567')) !== BigInt(config.fee.decimals)) blockers.push(`The ${config.fee.asset} contract on this network is not the one this page expects, so nothing was sent.`);
          else {
            feeBalance = word(await this.call(config.fee.token, SEL.balanceOf + pad(config.creator))) ?? 0n;
            if (feeBalance < config.fee.raw) blockers.push(`You need ${config.fee.raw / 10n ** BigInt(config.fee.decimals)} ${config.fee.asset} for Aretia’s fee, and your wallet holds less.`);
          }
          const pair = addr(await this.call(dex.factory, SEL.getPair + pad(config.token) + pad(dex.wrapped)));
          if (pair && pair !== ZERO) {
            const r = reservesOf(await this.call(pair, SEL.getReserves));
            const supply = word(await this.call(pair, SEL.totalSupply));
            const [balT, balC] = await Promise.all([this.call(config.token, SEL.balanceOf + pad(pair)), this.call(dex.wrapped, SEL.balanceOf + pad(pair))]);
            const dust = r !== null && (r[0] > 0n || r[1] > 0n || (word(balT) ?? 0n) > 0n || (word(balC) ?? 0n) > 0n);
            if (r === null || supply === null) blockers.push('A pool for this token already exists and could not be read, so nothing was sent.');
            else if (supply > 0n) blockers.push('A pool for this token already exists with liquidity in it, owned by whoever added it, at a price that is not yours. This page only opens a new pool.');
            else if (dust) {
              // Someone made the pair first and left dust in it without adding liquidity (review finding M-4): the router cannot open it.
              const seeder = this.seeders[dex.key] ?? null;
              if (!seeder) {
                blockers.push(`Someone already made this token’s pool on ${dex.name} and left a few coins or tokens in it without adding liquidity. That blocks opening it through ${dex.name}’s router. Aretia’s pair seeder, which opens such a pool at exactly your amounts, is not deployed on this network yet, so this page cannot open it.`);
              } else if (!(await this.seederIsGenuine(seeder, dex.router))) {
                blockers.push('Aretia’s pair seeder is not on this network at the address this page expects, or it is not set up for this exchange, so nothing was sent.');
              } else {
                const q = await this.call(seeder, seederQuoteData(config));
                const ok = typeof q === 'string' && /^0x[0-9a-fA-F]{256}$/.test(q) && BigInt('0x' + q.slice(2, 66)) === 1n;
                if (!ok) blockers.push(`Someone already made this token’s pool on ${dex.name} and put more in it than your amounts, so it cannot be opened at your price.`);
                else {
                  const tokensPaid = BigInt('0x' + (q as string).slice(130, 194));
                  const coinPaid = BigInt('0x' + (q as string).slice(194, 258));
                  seed = { seeder: seeder.toLowerCase(), pair, tokensPaid, coinPaid };
                  approveTx = buildSeedApproveTx(config, seed.seeder, tokensPaid);
                }
              }
            }
          }
        }
        if (blockers.length === 0) {
          try {
            const gas = asBig(await read('eth_estimateGas', [approveTx]));
            const feeGas = asBig(await read('eth_estimateGas', [feeTx]));
            const price = asBig(await read('eth_gasPrice', []));
            if (gas === null || price === null || feeGas === null) throw new Error('no estimate');
            const limit = (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
            gasCostWei = (limit + (feeGas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN + ADD_GAS_CEILING) * price;
            approveTx = { ...approveTx, gas: toHexQuantity(limit) };
          } catch {
            blockers.push('The network would not accept the fee or the approval, so nothing was sent.');
          }
          if (blockers.length === 0 && coinBalance < config.coinWei + (gasCostWei ?? 0n)) blockers.push(`You need more ${dex.symbol}: the amount for the pool plus the network gas for both transactions.`);
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this pool. Try again in a moment.');
    }
    return { config, feeTx, feeBalance, approveTx, gasCostWei, coinBalance, tokenBalance, blockers, seed };
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
    const chainNow = await this.d.adapter.getChainId();
    const feeProblems = inspectFeeTx(review.feeTx, config, chainNow);
    if (feeProblems.length > 0) throw new PoolError(`Not signing: ${feeProblems.join(' ')}`, true);
    try {
      await this.d.read('eth_call', [{ from: review.feeTx.from, to: review.feeTx.to, data: review.feeTx.data, value: '0x0' }, 'latest']);
    } catch {
      throw new PoolError('The network would refuse the fee transfer, so nothing was sent.', true);
    }
    const seed = review.seed ?? null;
    const approveProblems = inspectApproveTx(review.approveTx, config, await this.d.adapter.getChainId(), seed ? { seeder: seed.seeder, amount: seed.tokensPaid } : undefined);
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
    if (ar.status !== '0x1') throw new PoolError(`The approval failed on the network; nothing was approved and no fee was charged. (${approveHash})`);
    const allowance = word(await this.call(config.token, SEL.allowance + pad(config.creator) + pad(seed ? seed.seeder : dex.router)));
    if (allowance !== (seed ? seed.tokensPaid : config.tokenRaw)) throw new PoolError(`The approval confirmed but the allowance is not exactly what you approved, so the pool was not opened. Your tokens did not move. (${approveHash})`);

    // The pool transaction is built now, so its deadline starts now.
    const now = this.d.nowSeconds();
    let addTx = seed ? buildSeedTx(config, seed.seeder) : buildAddTx(config, now);
    const stuck = 'The approval is in place for exactly the tokens you chose and no fee was charged. You can start again to open the pool.';
    const addProblems = seed ? inspectSeedTx(addTx, config, seed.seeder, await this.d.adapter.getChainId()) : inspectAddTx(addTx, config, await this.d.adapter.getChainId(), now);
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
    // Aretia's fee is last: asked only once the pool exists and has been read back. If it is not paid here the pool still exists, and the
    // person is told the fee is owed and can pay it from the result screen (`payFee`).
    const fee = await this.payFee(review, progress);
    progress('done');
    return { pair, feeHash: fee.hash, feeError: fee.error, approveHash, addHash, differences };
  }

  /** Sends Aretia's fee (checked, simulated, wallet-signed, confirmed). Never throws: the result says whether it was paid and, if not, why. */
  async payFee(review: PoolReview, progress: (p: PoolProgress) => void = () => undefined): Promise<{ hash: string | null; error: string | null }> {
    const { config } = review;
    try {
      const account = (await this.d.adapter.getAccounts())[0];
      if (!account || account.toLowerCase() !== config.creator) return { hash: null, error: 'The account selected in your wallet changed. Switch back to pay the fee.' };
      if ((await this.d.adapter.getChainId()) !== config.dex.chainId) await this.d.adapter.switchChain(config.dex.chainId);
      const problems = inspectFeeTx(review.feeTx, config, await this.d.adapter.getChainId());
      if (problems.length > 0) return { hash: null, error: `Not signing the fee: ${problems.join(' ')}` };
      await this.d.read('eth_call', [{ from: review.feeTx.from, to: review.feeTx.to, data: review.feeTx.data, value: '0x0' }, 'latest']);
      progress('paying-fee');
      const hash = await this.send(review.feeTx, 'fee transfer');
      progress('confirming-fee');
      const receipt = await this.receipt(hash);
      if (!receipt) return { hash: null, error: `The fee transfer was sent but has not confirmed yet. Check ${hash} on an explorer before paying again.` };
      if (receipt.status !== '0x1') return { hash: null, error: `The fee transfer failed on the network. (${hash})` };
      return { hash, error: null };
    } catch (e) {
      return { hash: null, error: e instanceof PoolError || e instanceof Error ? e.message : 'The fee could not be sent.' };
    }
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
