/**
 * Aretia Pool on Ethereum-style chains: the transactions that talk to the Aretia Pool contract, and a check of each before anyone signs.
 *
 * The inspectors decode the transaction they are given from its bytes and compare every part with what the person approved. They do not
 * call the builders. The flow runs them on the exact objects it hands to the wallet. The contract address and the token factory come from
 * constants (walletAretiaPoolEvmCore.ts), never from the page or the chain.
 *
 * The transactions: approve (the token, exactly the tokens, to the pool), create (one call, which may carry the creator's own first buy),
 * buy, sell (preceded by an approve), add liquidity, remove liquidity, claim fees, lock, transfer a position, set the fee recipient.
 * Create, buy, sell, add and remove carry a deadline (unix seconds); the inspector accepts one only within the next hour.
 */
import { keccak256 } from '../swings/core/keccak.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { toHexQuantity } from './walletLaunchEvmTx';
import { APPROVE_SELECTOR, decodeApprove, encodeApprove } from './walletPoolEvmTx';
import type { EvmPoolChain, EvmPoolConfig } from './walletAretiaPoolEvmCore';

const enc = new TextEncoder();
const selectorOf = (signature: string): string => '0x' + [...keccak256(enc.encode(signature))].slice(0, 4).map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (n: bigint): string => {
  if (n < 0n || n >= 1n << 256n) throw new Error('A number does not fit in 256 bits.');
  return n.toString(16).padStart(64, '0');
};
const addrWord = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');

export const POOL_SEL = {
  createPool: selectorOf('createPool((address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,uint256,uint256))'),
  buy: selectorOf('buy(address,uint256,uint256)'),
  sell: selectorOf('sell(address,uint256,uint256,uint256)'),
  addLiquidity: selectorOf('addLiquidity(address,uint256,uint256,uint256)'),
  removeLiquidity: selectorOf('removeLiquidity(address,uint256,uint256,uint256,uint256)'),
  claimFees: selectorOf('claimFees(address)'),
  lockLiquidity: selectorOf('lockLiquidity(address,uint256)'),
  transferPosition: selectorOf('transferPosition(address,address)'),
  setRecipient: selectorOf('setRecipient(address,address)'),
  pools: selectorOf('pools(address)'),
  positions: selectorOf('positions(address,address)'),
  pendingFees: selectorOf('pendingFees(address,address)'),
  totalOwed: selectorOf('totalOwed()'),
  protocolOwed: selectorOf('protocolOwed()'),
  withdrawProtocolFees: selectorOf('withdrawProtocolFees()'),
  creationFee: selectorOf('creationFee()'),
  feeRecipient: selectorOf('feeRecipient()'),
  factory: selectorOf('factory()'),
  allowance: selectorOf('allowance(address,address)'),
} as const;

// ---------------------------------------------------------------- builders

/** Hex chain id: every transaction names the one network it is for, so a wallet on another network refuses it. */
const chainHex = (id: number): string => '0x' + id.toString(16);

export const buildApproveTx = (from: string, token: string, pool: string, amount: bigint, chainId: number): EvmTxRequest => ({ from, to: token, data: encodeApprove(pool, amount), value: '0x0', chainId: chainHex(chainId) });

export function buildCreateTx(c: EvmPoolConfig, minFirstBuyOut: bigint, deadline: bigint): EvmTxRequest {
  const data =
    POOL_SEL.createPool +
    addrWord(c.token) + word(c.factoryNonce) + word(c.x0) + word(c.l0) + word(c.y0) + word(BigInt(c.feeBps)) + word(c.lock ? 1n : 0n) + addrWord(c.creator) + word(c.firstBuyWei) + word(c.firstBuyWei > 0n ? minFirstBuyOut : 0n) + word(deadline);
  return { from: c.creator, to: c.chain.pool, data, value: toHexQuantity(c.chain.creationFee + c.y0 + c.firstBuyWei), chainId: chainHex(c.chain.chainId) };
}

