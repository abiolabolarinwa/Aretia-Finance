/**
 * Aretia Launch, Ethereum-style chains: the steps that create a token, with every outside dependency passed in so each path can be tested
 * without a network or a wallet. walletLaunchEvm.ts connects it to the page.
 *
 *   prepare   read the factory from the chain and refuse it unless its fee and fee address are exactly Aretia's; price the gas; check the balance
 *   create    check the transaction against the approval (independent inspector), simulate it, make sure the wallet is on the right network and
 *             account, have the wallet send it, wait for the receipt, take the token address only from the approved factory's log, then read the
 *             token back from the chain and compare every fact with what was approved
 * It is one transaction, so there is nothing half-made to resume: either the token exists with its whole supply, or nothing happened but gas.
 */
import { SwingsError } from '../swings/core/types.js';
import type { EvmRead } from '../swings/chains/evmSession.js';
import { decodeAbiString } from '../swings/chains/evmSession.js';
import type { EvmTxRequest, EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import { chainEnabled, type EvmLaunchConfig } from './walletLaunchEvmCore';
import { fromSmallestUnit } from './walletTools';
import { FEE_RECIPIENT_SELECTOR, FEE_SELECTOR, buildCreateTx, findCreatedToken, inspectCreateTx, toHexQuantity } from './walletLaunchEvmTx';

export interface EvmFlowDeps {
  adapter: Pick<EvmWalletAdapter, 'getAccounts' | 'getChainId' | 'switchChain' | 'sendTransaction'>;
  /** Reads from the chain the creation is on, without asking the wallet anything. */
  read: EvmRead;
  now(): number;
  sleep?(ms: number): Promise<void>;
}

export interface EvmReview {
  config: EvmLaunchConfig;
  tx: EvmTxRequest;
  /** The most the gas is likely to cost in the native coin's smallest unit, or null if it could not be estimated. */
  gasCostWei: bigint | null;
  balance: bigint;
  /** Reasons the creation cannot go ahead. Empty means it can. */
  blockers: string[];
}

export type EvmProgress = 'checking' | 'signing' | 'confirming' | 'verifying' | 'done';

export interface EvmOutcome {
  token: string;
  txHash: string;
  differences: string[];
}

/** An error whose message is safe and plain to show as it is. `nothingSent` means no transaction left this page. */
export class EvmLaunchError extends Error {
  constructor(
    message: string,
    readonly nothingSent = false,
  ) {
    super(message);
  }
}

const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;
const asBig = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);
const word = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? BigInt(v) : null);
const addressWord = (v: unknown): string | null => (typeof v === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(v) ? '0x' + v.slice(-40).toLowerCase() : null);

/** "You need more ETH", with the numbers a person can act on, instead of the network's raw refusal. */
export function shortfallMessage(symbol: string, balance: bigint, feeWei: bigint, gasCostWei: bigint | null): string {
  const have = fromSmallestUnit(balance, 18);
  const fee = fromSmallestUnit(feeWei, 18);
  if (gasCostWei === null) {
    const short = fromSmallestUnit(feeWei - balance, 18);
    return `You need more ${symbol}. You hold ${have} ${symbol}, and Aretia's fee alone is ${fee} ${symbol}, with the network gas on top. Add at least ${short} ${symbol} plus a little extra for gas, then review again. Nothing was sent.`;
  }
  const need = feeWei + gasCostWei;
  const short = fromSmallestUnit(need - balance, 18);
  return `You need more ${symbol}. You hold ${have} ${symbol}; the fee (${fee}) plus the network gas (about ${fromSmallestUnit(gasCostWei, 18)}) comes to about ${fromSmallestUnit(need, 18)} ${symbol}. Add at least ${short} ${symbol} and review again. Nothing was sent.`;
}

export class EvmLaunchFlow {
  constructor(private readonly d: EvmFlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);

