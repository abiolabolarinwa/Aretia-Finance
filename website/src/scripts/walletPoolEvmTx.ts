/**
 * Aretia Launch, Ethereum-style chains: the two transactions that open a pool, and the independent check of each.
 *
 * `inspectApproveTx` and `inspectAddTx` decode the transaction they are given from its bytes and compare every part with what the person
 * approved. They do not call the builders. The flow runs them on the exact objects it hands to the wallet.
 */
import { keccak256 } from '../swings/core/keccak.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { toHexQuantity } from './walletLaunchEvmTx';
import { POOL_FEE_ADDRESS, type PoolConfig } from './walletPoolEvmCore';

const enc = new TextEncoder();
const selectorOf = (signature: string): string => '0x' + [...keccak256(enc.encode(signature))].slice(0, 4).map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (n: bigint): string => n.toString(16).padStart(64, '0');
const addrWord = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');

export const APPROVE_SELECTOR = selectorOf('approve(address,uint256)');
export const ADD_LIQUIDITY_ETH_SELECTOR = selectorOf('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)');
export const SEL = {
  allowance: selectorOf('allowance(address,address)'),
  routerFactory: selectorOf('factory()'),
  routerWeth: selectorOf('WETH()'),
  getPair: selectorOf('getPair(address,address)'),
  getReserves: selectorOf('getReserves()'),
  token0: selectorOf('token0()'),
  balanceOf: selectorOf('balanceOf(address)'),
} as const;

/** How long a pool transaction stays valid once built: if it is still waiting after this, the network refuses it. */
export const POOL_DEADLINE_SECONDS = 20 * 60;

export const TRANSFER_SELECTOR = selectorOf('transfer(address,uint256)');
export const encodeTransfer = (to: string, amount: bigint): string => TRANSFER_SELECTOR + addrWord(to) + word(amount);

export const encodeApprove = (spender: string, amount: bigint): string => APPROVE_SELECTOR + addrWord(spender) + word(amount);

export function encodeAddLiquidityEth(a: { token: string; tokenRaw: bigint; tokenMin: bigint; coinMin: bigint; to: string; deadline: bigint }): string {
  return ADD_LIQUIDITY_ETH_SELECTOR + addrWord(a.token) + word(a.tokenRaw) + word(a.tokenMin) + word(a.coinMin) + addrWord(a.to) + word(a.deadline);
}

const words = (data: string, selector: string, count: number): string[] | null => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || !data.toLowerCase().startsWith(selector) || data.length !== 10 + count * 64) return null;
  return Array.from({ length: count }, (_, i) => data.slice(10 + i * 64, 10 + (i + 1) * 64).toLowerCase());
};
/** A 32-byte word that is a valid address: 12 zero bytes then 20. */
const asAddr = (w: string): string | null => (/^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null);

export const decodeApprove = (data: string): { spender: string; amount: bigint } | null => {
  const w = words(data, APPROVE_SELECTOR, 2);
  const spender = w ? asAddr(w[0]!) : null;
  return w && spender ? { spender, amount: BigInt('0x' + w[1]) } : null;
};

export interface DecodedAdd {
  token: string;
  tokenRaw: bigint;
  tokenMin: bigint;
  coinMin: bigint;
  to: string;
  deadline: bigint;
}
export const decodeAddLiquidityEth = (data: string): DecodedAdd | null => {
  const w = words(data, ADD_LIQUIDITY_ETH_SELECTOR, 6);
  const token = w ? asAddr(w[0]!) : null;
  const to = w ? asAddr(w[4]!) : null;
  return w && token && to ? { token, tokenRaw: BigInt('0x' + w[1]), tokenMin: BigInt('0x' + w[2]), coinMin: BigInt('0x' + w[3]), to, deadline: BigInt('0x' + w[5]) } : null;
};

export function buildFeeTx(c: PoolConfig): EvmTxRequest {
  return { from: c.creator, to: c.fee.token, data: encodeTransfer(POOL_FEE_ADDRESS, c.fee.raw), value: '0x0' };
}

export function buildApproveTx(c: PoolConfig): EvmTxRequest {
  return { from: c.creator, to: c.token, data: encodeApprove(c.dex.router, c.tokenRaw), value: '0x0' };
}