export const buildBuyTx = (from: string, chain: EvmPoolChain, token: string, minOut: bigint, wei: bigint, deadline: bigint): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.buy + addrWord(token) + word(minOut) + word(deadline), value: toHexQuantity(wei), chainId: chainHex(chain.chainId) });
export const buildSellTx = (from: string, chain: EvmPoolChain, token: string, tokens: bigint, minCoinOut: bigint, deadline: bigint): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.sell + addrWord(token) + word(tokens) + word(minCoinOut) + word(deadline), value: '0x0', chainId: chainHex(chain.chainId) });
export const buildAddTx = (from: string, chain: EvmPoolChain, token: string, dl: bigint, maxTokens: bigint, coinWei: bigint, deadline: bigint): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.addLiquidity + addrWord(token) + word(dl) + word(maxTokens) + word(deadline), value: toHexQuantity(coinWei), chainId: chainHex(chain.chainId) });
export const buildRemoveTx = (from: string, chain: EvmPoolChain, token: string, dl: bigint, minTokens: bigint, minCoin: bigint, deadline: bigint): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.removeLiquidity + addrWord(token) + word(dl) + word(minTokens) + word(minCoin) + word(deadline), value: '0x0', chainId: chainHex(chain.chainId) });
/** Anyone may send this: it pays everything owed to Aretia's fee address, and only to it. */
export const buildWithdrawProtocolTx = (from: string, chain: EvmPoolChain): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.withdrawProtocolFees, value: '0x0', chainId: chainHex(chain.chainId) });
export const buildClaimTx = (from: string, chain: EvmPoolChain, token: string): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.claimFees + addrWord(token), value: '0x0', chainId: chainHex(chain.chainId) });
export const buildLockTx = (from: string, chain: EvmPoolChain, token: string, amount: bigint): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.lockLiquidity + addrWord(token) + word(amount), value: '0x0', chainId: chainHex(chain.chainId) });
export const buildTransferTx = (from: string, chain: EvmPoolChain, token: string, to: string): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.transferPosition + addrWord(token) + addrWord(to), value: '0x0', chainId: chainHex(chain.chainId) });
export const buildRecipientTx = (from: string, chain: EvmPoolChain, token: string, recipient: string): EvmTxRequest => ({ from, to: chain.pool, data: POOL_SEL.setRecipient + addrWord(token) + addrWord(recipient), value: '0x0', chainId: chainHex(chain.chainId) });

/** The read calls for a pool's stored numbers and a position. */
export const poolReadData = (token: string): string => POOL_SEL.pools + addrWord(token);
export const positionReadData = (token: string, owner: string): string => POOL_SEL.positions + addrWord(token) + addrWord(owner);

// ---------------------------------------------------------------- decoding

const words = (data: string, selector: string, count: number): string[] | null => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || !data.toLowerCase().startsWith(selector) || data.length !== 10 + count * 64) return null;
  return Array.from({ length: count }, (_, i) => data.slice(10 + i * 64, 10 + (i + 1) * 64).toLowerCase());
};
const asAddr = (w: string): string | null => (/^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null);
const big = (w: string): bigint => BigInt('0x' + w);

export interface DecodedCreate {
  token: string;
  nonce: bigint;
  x0: bigint;
  l0: bigint;
  y0: bigint;
  feeBps: bigint;
  lock: boolean;
  owner: string;
  firstBuyWei: bigint;
  minFirstBuyOut: bigint;
  deadline: bigint;
}

