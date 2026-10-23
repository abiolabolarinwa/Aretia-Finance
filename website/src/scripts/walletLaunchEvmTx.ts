/**
 * Aretia Launch, Ethereum-style chains: the one transaction that creates a token and opens its locked pool, and the independent check
 * that reads it back. (`encodeCreate` / `decodeCreate` write and read the older token-only factory's call, which other modules still use to
 * make test tokens; the page no longer sends it.)
 *
 * `buildLaunchTx` writes the calldata. `inspectLaunchTx` does NOT call the builder: it decodes whatever transaction it is given from its
 * bytes and compares every part with what the person approved, so a wrong target, a wrong amount, a changed name or a stray extra field
 * is caught even if the builder is wrong. The flow runs the inspector on the exact object it hands to the wallet.
 */
import { keccak256 } from '../swings/core/keccak.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { launchValueOf, type EvmLaunchConfig } from './walletLaunchEvmCore.js';

const enc = new TextEncoder();
const bytesToHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const selectorOf = (signature: string): string => '0x' + bytesToHex(keccak256(enc.encode(signature))).slice(0, 8);
const word = (n: bigint): string => n.toString(16).padStart(64, '0');
const pad32 = (len: number): number => Math.ceil(len / 32) * 32;

export const CREATE_SIGNATURE = 'create(string,string,uint8,uint256)';
export const CREATE_SELECTOR = selectorOf(CREATE_SIGNATURE);
export const FEE_SELECTOR = selectorOf('fee()');
export const FEE_RECIPIENT_SELECTOR = selectorOf('feeRecipient()');
/** keccak256("TokenCreated(address,address,string,string,uint8,uint256)"). */
export const TOKEN_CREATED_TOPIC = '0x' + bytesToHex(keccak256(enc.encode('TokenCreated(address,address,string,string,uint8,uint256)')));

function encodeString(text: string): string {
  const bytes = enc.encode(text);
  return word(BigInt(bytes.length)) + bytesToHex(bytes).padEnd(pad32(bytes.length) * 2, '0');
}

/** ABI calldata for create(name, symbol, decimals, supply). */
export function encodeCreate(args: { name: string; symbol: string; decimals: number; supply: bigint }): string {
  const nameData = encodeString(args.name);
  const symbolData = encodeString(args.symbol);
  const headSize = 4n * 32n;
  const nameOffset = headSize;
  const symbolOffset = headSize + BigInt(nameData.length / 2);
  return CREATE_SELECTOR + word(nameOffset) + word(symbolOffset) + word(BigInt(args.decimals)) + word(args.supply) + nameData + symbolData;
}

export interface DecodedCreate {
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
}

/**
 * Decodes create(...) calldata, or returns null for anything that is not exactly what `encodeCreate` writes: another selector, a
 * different layout, junk after the end, non-zero padding, or text that is not valid UTF-8. Strict on purpose.
 */
export function decodeCreate(data: string): DecodedCreate | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || !data.toLowerCase().startsWith(CREATE_SELECTOR)) return null;
  const body = data.slice(10).toLowerCase();
  if (body.length < 4 * 64) return null;
  const w = (i: number): bigint => BigInt('0x' + body.slice(i * 64, i * 64 + 64));
  const readString = (offset: bigint): string | null => {
    if (offset % 32n !== 0n || offset > BigInt(body.length / 2)) return null;
    const at = Number(offset) * 2;
    if (body.length < at + 64) return null;
    const len = BigInt('0x' + body.slice(at, at + 64));
    if (len > 1024n) return null;
    const n = Number(len);
    const text = body.slice(at + 64, at + 64 + n * 2);
    if (text.length !== n * 2) return null;
    const bytes = Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  const name = readString(w(0));
  const symbol = readString(w(1));
  const decimals = w(2);
  if (name === null || symbol === null || decimals > 255n) return null;
  const decoded: DecodedCreate = { name, symbol, decimals: Number(decimals), supply: w(3) };
  // Re-encode and compare: any layout other than the canonical one (padding bytes, odd offsets, trailing data) fails here.
  return encodeCreate(decoded).toLowerCase() === data.toLowerCase() ? decoded : null;
}