  async prepare(config: EvmLaunchConfig): Promise<EvmReview> {
    const { chain } = config;
    const { read } = this.d;
    const blockers: string[] = [];
    if (!chainEnabled(chain) || !chain.factory || !chain.feeAddress) throw new EvmLaunchError(`Creating tokens on ${chain.name} is not available yet.`, true);
    let tx = buildCreateTx(config);
    let gasCostWei: bigint | null = null;
    let balance = 0n;
    try {
      const nodeChain = asBig(await read('eth_chainId', []));
      if (nodeChain !== BigInt(chain.chainId)) blockers.push(`The network node did not answer as ${chain.name}. Try again in a moment.`);
      else {
        const code = await read('eth_getCode', [chain.factory, 'latest']);
        if (typeof code !== 'string' || code === '0x' || code === '0x0') blockers.push(`Aretia’s token factory is not on ${chain.name} at the address this page expects, so nothing was sent.`);
        else {
          const [fee, recipient] = await Promise.all([read('eth_call', [{ to: chain.factory, data: FEE_SELECTOR }, 'latest']), read('eth_call', [{ to: chain.factory, data: FEE_RECIPIENT_SELECTOR }, 'latest'])]);
          if (word(fee) !== chain.feeWei) blockers.push('The factory on the network charges a different fee from the one this page shows, so nothing was sent.');
          if (addressWord(recipient) !== chain.feeAddress) blockers.push('The factory on the network pays its fee to a different address from the one this page expects, so nothing was sent.');
        }
        balance = asBig(await read('eth_getBalance', [config.creator, 'latest'])) ?? 0n;
        if (blockers.length === 0 && balance < chain.feeWei) {
          // Not even the fee is covered, so the network cannot price the gas either. Say so plainly instead of showing its raw refusal.
          blockers.push(shortfallMessage(chain.symbol, balance, chain.feeWei, null));
        } else if (blockers.length === 0) {
          try {
            const gas = asBig(await read('eth_estimateGas', [tx]));
            const price = asBig(await read('eth_gasPrice', []));
            if (gas === null || price === null) throw new Error('no estimate');
            const limit = (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
            gasCostWei = limit * price;
            tx = { ...tx, gas: toHexQuantity(limit) };
          } catch (e) {
            const why = e instanceof SwingsError ? e.message : '';
            blockers.push(/insufficient funds/i.test(why) ? shortfallMessage(chain.symbol, balance, chain.feeWei, null) : `The network would not accept this creation${why ? `: ${why}` : ''}. Nothing was sent.`);
          }
          const need = chain.feeWei + (gasCostWei ?? 0n);
          if (blockers.length === 0 && balance < need) blockers.push(shortfallMessage(chain.symbol, balance, chain.feeWei, gasCostWei));
        }
      }
    } catch {
      blockers.push(`The ${chain.name} network could not be reached to check this creation. Try again in a moment.`);
    }
    return { config, tx, gasCostWei, balance, blockers };
  }

  /** The receipt for the hash, or null if it has not appeared in time. A node that cannot answer yet is not read as a failure. */
  private async receipt(hash: string): Promise<{ status?: string; logs?: unknown } | null> {
    const deadline = this.d.now() + 180_000;
    while (this.d.now() < deadline) {
      try {
        const r = (await this.d.read('eth_getTransactionReceipt', [hash])) as { status?: string; logs?: unknown } | null;
        if (r) return r;
      } catch {
        // not answered yet
      }
      await this.sleep(2_000);
    }
    return null;
  }

  async create(review: EvmReview, progress: (p: EvmProgress) => void = () => undefined): Promise<EvmOutcome> {
    const { config } = review;
    const { chain } = config;
    if (review.blockers.length > 0) throw new EvmLaunchError(review.blockers.join(' '), true);
    if (!chain.factory) throw new EvmLaunchError('This network has no factory yet.', true);
    progress('checking');

    const account = (await this.d.adapter.getAccounts())[0];
    if (!account || account.toLowerCase() !== config.creator) throw new EvmLaunchError('The account selected in your wallet changed. Start again.', true);
    if ((await this.d.adapter.getChainId()) !== chain.chainId) {
      try {
        await this.d.adapter.switchChain(chain.chainId);
      } catch (e) {
        throw new EvmLaunchError(e instanceof Error ? e.message : 'Your wallet could not switch networks.', true);
      }
    }
    // Checked on the exact object the wallet will receive, against the network the wallet reports now.
    const problems = inspectCreateTx(review.tx, config, await this.d.adapter.getChainId());
    if (problems.length > 0) throw new EvmLaunchError(`Not signing: ${problems.join(' ')}`, true);
    try {
      await this.d.read('eth_call', [{ from: review.tx.from, to: review.tx.to, data: review.tx.data, value: review.tx.value }, 'latest']);
    } catch (e) {
      throw new EvmLaunchError(`The network would refuse this transaction, so it was not sent${e instanceof Error && e.message ? `: ${e.message.slice(0, 160)}` : ''}.`, true);
    }

    progress('signing');
    let hash: string;
    try {
      hash = await this.d.adapter.sendTransaction(review.tx);
    } catch (e) {
      const rejected = e instanceof SwingsError && e.code === 'rejected';
      throw new EvmLaunchError(rejected ? 'You closed the wallet without approving. Nothing was sent.' : `The transaction was not sent: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160)}`, rejected);
    }
    progress('confirming');
    const receipt = await this.receipt(hash);
    if (!receipt) throw new EvmLaunchError(`The transaction was sent but has not confirmed yet. Check ${hash} on ${chain.name}’s explorer. If it lands, the token exists and is in your wallet.`);
    if (receipt.status !== '0x1') throw new EvmLaunchError(`The transaction failed on the network. No token was created; only the network gas was spent. (${hash})`);

    progress('verifying');
    const created = findCreatedToken(receipt.logs, chain.factory, config.creator);
    if (!created) throw new EvmLaunchError(`The transaction confirmed, but it did not report exactly one new token from Aretia’s factory, so do not rely on it. (${hash})`);
    const differences = await this.readBack(created.token, config);
    progress('done');
    return { token: created.token, txHash: hash, differences };
  }

  /** Reads the new token from the chain and returns every difference from what was approved (empty means it matches). */
  async readBack(token: string, config: EvmLaunchConfig): Promise<string[]> {
    const out: string[] = [];
    const call = (data: string): Promise<unknown> => this.d.read('eth_call', [{ to: token, data }, 'latest']);
    // A node can briefly lag behind a transaction it just confirmed: look a few times before calling the token missing.
    let code: unknown = '0x';
    for (let i = 0; i < 6; i++) {
      try {
        code = await this.d.read('eth_getCode', [token, 'latest']);
      } catch {
        code = '0x';
      }
      if (typeof code === 'string' && code !== '0x') break;
      await this.sleep(1_000);
    }
    if (typeof code !== 'string' || code === '0x') return ['The new token could not be read back from the network.'];
    try {
      const [name, symbol, decimals, supply, held] = await Promise.all([
        call('0x06fdde03'),
        call('0x95d89b41'),
        call('0x313ce567'),
        call('0x18160ddd'),
        call('0x70a08231' + config.creator.slice(2).padStart(64, '0')),
      ]);
      if (decodeAbiString(name) !== config.name) out.push('The token’s name is not the one you approved.');
      if (decodeAbiString(symbol) !== config.symbol) out.push('The token’s symbol is not the one you approved.');
      if (word(decimals) !== BigInt(config.decimals)) out.push('The token’s decimals are not the ones you approved.');
      if (word(supply) !== config.totalSupplyRaw) out.push('The token’s total supply is not the one you approved.');
      if (word(held) !== config.totalSupplyRaw) out.push('Your wallet does not hold the whole supply.');
    } catch {
      out.push('The new token could not be read back from the network.');
    }
    return out;
  }
}

/** Plain language for the errors a wallet or the network gives. Never shows raw error objects. */
export function friendlyEvmError(e: unknown): string {
  if (e instanceof EvmLaunchError) return e.message;
  const text = e instanceof Error ? e.message : String(e);
  if (/reject|denied|declin|cancel|closed/i.test(text)) return 'You closed the wallet without approving. Nothing was sent.';
  return `Something went wrong: ${(text.split('\n')[0] ?? '').slice(0, 160)}`;
}