export const decodeCreate = (data: string): DecodedCreate | null => {
  const w = words(data, POOL_SEL.createPool, 11);
  if (!w) return null;
  const token = asAddr(w[0]!);
  const owner = asAddr(w[7]!);
  if (!token || !owner || (w[6] !== word(0n) && w[6] !== word(1n))) return null;
  return { token, nonce: big(w[1]!), x0: big(w[2]!), l0: big(w[3]!), y0: big(w[4]!), feeBps: big(w[5]!), lock: w[6] === word(1n), owner, firstBuyWei: big(w[8]!), minFirstBuyOut: big(w[9]!), deadline: big(w[10]!) };
};
export const decodeBuy = (data: string): { token: string; minOut: bigint; deadline: bigint } | null => {
  const w = words(data, POOL_SEL.buy, 3);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, minOut: big(w[1]!), deadline: big(w[2]!) } : null;
};
export const decodeSell = (data: string): { token: string; tokens: bigint; minCoinOut: bigint; deadline: bigint } | null => {
  const w = words(data, POOL_SEL.sell, 4);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, tokens: big(w[1]!), minCoinOut: big(w[2]!), deadline: big(w[3]!) } : null;
};
export const decodeAdd = (data: string): { token: string; dl: bigint; maxTokens: bigint; deadline: bigint } | null => {
  const w = words(data, POOL_SEL.addLiquidity, 4);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, dl: big(w[1]!), maxTokens: big(w[2]!), deadline: big(w[3]!) } : null;
};
export const decodeRemove = (data: string): { token: string; dl: bigint; minTokens: bigint; minCoin: bigint; deadline: bigint } | null => {
  const w = words(data, POOL_SEL.removeLiquidity, 5);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, dl: big(w[1]!), minTokens: big(w[2]!), minCoin: big(w[3]!), deadline: big(w[4]!) } : null;
};
export const decodeTokenOnly = (data: string, selector: string): string | null => {
  const w = words(data, selector, 1);
  return w ? asAddr(w[0]!) : null;
};
export const decodeTokenAmount = (data: string, selector: string): { token: string; amount: bigint } | null => {
  const w = words(data, selector, 2);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, amount: big(w[1]!) } : null;
};
export const decodeTokenAddress = (data: string, selector: string): { token: string; other: string } | null => {
  const w = words(data, selector, 2);
  const token = w ? asAddr(w[0]!) : null;
  const other = w ? asAddr(w[1]!) : null;
  return token && other ? { token, other } : null;
};

// ---------------------------------------------------------------- the check before signing

const ALLOWED = new Set(['from', 'to', 'data', 'value', 'gas', 'chainId']);
const valueOf = (tx: EvmTxRequest): bigint | null => (typeof tx.value === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.value) ? BigInt(tx.value) : null);

function common(tx: EvmTxRequest, chain: EvmPoolChain, from: string, walletChainId: number): string[] {
  const p: string[] = [];
  if (walletChainId !== chain.chainId) p.push(`The wallet is on network ${walletChainId}, not ${chain.name} (${chain.chainId}).`);
  if (tx.chainId !== chainHex(chain.chainId)) p.push(`The transaction is not bound to ${chain.name} (chain id ${chain.chainId}).`);
  for (const k of Object.keys(tx)) if (!ALLOWED.has(k)) p.push(`The transaction has an unexpected field (${k}).`);
  if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== from.toLowerCase()) p.push('The transaction is not from the account you approved.');
  if (tx.gas !== undefined && !(typeof tx.gas === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.gas) && BigInt(tx.gas) > 0n)) p.push('The gas limit is not a number.');
  return p;
}
/** The deadline must be the one approved, still ahead, and at most an hour away. */
const DEADLINE_MAX_AHEAD = 3600n;
function checkDeadline(p: string[], got: bigint, want: bigint, nowSeconds: number): void {
  if (got !== want) p.push('The deadline is not the one shown.');
  if (got <= BigInt(nowSeconds) || got > BigInt(nowSeconds) + DEADLINE_MAX_AHEAD) p.push('The deadline is not within the next hour.');
}
const toIs = (tx: EvmTxRequest, address: string): boolean => typeof tx.to === 'string' && tx.to.toLowerCase() === address.toLowerCase();
const toPool = (tx: EvmTxRequest, chain: EvmPoolChain, p: string[]): void => {
  if (!toIs(tx, chain.pool)) p.push('The transaction is not sent to the Aretia Pool contract for this network.');
};