export const toHexQuantity = (n: bigint): string => '0x' + n.toString(16);

export const LAUNCH_SIGNATURE = 'launch(string,string,uint8,uint256,uint256)';
export const LAUNCH_SELECTOR = selectorOf(LAUNCH_SIGNATURE);
export const DEX_FACTORY_SELECTOR = selectorOf('dexFactory()');
export const WRAPPED_SELECTOR = selectorOf('wrapped()');
export const MIN_LIQUIDITY_SELECTOR = selectorOf('minLiquidity()');
export const MIN_POOL_BPS_SELECTOR = selectorOf('MIN_POOL_BPS()');
/** keccak256("TokenLaunched(address,address,address,string,string,uint8,uint256,uint256,uint256)"). */
export const TOKEN_LAUNCHED_TOPIC = '0x' + bytesToHex(keccak256(enc.encode('TokenLaunched(address,address,address,string,string,uint8,uint256,uint256,uint256)')));

export interface LaunchArgs {
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
  poolBps: number;
}

/** ABI calldata for launch(name, symbol, decimals, supply, poolBps). */
export function encodeLaunch(args: LaunchArgs): string {
  const nameData = encodeString(args.name);
  const symbolData = encodeString(args.symbol);
  const headSize = 5n * 32n;
  const nameOffset = headSize;
  const symbolOffset = headSize + BigInt(nameData.length / 2);
  return LAUNCH_SELECTOR + word(nameOffset) + word(symbolOffset) + word(BigInt(args.decimals)) + word(args.supply) + word(BigInt(args.poolBps)) + nameData + symbolData;
}

/**
 * Decodes launch(...) calldata, or returns null for anything that is not exactly what `encodeLaunch` writes: another selector, a different
 * layout, junk after the end, non-zero padding, or text that is not valid UTF-8. Strict on purpose.
 */
export function decodeLaunch(data: string): LaunchArgs | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || !data.toLowerCase().startsWith(LAUNCH_SELECTOR)) return null;
  const body = data.slice(10).toLowerCase();
  if (body.length < 5 * 64) return null;
  const w = (i: number): bigint => BigInt('0x' + body.slice(i * 64, i * 64 + 64));
  const readString = (offset: bigint): string | null => {
    if (offset % 32n !== 0n || offset > BigInt(body.length / 2)) return null;
    const at = Number(offset) * 2;
    if (body.length < at + 64) return null;
    const len = BigInt('0x' + body.slice(at, at + 64));
    if (len > 1024n) return null;
    const n = Number(len);
    const text = body.slice(at + 64, at + 64 + n * 2);
    if (text.length !== n * 2) return null;
    const bytes = Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  const name = readString(w(0));
  const symbol = readString(w(1));
  const decimals = w(2);
  const poolBps = w(4);
  if (name === null || symbol === null || decimals > 255n || poolBps > 65_535n) return null;
  const decoded: LaunchArgs = { name, symbol, decimals: Number(decimals), supply: w(3), poolBps: Number(poolBps) };
  // Re-encode and compare: any layout other than the canonical one (padding bytes, odd offsets, trailing data) fails here.
  return encodeLaunch(decoded).toLowerCase() === data.toLowerCase() ? decoded : null;
}

/** The transaction the wallet is asked to send. `gas` is added by the flow after estimating. */
export function buildLaunchTx(config: EvmLaunchConfig): EvmTxRequest {
  const factory = config.chain.launch?.factory;
  if (!factory) throw new Error('This network has no launch factory yet.');
  return {
    from: config.creator,
    to: factory,
    data: encodeLaunch({ name: config.name, symbol: config.symbol, decimals: config.decimals, supply: config.totalSupplyRaw, poolBps: config.poolBps }),
    value: toHexQuantity(launchValueOf(config)),
    // Bound to the network: a wallet on another one refuses it rather than sending the fee and the pool coin there.
    chainId: toHexQuantity(BigInt(config.chain.chainId)),
  };
}

