/**
 * Send from an Ethereum-style account: a native coin or an ERC-20 token to an address, on one network. Checks run before
 * the wallet is asked, and the wallet itself signs and broadcasts: Aretia holds no keys. Reads go through public nodes.
 */
import { CHAINS, EVM_NATIVE_ADDRESS, SwingsError, type ChainId } from '../swings/core/types.js';
import { hasValidChecksum, toChecksumAddress } from '../swings/core/keccak.js';
import { encodeTransfer } from '../swings/chains/evmFee.js';
import { readBalance, type EvmRead } from '../swings/chains/evmSession.js';
import type { EvmTxRequest, EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import { fromSmallestUnit, toSmallestUnit } from './walletTools';

const ZERO = '0x0000000000000000000000000000000000000000';
const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
const hex = (n: bigint): string => '0x' + n.toString(16);

export const EVM_EXPLORER_TX: Readonly<Record<string, string>> = {
  ethereum: 'https://etherscan.io/tx/',
  bnb: 'https://bscscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
  base: 'https://basescan.org/tx/',
  robinhood: 'https://robinhoodchain.blockscout.com/tx/',
};

/** The recipient as typed: the checksummed address to use, or the first problem in plain words. */
export function checkEvmRecipient(target: string, from: string): { address: string; problem: null } | { address: null; problem: string } {
  const t = target.trim();
  const no = (problem: string) => ({ address: null, problem }) as const;
  if (!t) return no('Enter the address to send to.');
  if (!isAddr(t)) return no(/^0x/i.test(t) ? 'That address is the wrong length or has characters that are not hex. Check it for a missing or extra character.' : 'Enter an Ethereum-style address starting with 0x. .sns and ENS names are not supported here.');
  if (!hasValidChecksum(t)) return no('The capital and small letters of that address do not match its checksum, which usually means a typo or a bad paste. Copy it again.');
  if (t.toLowerCase() === ZERO) return no('That is the zero address. Anything sent there is lost for good.');
  if (t.toLowerCase() === from.toLowerCase()) return no('That is your own address. Enter the address you want to send to.');
  return { address: toChecksumAddress(t), problem: null };
}

/** The transaction a wallet is asked to send: a plain value transfer, or the token's `transfer` call. */
export function buildEvmTransfer(args: { from: string; to: string; token: string | null; amountRaw: bigint }): EvmTxRequest {
  if (args.amountRaw <= 0n) throw new SwingsError('invalid', 'The amount must be more than zero.');
  return args.token === null
    ? { from: args.from, to: args.to, value: hex(args.amountRaw) }
    : { from: args.from, to: args.token, data: encodeTransfer(args.to, args.amountRaw), value: '0x0' };
}

export interface EvmSendRequest {
  chain: ChainId;
  from: string;
  to: string;
  /** The token contract, or null for the network's native coin. */
  token: string | null;
  symbol: string;
  decimals: number;
  amountText: string;
}

export interface EvmSendPlan {
  request: EvmSendRequest;
  amountRaw: bigint;
  tx: EvmTxRequest | null;
  /** The most the network fee is likely to cost, in the native coin's smallest unit (null if it could not be estimated). */
  feeWei: bigint | null;
  recipientIsContract: boolean;
  blockers: string[];
  /** Something the person must tick before it can go on (the recipient is a contract). */
  needsAck: boolean;
}

/** A 20% margin on the estimated gas, so a transfer does not run out by a hair. */
const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;

const asBig = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);

