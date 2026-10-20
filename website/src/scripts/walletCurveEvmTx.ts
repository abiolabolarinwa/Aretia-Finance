/**
 * Aretia Launch on Ethereum-style chains: the transactions that talk to the Aretia curve contract, and a check of each before anyone signs.
 *
 * The inspectors decode the transaction they are given from its bytes and compare every part with what the person approved. They do not
 * call the builders. The flow runs them on the exact objects it hands to the wallet. The contract address and the token factory come from
 * constants (walletCurveEvmCore.ts), never from the page or the chain.
 *
 * The transactions: approve (the token, exactly the tokens, to the curve), create (one call, which may carry the creator's own first buy),
 * buy, sell (preceded by an approve), graduate, abort.
 */
import { keccak256 } from '../swings/core/keccak.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { toHexQuantity } from './walletLaunchEvmTx';
import { APPROVE_SELECTOR, decodeApprove, encodeApprove } from './walletPoolEvmTx';
import type { EvmCurveChain, EvmCurveConfig } from './walletCurveEvmCore';

const enc = new TextEncoder();
const selectorOf = (signature: string): string => '0x' + [...keccak256(enc.encode(signature))].slice(0, 4).map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (n: bigint): string => {
  if (n < 0n || n >= 1n << 256n) throw new Error('A number does not fit in 256 bits.');
  return n.toString(16).padStart(64, '0');
};
const addrWord = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');

export const CURVE_SEL = {
  createCurve: selectorOf('createCurve(address,uint256,uint256,uint256,uint256)'),
  buy: selectorOf('buy(address,uint256)'),
  sell: selectorOf('sell(address,uint256,uint256)'),
  graduate: selectorOf('graduate(address)'),
  abort: selectorOf('abortMigration(address)'),
  curves: selectorOf('curves(address)'),
  totalOwed: selectorOf('totalOwed()'),
  allowance: selectorOf('allowance(address,address)'),
} as const;

// ---------------------------------------------------------------- builders

/** Hex chain id: every transaction names the one network it is for, so a wallet on another network refuses it. */
const chainHex = (id: number): string => '0x' + id.toString(16);

export const buildApproveTx = (from: string, token: string, curve: string, amount: bigint, chainId: number): EvmTxRequest => ({ from, to: token, data: encodeApprove(curve, amount), value: '0x0', chainId: chainHex(chainId) });

export function buildCreateTx(c: EvmCurveConfig, minFirstBuyOut: bigint): EvmTxRequest {
  return {
    from: c.creator,
    to: c.chain.curve,
    data: CURVE_SEL.createCurve + addrWord(c.token) + word(c.factoryNonce) + word(c.totalRaw) + word(c.targetWei) + word(c.firstBuyWei > 0n ? minFirstBuyOut : 0n),
    value: toHexQuantity(c.firstBuyWei),
    chainId: chainHex(c.chain.chainId),
  };
}

export const buildBuyTx = (from: string, chain: EvmCurveChain, token: string, minOut: bigint, wei: bigint): EvmTxRequest => ({
  from,
  to: chain.curve,
  data: CURVE_SEL.buy + addrWord(token) + word(minOut),
  value: toHexQuantity(wei),
  chainId: chainHex(chain.chainId),
});

export const buildSellTx = (from: string, chain: EvmCurveChain, token: string, tokens: bigint, minCoinOut: bigint): EvmTxRequest => ({
  from,
  to: chain.curve,
  data: CURVE_SEL.sell + addrWord(token) + word(tokens) + word(minCoinOut),
  value: '0x0',
  chainId: chainHex(chain.chainId),
});

export const buildGraduateTx = (from: string, chain: EvmCurveChain, token: string): EvmTxRequest => ({ from, to: chain.curve, data: CURVE_SEL.graduate + addrWord(token), value: '0x0', chainId: chainHex(chain.chainId) });
export const buildAbortTx = (from: string, chain: EvmCurveChain, token: string): EvmTxRequest => ({ from, to: chain.curve, data: CURVE_SEL.abort + addrWord(token), value: '0x0', chainId: chainHex(chain.chainId) });

/** The read call for a curve's stored numbers. */
export const curveReadData = (token: string): string => CURVE_SEL.curves + addrWord(token);

// ---------------------------------------------------------------- decoding

const words = (data: string, selector: string, count: number): string[] | null => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || !data.toLowerCase().startsWith(selector) || data.length !== 10 + count * 64) return null;
  return Array.from({ length: count }, (_, i) => data.slice(10 + i * 64, 10 + (i + 1) * 64).toLowerCase());
};
const asAddr = (w: string): string | null => (/^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null);
const big = (w: string): bigint => BigInt('0x' + w);

export const decodeCreate = (data: string): { token: string; nonce: bigint; total: bigint; target: bigint; minFirstBuyOut: bigint } | null => {
  const w = words(data, CURVE_SEL.createCurve, 5);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, nonce: big(w[1]!), total: big(w[2]!), target: big(w[3]!), minFirstBuyOut: big(w[4]!) } : null;
};
export const decodeBuy = (data: string): { token: string; minOut: bigint } | null => {
  const w = words(data, CURVE_SEL.buy, 2);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, minOut: big(w[1]!) } : null;
};
export const decodeSell = (data: string): { token: string; tokens: bigint; minCoinOut: bigint } | null => {
  const w = words(data, CURVE_SEL.sell, 3);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, tokens: big(w[1]!), minCoinOut: big(w[2]!) } : null;
};
export const decodeTokenOnly = (data: string, selector: string): string | null => {
  const w = words(data, selector, 1);
  return w ? asAddr(w[0]!) : null;
};