export interface ApproveCheck {
  chain: EvmPoolChain;
  from: string;
  token: string;
  amount: bigint;
}

/** The approval must go to the token, name the POOL as spender (never anyone else), be for exactly the tokens (never unlimited), and carry no coin. */
export function inspectApprove(tx: EvmTxRequest, c: ApproveCheck, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.token)) p.push('The approval is not sent to the token you chose.');
  if (valueOf(tx) !== 0n) p.push('The approval carries coins, which it should not.');
  const d = typeof tx.data === 'string' && tx.data.toLowerCase().startsWith(APPROVE_SELECTOR) ? decodeApprove(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain approval.');
  else {
    if (d.spender !== c.chain.pool) p.push('The approval names someone other than the Aretia Pool contract.');
    if (d.amount !== c.amount) p.push('The approval is for a different amount of tokens than you approved.');
  }
  return p;
}

export interface CreateCheck {
  config: EvmPoolConfig;
  minFirstBuyOut: bigint;
  deadline: bigint;
  nowSeconds: number;
}

export function inspectCreate(tx: EvmTxRequest, c: CreateCheck, walletChainId: number): string[] {
  const { config } = c;
  const p = common(tx, config.chain, config.creator, walletChainId);
  toPool(tx, config.chain, p);
  if (valueOf(tx) !== config.chain.creationFee + config.y0 + config.firstBuyWei) p.push('The coins sent are not exactly the creation fee plus your first buy (if you chose one).');
  const d = typeof tx.data === 'string' ? decodeCreate(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain pool creation.');
  else {
    if (d.token !== config.token) p.push('The pool is for a different token than you approved.');
    if (d.nonce !== config.factoryNonce) p.push('The proof that the factory made the token is not the one worked out for it.');
    if (d.x0 !== config.x0) p.push('The number of tokens going into the pool is not the one shown.');
    if (d.l0 !== config.l0) p.push('The starting price is not the one shown.');
    if (d.y0 !== config.y0) p.push('The coin going in beside the tokens is not the one shown.');
    if (d.feeBps !== BigInt(config.feeBps)) p.push('The trading fee is not the one shown.');
    if (d.lock !== config.lock || !d.lock) p.push('The lock setting is not the one shown (the creator’s liquidity is always locked).');
    if (d.owner !== config.creator.toLowerCase()) p.push('The pool position would belong to a wallet other than yours.');
    if (d.firstBuyWei !== config.firstBuyWei) p.push('Your first buy is not the one shown.');
    if (d.minFirstBuyOut !== (config.firstBuyWei > 0n ? c.minFirstBuyOut : 0n)) p.push('The least your first buy must give is not the one shown.');
    checkDeadline(p, d.deadline, c.deadline, c.nowSeconds);
  }
  return p;
}

export interface TradeCheck {
  chain: EvmPoolChain;
  from: string;
  token: string;
}
/** For the calls that carry a deadline: the one approved, and the clock it is checked against. */
export interface DeadlineCheck {
  deadline: bigint;
  nowSeconds: number;
}

export function inspectBuy(tx: EvmTxRequest, c: TradeCheck & DeadlineCheck & { wei: bigint; minOut: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  toPool(tx, c.chain, p);
  if (valueOf(tx) !== c.wei) p.push('The coins sent are not exactly the amount shown.');
  const d = typeof tx.data === 'string' ? decodeBuy(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain buy.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The buy is for a different token than you chose.');
    if (d.minOut !== c.minOut) p.push('The least you would accept is not the one shown.');
    checkDeadline(p, d.deadline, c.deadline, c.nowSeconds);
  }
  return p;
}

export function inspectSell(tx: EvmTxRequest, c: TradeCheck & DeadlineCheck & { tokens: bigint; minCoinOut: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  toPool(tx, c.chain, p);
  if (valueOf(tx) !== 0n) p.push('A sale carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeSell(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain sale.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The sale is for a different token than you chose.');
    if (d.tokens !== c.tokens) p.push('The number of tokens is not the one shown.');
    if (d.minCoinOut !== c.minCoinOut) p.push('The least you would accept is not the one shown.');
    checkDeadline(p, d.deadline, c.deadline, c.nowSeconds);
  }
  return p;
}

export function inspectAdd(tx: EvmTxRequest, c: TradeCheck & DeadlineCheck & { dl: bigint; maxTokens: bigint; coinWei: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  toPool(tx, c.chain, p);
  if (valueOf(tx) !== c.coinWei) p.push('The coins sent are not exactly the amount shown.');
  const d = typeof tx.data === 'string' ? decodeAdd(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain deposit.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The deposit is for a different pool than you chose.');
    if (d.dl !== c.dl) p.push('The amount of liquidity is not the one shown.');
    if (d.maxTokens !== c.maxTokens) p.push('The most tokens you would pay is not the one shown.');
    checkDeadline(p, d.deadline, c.deadline, c.nowSeconds);
  }
  return p;
}

export function inspectRemove(tx: EvmTxRequest, c: TradeCheck & DeadlineCheck & { dl: bigint; minTokens: bigint; minCoin: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  toPool(tx, c.chain, p);
  if (valueOf(tx) !== 0n) p.push('A withdrawal carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeRemove(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain withdrawal.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The withdrawal is for a different pool than you chose.');
    if (d.dl !== c.dl) p.push('The amount of liquidity is not the one shown.');
    if (d.minTokens !== c.minTokens) p.push('The least tokens you would accept is not the one shown.');
    if (d.minCoin !== c.minCoin) p.push('The least coin you would accept is not the one shown.');
    checkDeadline(p, d.deadline, c.deadline, c.nowSeconds);
  }
  return p;
}

/** Claiming takes only the token, and carries no coin. */
export function inspectClaim(tx: EvmTxRequest, c: TradeCheck, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  toPool(tx, c.chain, p);
  if (valueOf(tx) !== 0n) p.push('A claim carries coins, which it should not.');
  const token = typeof tx.data === 'string' ? decodeTokenOnly(tx.data, POOL_SEL.claimFees) : null;
  if (token === null) p.push('The transaction data is not a plain claim.');
  else if (token !== c.token.toLowerCase()) p.push('The claim is for a different pool than you chose.');
  return p;
}

export function inspectLock(tx: EvmTxRequest, c: TradeCheck & { amount: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  toPool(tx, c.chain, p);
  if (valueOf(tx) !== 0n) p.push('A lock carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeTokenAmount(tx.data, POOL_SEL.lockLiquidity) : null;
  if (!d) p.push('The transaction data is not a plain lock.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The lock is for a different pool than you chose.');
    if (d.amount !== c.amount) p.push('The amount to lock is not the one shown.');
  }
  return p;
}

function inspectAddressCall(tx: EvmTxRequest, c: TradeCheck & { other: string }, selector: string, what: string, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  toPool(tx, c.chain, p);
  if (valueOf(tx) !== 0n) p.push(`The ${what} carries coins, which it should not.`);
  const d = typeof tx.data === 'string' ? decodeTokenAddress(tx.data, selector) : null;
  if (!d) p.push(`The transaction data is not a plain ${what}.`);
  else {
    if (d.token !== c.token.toLowerCase()) p.push(`The ${what} is for a different pool than you chose.`);
    if (d.other !== c.other.toLowerCase()) p.push(`The ${what} names a different wallet than the one shown.`);
  }
  return p;
}
export const inspectTransfer = (tx: EvmTxRequest, c: TradeCheck & { to: string }, walletChainId: number): string[] => inspectAddressCall(tx, { ...c, other: c.to }, POOL_SEL.transferPosition, 'transfer', walletChainId);
export const inspectRecipient = (tx: EvmTxRequest, c: TradeCheck & { recipient: string }, walletChainId: number): string[] => inspectAddressCall(tx, { ...c, other: c.recipient }, POOL_SEL.setRecipient, 'change of fee recipient', walletChainId);