/** Everything that can be checked before the wallet is asked. Network failures become blockers, never a silent pass. */
export async function planEvmSend(req: EvmSendRequest, read: EvmRead): Promise<EvmSendPlan> {
  const blockers: string[] = [];
  const native = CHAINS[req.chain].nativeSymbol;
  const amountText = req.amountText.trim();
  const raw = toSmallestUnit(amountText.startsWith('.') ? `0${amountText}` : amountText.replace(/\.$/, ''), req.decimals);
  const amountRaw = raw === null ? 0n : BigInt(raw);
  if (raw === null) blockers.push(`${amountText} is not a valid ${req.symbol} amount (at most ${req.decimals} decimal places).`);
  else if (amountRaw === 0n) blockers.push('The amount must be more than zero.');
  if (req.token !== null && req.to.toLowerCase() === req.token.toLowerCase()) blockers.push(`That is the ${req.symbol} contract itself. Tokens sent to it cannot be recovered.`);

  let balance: bigint | null = null;
  let nativeBalance: bigint | null = null;
  let recipientIsContract = false;
  try {
    balance = await readBalance(read, req.from, req.token ?? EVM_NATIVE_ADDRESS);
    nativeBalance = req.token === null ? balance : await readBalance(read, req.from, EVM_NATIVE_ADDRESS);
    const code = await read('eth_getCode', [req.to, 'latest']);
    recipientIsContract = typeof code === 'string' && code !== '0x' && code !== '0x0';
  } catch {
    blockers.push(`The ${CHAINS[req.chain].name} network could not be reached to check this transfer. Try again in a moment.`);
  }
  if (balance !== null && amountRaw > balance) blockers.push(`You hold ${fromSmallestUnit(balance, req.decimals)} ${req.symbol}, which is less than ${amountText}.`);

  let tx: EvmTxRequest | null = null;
  let feeWei: bigint | null = null;
  if (blockers.length === 0) {
    tx = buildEvmTransfer({ from: req.from, to: req.to, token: req.token, amountRaw });
    try {
      const gas = asBig(await read('eth_estimateGas', [tx]));
      const price = asBig(await read('eth_gasPrice', []));
      if (gas === null || price === null) throw new Error('no estimate');
      const limit = (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
      feeWei = limit * price;
      // Bound to the network the transfer was planned on, so a wallet that has switched refuses it.
      tx = { ...tx, gas: hex(limit), chainId: hex(BigInt(CHAINS[req.chain].evmChainId ?? 0)) };
    } catch (e) {
      const why = e instanceof SwingsError ? e.message : '';
      blockers.push(`The network would not accept this transfer${why ? `: ${why}` : '. The recipient or the token may refuse it'}. Nothing was sent.`);
      tx = null;
    }
    if (feeWei !== null && nativeBalance !== null) {
      const need = feeWei + (req.token === null ? amountRaw : 0n);
      if (nativeBalance < need) blockers.push(`You need more ${native} to pay the network fee${req.token === null ? ' on top of the amount' : ''}: about ${fromSmallestUnit(feeWei, 18)} ${native}.`);
    }
  }
  return { request: req, amountRaw, tx: blockers.length === 0 ? tx : null, feeWei, recipientIsContract, blockers, needsAck: recipientIsContract && blockers.length === 0 };
}

/** The most of the native coin that can be sent while leaving room for the fee (zero if the balance cannot cover it). */
export function maxNativeSend(balance: bigint, feeWei: bigint): bigint {
  return balance > feeWei ? balance - feeWei : 0n;
}

export type EvmSendResult = 'confirmed' | 'failed' | 'pending';

/** Waits for the receipt. A node that cannot answer is never read as "failed": the transfer is simply not confirmed yet. */
export async function waitForEvmReceipt(read: EvmRead, hash: string, opts: { pollMs?: number; timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<EvmSendResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  while (now() < deadline) {
    try {
      const receipt = (await read('eth_getTransactionReceipt', [hash])) as { status?: string } | null;
      if (receipt) return receipt.status === '0x1' ? 'confirmed' : 'failed';
    } catch {
      // not answered yet
    }
    await sleep(opts.pollMs ?? 2_000);
  }
  return 'pending';
}

/** Switches the wallet to the right network, checks it still shows the reviewed account, then has the wallet send. Returns the hash. */
export async function sendEvmTransfer(plan: EvmSendPlan, adapter: EvmWalletAdapter): Promise<string> {
  if (!plan.tx || plan.blockers.length > 0) throw new SwingsError('invalid', 'This transfer did not pass its checks, so it was not sent.');
  const chainId = CHAINS[plan.request.chain].evmChainId;
  if (chainId === null) throw new SwingsError('invalid', 'That is not an Ethereum-style network.');
  const account = (await adapter.getAccounts())[0];
  if (!account || account.toLowerCase() !== plan.request.from.toLowerCase()) throw new SwingsError('invalid', 'The account selected in your wallet changed. Review the transfer again.');
  if (plan.tx.chainId !== '0x' + chainId.toString(16)) throw new SwingsError('invalid', 'This transfer was not built for that network, so it was not sent.');
  if ((await adapter.getChainId()) !== chainId) await adapter.switchChain(chainId);
  return adapter.sendTransaction(plan.tx);
}