/** The deadline is `nowSeconds` plus the window. The minimums equal the amounts, so a pool that already exists at another price makes it revert. */
export function buildAddTx(c: PoolConfig, nowSeconds: number): EvmTxRequest {
  return {
    from: c.creator,
    to: c.dex.router,
    data: encodeAddLiquidityEth({ token: c.token, tokenRaw: c.tokenRaw, tokenMin: c.tokenRaw, coinMin: c.coinWei, to: c.lpTo, deadline: BigInt(nowSeconds + POOL_DEADLINE_SECONDS) }),
    value: toHexQuantity(c.coinWei),
  };
}

const ALLOWED = new Set(['from', 'to', 'data', 'value', 'gas']);

function common(tx: EvmTxRequest, c: PoolConfig, walletChainId: number): string[] {
  const p: string[] = [];
  if (walletChainId !== c.dex.chainId) p.push(`The wallet is on network ${walletChainId}, not ${c.dex.chainId}.`);
  for (const k of Object.keys(tx)) if (!ALLOWED.has(k)) p.push(`The transaction has an unexpected field (${k}).`);
  if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== c.creator) p.push('The transaction is not from the account you approved.');
  if (tx.gas !== undefined && !(typeof tx.gas === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.gas) && BigInt(tx.gas) > 0n)) p.push('The gas limit is not a number.');
  return p;
}
const valueOf = (tx: EvmTxRequest): bigint | null => (typeof tx.value === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.value) ? BigInt(tx.value) : null);

export const decodeTransfer = (data: string): { to: string; amount: bigint } | null => {
  const w = words(data, TRANSFER_SELECTOR, 2);
  const to = w ? asAddr(w[0]!) : null;
  return w && to ? { to, amount: BigInt('0x' + w[1]) } : null;
};

/** The fee must be a plain transfer, on the chosen stablecoin's contract, of exactly the flat amount to the Aretia fee address, carrying no coins. */
export function inspectFeeTx(tx: EvmTxRequest, c: PoolConfig, walletChainId: number): string[] {
  const p = common(tx, c, walletChainId);
  if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== c.fee.token) p.push(`The fee is not sent on the ${c.fee.asset} contract you chose.`);
  if (valueOf(tx) !== 0n) p.push('The fee transaction carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeTransfer(tx.data) : null;
  if (!d) p.push('The fee transaction data is not a plain transfer.');
  else {
    if (d.to !== POOL_FEE_ADDRESS) p.push('The fee would go to an address that is not Aretia’s fee address.');
    if (d.amount !== c.fee.raw) p.push(`The fee is not exactly the flat amount of ${c.fee.asset}.`);
  }
  return p;
}

/** The approval must go to the token, name the exchange's router as spender, and be for exactly the tokens going in (never unlimited). */
export function inspectApproveTx(tx: EvmTxRequest, c: PoolConfig, walletChainId: number): string[] {
  const p = common(tx, c, walletChainId);
  if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== c.token) p.push('The approval is not sent to the token you chose.');
  if (valueOf(tx) !== 0n) p.push('The approval carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeApprove(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain approval.');
  else {
    if (d.spender !== c.dex.router) p.push(`The approval names someone other than ${c.dex.name}’s router.`);
    if (d.amount !== c.tokenRaw) p.push('The approval is for a different amount of tokens than you approved.');
  }
  return p;
}

/** The pool transaction must go to the router and carry exactly the approved tokens, coins, receiver and minimums, with a near deadline. */
export function inspectAddTx(tx: EvmTxRequest, c: PoolConfig, walletChainId: number, nowSeconds: number): string[] {
  const p = common(tx, c, walletChainId);
  if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== c.dex.router) p.push(`The transaction is not sent to ${c.dex.name}’s router.`);
  if (valueOf(tx) !== c.coinWei) p.push(`The ${c.dex.symbol} sent is not exactly the amount you approved.`);
  const d = typeof tx.data === 'string' ? decodeAddLiquidityEth(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain pool creation.');
  else {
    if (d.token !== c.token) p.push('The pool is for a different token than you approved.');
    if (d.tokenRaw !== c.tokenRaw) p.push('The number of tokens differs from the one you approved.');
    if (d.tokenMin !== c.tokenRaw || d.coinMin !== c.coinWei) p.push('The minimum amounts are not exactly the amounts, so the pool could be filled at a different price.');
    if (d.to !== c.lpTo) p.push(c.lock ? 'The liquidity would not go to the dead address, so it would not be locked.' : 'The liquidity tokens would go to someone other than you.');
    if (d.deadline <= BigInt(nowSeconds) || d.deadline > BigInt(nowSeconds + 3600)) p.push('The deadline is not within the next hour.');
  }
  return p;
}
