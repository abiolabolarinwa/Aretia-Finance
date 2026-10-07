/**
 * Aretia's own EVM discovery feed: it reads the `PairCreated` events of each venue's factory contract, in
 * confirmed blocks only, and reports the tokens and pools they create. One class serves every EVM chain; a
 * chain differs only by its registry entry and its confirmation depth. It plugs into the existing
 * TokenDiscoveryWorker as a DiscoverySource, so cursors, registry writes and risk enrichment are shared.
 *
 * What "new" means here, exactly: the block timestamp of the first on-chain event that created a pool for the
 * token on this venue. A token that traded elsewhere first is not claimed to be new by anything but that fact.
 *
 * Safety properties:
 *  - only blocks at least `confirmations` deep are read, so ordinary reorgs cannot remove an event after the fact;
 *  - the cursor is the last block fully handled; re-reading a block is harmless (writes are idempotent);
 *  - malformed or unexpected logs are skipped, never trusted;
 *  - a node that refuses a large block range is retried with a smaller one.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { readErc20 } from '../chains/evmSession.js';
import { keccak256 } from '../core/keccak.js';
import { normalizeTokenRef } from '../core/token.js';
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import { selector, wordToAddress, wordToBigInt, words } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';
import type { DiscoveryBatch, DiscoverySource } from '../tokens/discovery.js';
import type { TokenCandidate } from '../tokens/registry.js';
import { HUB_TOKENS } from '../dex/hubs.js';

const hex = (b: Uint8Array): string => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const PAIR_CREATED_TOPIC = hex(keccak256(new TextEncoder().encode('PairCreated(address,address,address,uint256)')));

/** Blocks to wait before trusting an event. Deeper where a chain reorganises more. */
const DOLLAR_SYMBOLS = new Set(['USDC', 'USDT', 'DAI']);

export const CONFIRMATIONS: Readonly<Record<ChainId, number>> = { solana: 0, ethereum: 12, bnb: 15, polygon: 64, base: 10, arbitrum: 20, optimism: 10, avalanche: 6 };

export interface EvmIndexerOptions {
  now?: () => number;
  confirmations?: number;
  /** Blocks read per poll. */
  maxRange?: number;
  /** On the very first poll, how far back to start. */
  lookback?: number;
  /** Cap on tokens reported per poll. */
  maxCandidates?: number;
}

export interface IndexerRun {
  fromBlock: bigint;
  toBlock: bigint;
  head: bigint;
  /** How many blocks behind the chain the indexer still is after this poll. */
  lagBlocks: bigint;
  pairsSeen: number;
  skipped: number;
}

interface Pair {
  token0: string;
  token1: string;
  pair: string;
  block: bigint;
}

/** Decodes one `PairCreated` log. Returns null for anything that does not look exactly like one. */
export function decodePairCreated(log: unknown): Pair | null {
  if (typeof log !== 'object' || log === null) return null;
  const l = log as { topics?: unknown; data?: unknown; blockNumber?: unknown; removed?: unknown };
  if (l.removed === true) return null;
  if (!Array.isArray(l.topics) || l.topics.length !== 3 || l.topics[0] !== PAIR_CREATED_TOPIC) return null;
  if (typeof l.data !== 'string' || typeof l.blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(l.blockNumber)) return null;
  try {
    const t1 = String(l.topics[1]);
    const t2 = String(l.topics[2]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(t1) || !/^0x[0-9a-fA-F]{64}$/.test(t2)) return null;
    const w = words(l.data);
    if (w.length < 2) return null;
    return { token0: wordToAddress(t1.slice(2)), token1: wordToAddress(t2.slice(2)), pair: wordToAddress(w[0]!), block: BigInt(l.blockNumber) };
  } catch {
    return null;
  }
}

export class EvmFactoryDiscoverySource implements DiscoverySource {
  readonly id: string;
  readonly chain: ChainId;
  private readonly o: Required<EvmIndexerOptions>;
  /** Details of the last poll, for monitoring. */
  lastRun: IndexerRun | null = null;

  constructor(
    private readonly entry: DexEntry,
    private readonly read: EvmRead,
    options: EvmIndexerOptions = {},
  ) {
    if (CHAINS[entry.chain].kind !== 'evm' || !entry.factory || entry.mechanism !== 'evm-v2-router') throw new SwingsError('invalid', `${entry.id} cannot be indexed as a V2 factory.`);
    this.id = `aretia:v2-factory:${entry.id}`;
    this.chain = entry.chain;
    this.o = { now: Date.now, confirmations: CONFIRMATIONS[entry.chain], maxRange: 1_000, lookback: 300, maxCandidates: 40, ...options };
  }

  private isHub(address: string): boolean {
    return (HUB_TOKENS[this.chain] ?? []).some((h) => h.address === address) || address === this.entry.wrappedNative;
  }