// ---------------------------------------------------------------- the check before signing

const ALLOWED = new Set(['from', 'to', 'data', 'value', 'gas', 'chainId']);
const valueOf = (tx: EvmTxRequest): bigint | null => (typeof tx.value === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.value) ? BigInt(tx.value) : null);

function common(tx: EvmTxRequest, chain: EvmCurveChain, from: string, walletChainId: number): string[] {
  const p: string[] = [];
  if (walletChainId !== chain.chainId) p.push(`The wallet is on network ${walletChainId}, not ${chain.name} (${chain.chainId}).`);
  if (tx.chainId !== chainHex(chain.chainId)) p.push(`The transaction is not bound to ${chain.name} (chain id ${chain.chainId}).`);
  for (const k of Object.keys(tx)) if (!ALLOWED.has(k)) p.push(`The transaction has an unexpected field (${k}).`);
  if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== from.toLowerCase()) p.push('The transaction is not from the account you approved.');
  if (tx.gas !== undefined && !(typeof tx.gas === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.gas) && BigInt(tx.gas) > 0n)) p.push('The gas limit is not a number.');
  return p;
}
const toIs = (tx: EvmTxRequest, address: string): boolean => typeof tx.to === 'string' && tx.to.toLowerCase() === address.toLowerCase();

export interface ApproveCheck {
  chain: EvmCurveChain;
  from: string;
  token: string;
  amount: bigint;
}

/** The approval must go to the token, name the CURVE as spender (never anyone else), be for exactly the tokens (never unlimited), and carry no coin. */
export function inspectApprove(tx: EvmTxRequest, c: ApproveCheck, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.token)) p.push('The approval is not sent to the token you chose.');
  if (valueOf(tx) !== 0n) p.push('The approval carries coins, which it should not.');
  const d = typeof tx.data === 'string' && tx.data.toLowerCase().startsWith(APPROVE_SELECTOR) ? decodeApprove(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain approval.');
  else {
    if (d.spender !== c.chain.curve) p.push('The approval names someone other than the Aretia curve contract.');
    if (d.amount !== c.amount) p.push('The approval is for a different amount of tokens than you approved.');
  }
  return p;
}

export interface CreateCheck {
  config: EvmCurveConfig;
  minFirstBuyOut: bigint;
}

export function inspectCreate(tx: EvmTxRequest, c: CreateCheck, walletChainId: number): string[] {
  const { config } = c;
  const p = common(tx, config.chain, config.creator, walletChainId);
  if (!toIs(tx, config.chain.curve)) p.push('The transaction is not sent to the Aretia curve contract for this network.');
  if (valueOf(tx) !== config.firstBuyWei) p.push('The coins sent are not exactly your first buy (or nothing, if you chose none).');
  const d = typeof tx.data === 'string' ? decodeCreate(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain curve creation.');
  else {
    if (d.token !== config.token) p.push('The curve is for a different token than you approved.');
    if (d.nonce !== config.factoryNonce) p.push('The proof that the factory made the token is not the one worked out for it.');
    if (d.total !== config.totalRaw) p.push('The number of tokens going into the curve is not the one shown.');
    if (d.target !== config.targetWei) p.push('The raise target is not the one shown.');
    if (d.minFirstBuyOut !== (config.firstBuyWei > 0n ? c.minFirstBuyOut : 0n)) p.push('The least your first buy must give is not the one shown.');
  }
  return p;
}

export interface TradeCheck {
  chain: EvmCurveChain;
  from: string;
  token: string;
}

export function inspectBuy(tx: EvmTxRequest, c: TradeCheck & { wei: bigint; minOut: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.chain.curve)) p.push('The transaction is not sent to the Aretia curve contract for this network.');
  if (valueOf(tx) !== c.wei) p.push('The coins sent are not exactly the amount shown.');
  const d = typeof tx.data === 'string' ? decodeBuy(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain buy.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The buy is for a different token than you chose.');
    if (d.minOut !== c.minOut) p.push('The least you would accept is not the one shown.');
  }
  return p;
}

export function inspectSell(tx: EvmTxRequest, c: TradeCheck & { tokens: bigint; minCoinOut: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.chain.curve)) p.push('The transaction is not sent to the Aretia curve contract for this network.');
  if (valueOf(tx) !== 0n) p.push('A sale carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeSell(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain sale.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The sale is for a different token than you chose.');
    if (d.tokens !== c.tokens) p.push('The number of tokens is not the one shown.');
    if (d.minCoinOut !== c.minCoinOut) p.push('The least you would accept is not the one shown.');
  }
  return p;
}

/** Graduating and unwinding take only the token, and carry no coin. */
export function inspectTokenOnly(tx: EvmTxRequest, c: TradeCheck, selector: string, what: string, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.chain.curve)) p.push('The transaction is not sent to the Aretia curve contract for this network.');
  if (valueOf(tx) !== 0n) p.push(`The ${what} carries coins, which it should not.`);
  const token = typeof tx.data === 'string' ? decodeTokenOnly(tx.data, selector) : null;
  if (token === null) p.push(`The transaction data is not a plain ${what}.`);
  else if (token !== c.token.toLowerCase()) p.push(`The ${what} is for a different token than you chose.`);
  return p;
}
export const inspectGraduate = (tx: EvmTxRequest, c: TradeCheck, walletChainId: number): string[] => inspectTokenOnly(tx, c, CURVE_SEL.graduate, 'graduation', walletChainId);
export const inspectAbort = (tx: EvmTxRequest, c: TradeCheck, walletChainId: number): string[] => inspectTokenOnly(tx, c, CURVE_SEL.abort, 'unwind', walletChainId);
