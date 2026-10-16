/**
 * Aretia Launch, Ethereum-style chains: the one transaction that creates a token, and the independent check that reads it back.
 *
 * `buildCreateTx` writes the calldata. `inspectCreateTx` does NOT call the builder: it decodes whatever transaction it is given from its
 * bytes and compares every part with what the person approved, so a wrong target, a wrong amount, a changed name or a stray extra field
 * is caught even if the builder is wrong. The flow runs the inspector on the exact object it hands to the wallet.
 */
import { keccak256 } from '../swings/core/keccak.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import type { EvmLaunchConfig } from './walletLaunchEvmCore';

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

/** The transaction the wallet is asked to send. `gas` is added by the flow after estimating. */
export function buildCreateTx(config: EvmLaunchConfig): EvmTxRequest {
  const factory = config.chain.factory;
  if (!factory) throw new Error('This network has no factory yet.');
  return {
    from: config.creator,
    to: factory,
    data: encodeCreate({ name: config.name, symbol: config.symbol, decimals: config.decimals, supply: config.totalSupplyRaw }),
    value: toHexQuantity(config.chain.feeWei),
  };
}

const ALLOWED_FIELDS = new Set(['from', 'to', 'data', 'value', 'gas']);

/**
 * Everything wrong with `tx` as the creation of `config`, in plain words. Empty means it is exactly the approved creation.
 * `walletChainId` is the network the wallet reports it is on right now.
 */
export function inspectCreateTx(tx: EvmTxRequest, config: EvmLaunchConfig, walletChainId: number): string[] {
  const problems: string[] = [];
  const { chain } = config;
  if (walletChainId !== chain.chainId) problems.push(`The wallet is on network ${walletChainId}, not ${chain.name} (${chain.chainId}).`);
  for (const k of Object.keys(tx)) if (!ALLOWED_FIELDS.has(k)) problems.push(`The transaction has an unexpected field (${k}).`);
  if (!chain.factory || !chain.feeAddress) problems.push('This network has no factory set up yet.');
  if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== config.creator) problems.push('The transaction is not from the account you approved.');
  if (!chain.factory || typeof tx.to !== 'string' || tx.to.toLowerCase() !== chain.factory) problems.push('The transaction is not sent to Aretia’s token factory for this network.');
  if (typeof tx.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.value) || BigInt(tx.value) !== chain.feeWei)
    problems.push(`The amount sent with the transaction is not exactly the ${chain.symbol} creation fee.`);
  if (tx.gas !== undefined && !(typeof tx.gas === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.gas) && BigInt(tx.gas) > 0n)) problems.push('The gas limit is not a number.');
  const decoded = typeof tx.data === 'string' ? decodeCreate(tx.data) : null;
  if (!decoded) problems.push('The transaction data is not a plain token creation.');
  else {
    if (decoded.name !== config.name) problems.push('The token name in the transaction differs from the one you approved.');
    if (decoded.symbol !== config.symbol) problems.push('The token symbol in the transaction differs from the one you approved.');
    if (decoded.decimals !== config.decimals) problems.push('The decimals in the transaction differ from the ones you approved.');
    if (decoded.supply !== config.totalSupplyRaw) problems.push('The supply in the transaction differs from the one you approved.');
  }
  return problems;
}

export interface CreatedEvent {
  token: string;
  creator: string;
}

/** The token address from the receipt, taking only a TokenCreated log emitted by the approved factory for the approved creator. Null if none. */
export function findCreatedToken(logs: unknown, factory: string, creator: string): CreatedEvent | null {
  if (!Array.isArray(logs)) return null;
  const found: CreatedEvent[] = [];
  for (const raw of logs) {
    const log = raw as { address?: unknown; topics?: unknown };
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== factory.toLowerCase()) continue;
    const topics = log.topics;
    if (!Array.isArray(topics) || topics.length !== 3 || String(topics[0]).toLowerCase() !== TOKEN_CREATED_TOPIC) continue;
    const token = '0x' + String(topics[1]).slice(-40).toLowerCase();
    const by = '0x' + String(topics[2]).slice(-40).toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(token) && by === creator.toLowerCase()) found.push({ token, creator: by });
  }
  // Exactly one: a receipt with several would be a transaction that did something other than what was approved.
  return found.length === 1 ? found[0]! : null;
}