  private async logs(from: bigint, to: bigint, depth = 0): Promise<unknown[]> {
    try {
      const out = await this.read('eth_getLogs', [{ address: this.entry.factory, topics: [PAIR_CREATED_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      if (!Array.isArray(out)) throw new SwingsError('invalid', 'The node returned malformed logs.');
      return out;
    } catch (e) {
      // Public nodes cap the block range of a log query. Halve the window and try again, a few times.
      if (depth < 4 && to > from) {
        const mid = from + (to - from) / 2n;
        return [...(await this.logs(from, mid, depth + 1)), ...(await this.logs(mid + 1n, to, depth + 1))];
      }
      throw e;
    }
  }

  private async blockTime(block: bigint, cache: Map<bigint, number>): Promise<number | null> {
    const cached = cache.get(block);
    if (cached !== undefined) return cached;
    const b = (await this.read('eth_getBlockByNumber', ['0x' + block.toString(16), false])) as { timestamp?: string } | null;
    if (!b || typeof b.timestamp !== 'string') return null;
    const ms = Number.parseInt(b.timestamp, 16) * 1000;
    if (!Number.isFinite(ms)) return null;
    cache.set(block, ms);
    return ms;
  }

  async poll(cursor: string | null): Promise<DiscoveryBatch> {
    const head = BigInt((await this.read('eth_blockNumber', [])) as string);
    const safe = head - BigInt(this.o.confirmations);
    const parsed = cursor !== null && /^[0-9]+$/.test(cursor) ? BigInt(cursor) : null;
    const from = parsed !== null ? parsed + 1n : safe - BigInt(this.o.lookback);
    if (safe < from) {
      this.lastRun = { fromBlock: from, toBlock: parsed ?? safe, head, lagBlocks: 0n, pairsSeen: 0, skipped: 0 };
      return { candidates: [], nextCursor: null };
    }
    const to = from + BigInt(this.o.maxRange) - 1n < safe ? from + BigInt(this.o.maxRange) - 1n : safe;
    const raw = await this.logs(from, to);
    const pairs: Pair[] = [];
    let skipped = 0;
    for (const log of raw) {
      const p = decodePairCreated(log);
      if (p && p.block >= from && p.block <= to) pairs.push(p);
      else skipped++;
    }
    this.lastRun = { fromBlock: from, toBlock: to, head, lagBlocks: head - to, pairsSeen: pairs.length, skipped };

    const times = new Map<bigint, number>();
    const seen = new Set<string>();
    // Work out which tokens to report (block times first, one read per distinct block), then read their
    // on-chain facts a few at a time: sequential reads make a busy chain's poll far too slow.
    const todo: { pair: Pair; side: string; other: string; firstPoolAt: number }[] = [];
    for (const p of pairs.slice(0, this.o.maxCandidates)) {
      const firstPoolAt = await this.blockTime(p.block, times);
      if (firstPoolAt === null) continue;
      for (const [side, other] of [[p.token0, p.token1], [p.token1, p.token0]] as const) {
        if (this.isHub(side) || seen.has(side) || !normalizeTokenRef(this.chain, side)) continue;
        seen.add(side);
        todo.push({ pair: p, side, other, firstPoolAt });
      }
    }
    const candidates: TokenCandidate[] = [];
    for (let i = 0; i < todo.length; i += 8) {
      const chunk = await Promise.all(
        todo.slice(i, i + 8).map(async ({ pair, side, other, firstPoolAt }): Promise<TokenCandidate> => {
          const ref = normalizeTokenRef(this.chain, side)!;
          // Liquidity at the end of the polled range, read at a confirmed block so it cannot be reorganised away.
          const [reserves, facts] = await Promise.all([this.reserves(pair.pair, to), readErc20(this.read, ref.address)]);
          const stable = (HUB_TOKENS[this.chain] ?? []).find((h) => h.address === other && DOLLAR_SYMBOLS.has(h.symbol));
          const stableReserve = stable && reserves ? (other === pair.token0 ? reserves[0] : reserves[1]) : null;
          return {
            ref,
            symbol: facts?.symbol ?? null,
            name: facts?.name ?? null,
            decimals: facts?.decimals ?? null,
            onchain: facts !== null,
            firstPoolAt,
            // A pool is only reported when it holds liquidity; an empty pair leaves the token as "discovered".
            pool: reserves && reserves[0] > 0n && reserves[1] > 0n ? { venue: this.entry.name, address: pair.pair } : null,
            // USD liquidity is only stated when the other side is a dollar stablecoin: twice that side's reserve.
            liquidityUsd: stable && stableReserve !== null ? (Number(stableReserve) / 10 ** stable.decimals) * 2 : null,
            source: `aretia-indexer:${this.entry.id}`,
          };
        }),
      );
      candidates.push(...chunk);
    }
    return { candidates, nextCursor: to.toString() };
  }

  private async reserves(pair: string, block: bigint): Promise<[bigint, bigint] | null> {
    try {
      const out = (await this.read('eth_call', [{ to: pair, data: '0x' + selector('getReserves()') }, '0x' + block.toString(16)])) as string;
      const w = words(out);
      return [wordToBigInt(w[0]!), wordToBigInt(w[1]!)];
    } catch {
      return null;
    }
  }
}