const ALLOWED_FIELDS = new Set(['from', 'to', 'data', 'value', 'gas', 'chainId']);

/**
 * Everything wrong with `tx` as the launch of `config`, in plain words. Empty means it is exactly the approved launch.
 * `walletChainId` is the network the wallet reports it is on right now.
 */
export function inspectLaunchTx(tx: EvmTxRequest, config: EvmLaunchConfig, walletChainId: number): string[] {
  const problems: string[] = [];
  const { chain } = config;
  const factory = chain.launch?.factory ?? null;
  if (walletChainId !== chain.chainId) problems.push(`The wallet is on network ${walletChainId}, not ${chain.name} (${chain.chainId}).`);
  for (const k of Object.keys(tx)) if (!ALLOWED_FIELDS.has(k)) problems.push(`The transaction has an unexpected field (${k}).`);
  if (tx.chainId !== toHexQuantity(BigInt(chain.chainId))) problems.push(`The transaction is not bound to ${chain.name} (chain id ${chain.chainId}).`);
  if (!factory || !chain.feeAddress) problems.push('This network has no launch factory set up yet.');
  if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== config.creator) problems.push('The transaction is not from the account you approved.');
  if (!factory || typeof tx.to !== 'string' || tx.to.toLowerCase() !== factory) problems.push('The transaction is not sent to Aretia’s launch factory for this network.');
  if (typeof tx.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.value) || BigInt(tx.value) !== launchValueOf(config))
    problems.push(`The ${chain.symbol} sent with the transaction is not exactly the fee plus the coin for the pool.`);
  if (tx.gas !== undefined && !(typeof tx.gas === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.gas) && BigInt(tx.gas) > 0n)) problems.push('The gas limit is not a number.');
  const decoded = typeof tx.data === 'string' ? decodeLaunch(tx.data) : null;
  if (!decoded) problems.push('The transaction data is not a plain token launch.');
  else {
    if (decoded.name !== config.name) problems.push('The token name in the transaction differs from the one you approved.');
    if (decoded.symbol !== config.symbol) problems.push('The token symbol in the transaction differs from the one you approved.');
    if (decoded.decimals !== config.decimals) problems.push('The decimals in the transaction differ from the ones you approved.');
    if (decoded.supply !== config.totalSupplyRaw) problems.push('The supply in the transaction differs from the one you approved.');
    if (decoded.poolBps !== config.poolBps) problems.push('The share of the supply going into the pool differs from the one you approved.');
  }
  return problems;
}

export interface LaunchedEvent {
  token: string;
  creator: string;
  pair: string;
}

/** The token and pool from the receipt, taking only a TokenLaunched log emitted by the approved factory for the approved creator. Null if none. */
export function findLaunchedToken(logs: unknown, factory: string, creator: string): LaunchedEvent | null {
  if (!Array.isArray(logs)) return null;
  const found: LaunchedEvent[] = [];
  for (const raw of logs) {
    const log = raw as { address?: unknown; topics?: unknown };
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== factory.toLowerCase()) continue;
    const topics = log.topics;
    if (!Array.isArray(topics) || topics.length !== 4 || String(topics[0]).toLowerCase() !== TOKEN_LAUNCHED_TOPIC) continue;
    const token = '0x' + String(topics[1]).slice(-40).toLowerCase();
    const by = '0x' + String(topics[2]).slice(-40).toLowerCase();
    const pair = '0x' + String(topics[3]).slice(-40).toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(token) && /^0x[0-9a-f]{40}$/.test(pair) && by === creator.toLowerCase()) found.push({ token, creator: by, pair });
  }
  // Exactly one: a receipt with several would be a transaction that did something other than what was approved.
  return found.length === 1 ? found[0]! : null;
}

