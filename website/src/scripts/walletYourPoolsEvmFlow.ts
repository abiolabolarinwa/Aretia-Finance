/**
 * "Your pools" for Aretia Pool on Ethereum-style chains: finding a wallet's positions from the contract's event logs, and claiming a
 * position's fees. Every outside dependency is passed in so each path can be tested without a network or a wallet. walletYourPoolsEvm.ts
 * draws it. A claim goes through the same checked flow as the Launch card (walletAretiaPoolEvmFlow.ts), so the transaction is the contract's
 * own `claimFees`, checked byte for byte before it is signed, simulated, sent, and read back.
 */
import { decodeAbiString } from '../swings/chains/evmSession.js';
import type { EvmRead } from '../swings/chains/evmSession.js';
import { EVM_POOL_DEPLOY_BLOCKS, EVM_POOL_ADDRESSES, evmPoolChain, type EvmPoolChain } from './walletAretiaPoolEvmCore';
import { EvmPoolFlow, type EvmPoolFlowDeps, type EvmPoolOutcome, type EvmPoolProgress } from './walletAretiaPoolEvmFlow';
import { ownerLogFilters, rowFrom, sortRows, tokensFromLogs, type EvmPoolRow } from './walletYourPoolsEvmCore';
import type { LaunchEvmChainKey } from './walletLaunchEvmCore';

/** The most tokens listed per network at once. A wallet with more sees the first ones and a note. */
export const MAX_EVM_POSITIONS = 50;
/** The widest block range one log request asks for; halved when a node refuses it. */
export const LOG_RANGE = 40_000;
const MIN_RANGE = 500;

const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567' } as const;
const wordOf = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? BigInt(v) : null);

export interface YourEvmListing {
  rows: EvmPoolRow[];
  truncated: boolean;
  /** Networks with a contract that could not be read, by name, so the page can say so instead of showing a short list as complete. */
  failed: string[];
}

export class YourEvmPools {
  constructor(
    private readonly d: EvmPoolFlowDeps,
    private readonly readerFor: (key: LaunchEvmChainKey) => EvmRead,
    private readonly addresses: typeof EVM_POOL_ADDRESSES = EVM_POOL_ADDRESSES,
    private readonly deployBlocks: typeof EVM_POOL_DEPLOY_BLOCKS = EVM_POOL_DEPLOY_BLOCKS,
    private readonly factories: Readonly<Partial<Record<LaunchEvmChainKey, string>>> = {},
  ) {}

  chainOf(key: string): EvmPoolChain | null {
    const c = evmPoolChain(key, this.addresses, this.factories);
    return c && typeof this.deployBlocks[c.key] === 'number' ? c : null;
  }

  private flowFor(key: LaunchEvmChainKey): EvmPoolFlow {
    return new EvmPoolFlow({ ...this.d, read: this.readerFor(key) });
  }

  /** Token addresses the wallet has or had a position in on one network, from the pool contract's logs. */
  async findTokens(chain: EvmPoolChain, owner: string): Promise<string[]> {
    const read = this.readerFor(chain.key);
    const head = wordOf2(await read('eth_blockNumber', []));
    const start = this.deployBlocks[chain.key];
    if (head === null || typeof start !== 'number') throw new Error('The network did not give its latest block.');
    const tokens = new Set<string>();
    for (const f of ownerLogFilters(owner)) {
      let size = LOG_RANGE;
      let from = start;
      while (from <= head) {
        const to = Math.min(from + size - 1, head);
        try {
          const logs = (await read('eth_getLogs', [{ address: chain.pool, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: f.topics }])) as unknown;
          if (!Array.isArray(logs)) throw new Error('The node did not answer with a list of logs.');
          for (const t of tokensFromLogs(logs)) tokens.add(t);
          from = to + 1;
        } catch (e) {
          // A public node limits how many blocks or logs one request may cover: ask for less, down to a floor.
          if (size <= MIN_RANGE) throw e;
          size = Math.max(MIN_RANGE, Math.floor(size / 2));
        }
      }
    }
    return [...tokens];
  }

  async list(owner: string, keys: readonly string[]): Promise<YourEvmListing> {
    const rows: EvmPoolRow[] = [];
    const failed: string[] = [];
    let truncated = false;
    for (const key of keys) {
      const chain = this.chainOf(key);
      if (!chain) continue;
      try {
        const flow = this.flowFor(chain.key);
        const read = this.readerFor(chain.key);
        const found = await this.findTokens(chain, owner);
        if (found.length > MAX_EVM_POSITIONS) truncated = true;
        for (const token of found.slice(0, MAX_EVM_POSITIONS)) {
          const [pool, position] = await Promise.all([flow.loadPool(chain, token), flow.loadPosition(chain, token, owner)]);
          // A position can have been handed on since the log: only what the contract shows now is listed.
          if (!pool || !position || !position.open) continue;
          const [sym, dec] = await Promise.all([read('eth_call', [{ to: token, data: SEL.symbol }, 'latest']).catch(() => null), read('eth_call', [{ to: token, data: SEL.decimals }, 'latest']).catch(() => null)]);
          const symbol = decodeAbiString(sym) ?? `${token.slice(0, 6)}…${token.slice(-4)}`;
          const decimals = wordOf(dec);
          rows.push(rowFrom(chain, token, { symbol, decimals: decimals === null ? 18 : Number(decimals) }, pool, position));
        }
      } catch {
        failed.push(chain.name);
      }
    }
    return { rows: sortRows(rows), truncated, failed };
  }

  /** Claims a position's fees through the checked flow and reads the row back. */
  async claim(row: EvmPoolRow, owner: string, progress: (p: EvmPoolProgress) => void = () => undefined): Promise<{ outcome: EvmPoolOutcome; after: EvmPoolRow | null }> {
    const flow = this.flowFor(row.chain.key);
    const review = await flow.prepareClaim(row.chain, owner, row.pool, row.position, row.token);
    const outcome = await flow.run(review, progress);
    const [pool, position] = await Promise.all([flow.loadPool(row.chain, row.token), flow.loadPosition(row.chain, row.token, owner)]);
    const after = pool && position ? rowFrom(row.chain, row.token, { symbol: row.symbol, decimals: row.decimals }, pool, position) : null;
    return { outcome, after };
  }
}

function wordOf2(v: unknown): number | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(v)) return null;
  return Number(BigInt(v));
}
