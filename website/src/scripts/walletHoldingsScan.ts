/**
 * Aretia's own way to find the tokens an Ethereum-style wallet holds.
 *
 * A node can only be asked about a token it is told about, and no free service lists everything an address owns. But Aretia's Market
 * Indexer already knows every token that trades on the DEXes it follows. So the wallet is checked against that list on the chain
 * itself: the Multicall3 contract, deployed at the same address on every network, answers "what does this address hold of each of
 * these 300 tokens" in a single read, and the list is walked a chunk at a time, deepest liquidity first. Nothing outside Aretia and
 * the chain is asked, every answer is the chain's, and a token is found however the wallet came to hold it (a swap anywhere, a transfer,
 * an airdrop) as long as Aretia's index knows it. Tokens the index does not know are not found here.
 */
import { publicRead, type EvmRead } from '../swings/chains/evmSession.js';
import type { ChainId } from '../swings/core/types.js';
import type { ExtraToken } from './walletEvmHoldings';

/** Multicall3: the same address on Ethereum, BNB Chain, Polygon and Base. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const AGGREGATE3 = '0x82ad56cb';
const BALANCE_OF = '70a08231';
/** The networks that are checked: those with a Market Indexer list and Multicall3. */
export const SCAN_CHAINS: readonly ChainId[] = ['ethereum', 'bnb', 'polygon', 'base'];
/** Tokens per read: about a million gas, far inside what a node allows for a read, and a response of about 20 KB. */
export const CHUNK = 300;
const LIST_SIZE = 2_500;
const LIST_KEPT_MS = 10 * 60_000;
const PARALLEL = 3;

const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
const pad32 = (hex: string): string => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');

/** One read inside a Multicall3 call: the contract to ask and the call data (hex, no 0x prefix). */
export interface Call {
  target: string;
  data: string;
}

/** The Multicall3 `aggregate3` read for these calls; a call that fails is reported, not fatal. Pure. */
export function encodeAggregate3(calls: readonly Call[]): string {
  const parts = calls.map((c) => {
    const padded = pad32(c.data);
    return { target: c.target, bytes: c.data.length / 2, padded, size: 32 * 3 + 32 + padded.length / 2 };
  });
  // One struct per call: target, allowFailure, offset to the bytes (always 3 words on), the bytes' length, the bytes.
  let at = calls.length * 32;
  const offsets = parts.map((p) => {
    const o = word(at);
    at += p.size;
    return o;
  });
  const structs = parts.map((p) => word(BigInt(p.target)) + word(1) + word(0x60) + word(p.bytes) + p.padded).join('');
  return AGGREGATE3 + word(0x20) + word(calls.length) + offsets.join('') + structs;
}

/** The calls for `balanceOf(holder)` on each token. Pure. */
export function encodeBalanceCalls(holder: string, tokens: readonly string[]): string {
  const data = BALANCE_OF + holder.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return encodeAggregate3(tokens.map((target) => ({ target, data })));
}

export interface RawResult {
  ok: boolean;
  /** What the call returned, as hex without the 0x prefix. */
  data: string;
}

/** Reads the `aggregate3` answer. Null when it is not a well-formed answer. Pure. */
export function decodeAggregate3(hex: unknown): RawResult[] | null {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const body = hex.slice(2);
  const at = (byte: number): bigint | null => (byte >= 0 && byte * 2 + 64 <= body.length ? BigInt('0x' + body.slice(byte * 2, byte * 2 + 64)) : null);
  const start = at(0);
  if (start === null) return null;
  const arr = Number(start);
  const count = at(arr);
  if (count === null || count > 100_000n) return null;
  const out: RawResult[] = [];
  for (let i = 0; i < Number(count); i++) {
    const off = at(arr + 32 + i * 32);
    if (off === null) return null;
    const s = arr + 32 + Number(off);
    const success = at(s);
    const dataOff = at(s + 32);
    if (success === null || dataOff === null) return null;
    const len = at(s + Number(dataOff));
    if (len === null || len > 1_000_000n) return null;
    const from = (s + Number(dataOff) + 32) * 2;
    const data = body.slice(from, from + Number(len) * 2);
    if (data.length !== Number(len) * 2) return null;
    out.push({ ok: success === 1n, data: success === 1n ? data : '' });
  }
  return out;
}

export interface CallResult {
  ok: boolean;
  /** The first 32-byte word of the answer, or 0 when there was none. */
  value: bigint;
}

/** Reads an answer made of single numbers (balances). Null when it is not a well-formed answer. Pure. */
export function decodeResults(hex: unknown): CallResult[] | null {
  return decodeAggregate3(hex)?.map((r) => ({ ok: r.ok, value: r.ok && r.data.length >= 64 ? BigInt('0x' + r.data.slice(0, 64)) : 0n })) ?? null;
}

const lists = new Map<ChainId, { at: number; addresses: string[] }>();

export function resetScanLists(): void {
  lists.clear();
}

/** The tradable tokens of one network, from Aretia's index; kept for ten minutes. Empty when the index cannot be reached. */
async function tokenList(chain: ChainId, fetchImpl: typeof fetch, now: number): Promise<string[]> {
  const hit = lists.get(chain);
  if (hit && now - hit.at < LIST_KEPT_MS) return hit.addresses;
  try {
    const res = await fetchImpl(`/api/v1/tokens/${chain}?limit=${LIST_SIZE}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return hit?.addresses ?? [];
    const body = (await res.json()) as { data?: { addresses?: unknown } };
    const addresses = Array.isArray(body.data?.addresses) ? (body.data!.addresses as unknown[]).filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()) : [];
    if (addresses.length > 0) lists.set(chain, { at: now, addresses });
    return addresses;
  } catch {
    return hit?.addresses ?? [];
  }
}

export interface ScanDeps {
  fetchImpl?: typeof fetch;
  read?: (chain: ChainId) => EvmRead;
  now?: () => number;
  /** How long the whole scan may take; what has been found by then is returned. */
  budgetMs?: number;
}

/** The tokens of Aretia's index that `account` holds on each network, found on-chain. Never throws; a network that cannot be read is skipped. */
export async function scanKnownTokens(account: string, chains: readonly ChainId[], deps: ScanDeps = {}): Promise<ExtraToken[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return [];
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const read = deps.read ?? ((c: ChainId) => publicRead(c));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? 25_000);
  const found: ExtraToken[] = [];
  await Promise.allSettled(
    chains
      .filter((c) => SCAN_CHAINS.includes(c))
      .map(async (chain) => {
        const list = await tokenList(chain, fetchImpl, now());
        const reader = read(chain);
        const chunks: string[][] = [];
        for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < chunks.length && now() < deadline) {
            const tokens = chunks[next++]!;
            try {
              const out = decodeResults(await reader('eth_call', [{ to: MULTICALL3, data: encodeBalanceCalls(account, tokens) }, 'latest']));
              if (!out || out.length !== tokens.length) continue;
              out.forEach((r, i) => {
                if (r.ok && r.value > 0n) found.push({ chain, address: tokens[i]! });
              });
            } catch {
              // This chunk could not be read; the next one is still tried.
            }
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
      }),
  );
  return found;
}
