/**
 * Aretia's own Solana discovery feed: it finds the transactions that create pools on the venues Aretia routes
 * through, decodes the pool-creation instruction itself, and reports the tokens in them. It plugs into the shared
 * TokenDiscoveryWorker, so cursors, registry writes and risk enrichment are the same as for every other chain.
 *
 * How it finds creations without reading every swap: each venue has an account that only pool creation touches.
 *  - Raydium CPMM: the pool-creation fee receiver (every new pool pays it);
 *  - Orca Whirlpools: the fee-tier account of each tick spacing (a pool names its fee tier when it is created).
 * The signatures of those accounts are listed, their transactions fetched at `finalized` commitment, and the
 * instruction data and account list are decoded exactly as each program defines them.
 *
 * Not covered, stated plainly: Meteora DAMM v2 pools. That program has no account only creation touches (many
 * pools are created without a config), so finding them needs a streaming provider (webhook or Geyser). Until one
 * is added, DAMM v2 pools are known to Aretia only where they are listed in the registry.
 *
 * Safety properties:
 *  - only finalized transactions are read, so a fork cannot remove a pool after it was reported;
 *  - failed transactions are ignored: a failed creation made no pool;
 *  - the instruction must belong to the expected program and match its discriminator and layout, or it is skipped;
 *  - the cursor holds the newest signature seen per account; re-reading is harmless (registry writes are idempotent);
 *  - when more creations arrived than one poll can read, the poll says so (`truncated`) instead of hiding it.
 */
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import { ORCA_CONFIG, ORCA_TICK_SPACINGS, ORCA_WHIRLPOOL_PROGRAM } from '../solana/orcaWhirlpool.js';
import { RAYDIUM_CPMM_PROGRAM, tokenAccountAmount, type SolRpc } from '../solana/raydiumCpmm.js';
import type { DiscoveryBatch, DiscoverySource } from '../tokens/discovery.js';
import type { TokenCandidate } from '../tokens/registry.js';
import type * as Web3 from '@solana/web3.js';

/** Raydium CPMM's pool-creation fee receiver: every `initialize` pays it, nothing else touches it. */
export const CPMM_CREATE_FEE_RECEIVER = 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8';

/** Anchor discriminators: the first eight bytes of sha256("global:<name>"). */
const DISC = {
  cpmmInitialize: 'afaf6d1f0d989bed',
  orcaInitializePool: '5fb40aac54aee828',
  orcaInitializePoolV2: 'cf2d57f21b3fcc43',
} as const;

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const HUBS = new Set([WSOL, USDC, USDT]);
const DOLLAR_DECIMALS: Record<string, number> = { [USDC]: 6, [USDT]: 6 };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 to bytes. Throws on a character outside the alphabet. */
export function decodeBase58(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new SwingsError('invalid', 'Not base58.');
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export interface CreatedPool {
  venue: 'Raydium CPMM' | 'Orca Whirlpool';
  pool: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  /** Unix seconds of the block that created it. */
  blockTime: number;
  signature: string;
}

interface RawIx {
  programId?: string;
  accounts?: string[];
  data?: string;
}

/**
 * Decodes one instruction as a pool creation. Null for anything that is not exactly one: another program, another
 * instruction, the wrong data length or too few accounts.
 */
export function decodePoolCreation(ix: RawIx, blockTime: number, signature: string): CreatedPool | null {
  if (typeof ix.programId !== 'string' || !Array.isArray(ix.accounts) || typeof ix.data !== 'string') return null;
  let data: Uint8Array;
  try {
    data = decodeBase58(ix.data);
  } catch {
    return null;
  }
  if (data.length < 8) return null;
  const disc = hex(data.subarray(0, 8));
  const a = ix.accounts;
  if (ix.programId === RAYDIUM_CPMM_PROGRAM && disc === DISC.cpmmInitialize && data.length === 32 && a.length >= 14) {
    // initialize: creator, config, authority, pool, mint0, mint1, lp mint, creator ata 0/1/lp, vault0, vault1, fee receiver, ...
    return { venue: 'Raydium CPMM', pool: a[3]!, mintA: a[4]!, mintB: a[5]!, vaultA: a[10]!, vaultB: a[11]!, blockTime, signature };
  }
  if (ix.programId === ORCA_WHIRLPOOL_PROGRAM && disc === DISC.orcaInitializePoolV2 && data.length === 26 && a.length >= 10 && a[0] === ORCA_CONFIG) {
    // initialize_pool_v2: config, mintA, mintB, badge A, badge B, funder, whirlpool, vault A, vault B, fee tier, ...
    return { venue: 'Orca Whirlpool', pool: a[6]!, mintA: a[1]!, mintB: a[2]!, vaultA: a[7]!, vaultB: a[8]!, blockTime, signature };
  }
  if (ix.programId === ORCA_WHIRLPOOL_PROGRAM && disc === DISC.orcaInitializePool && data.length === 27 && a.length >= 8 && a[0] === ORCA_CONFIG) {
    // initialize_pool: config, mintA, mintB, funder, whirlpool, vault A, vault B, fee tier, ...
    return { venue: 'Orca Whirlpool', pool: a[4]!, mintA: a[1]!, mintB: a[2]!, vaultA: a[5]!, vaultB: a[6]!, blockTime, signature };
  }
  return null;
}

interface TxJson {
  blockTime?: number | null;
  meta?: { err?: unknown; innerInstructions?: { instructions?: RawIx[] }[] } | null;
  transaction?: { message?: { instructions?: RawIx[] } };
}

/** Every pool-creation instruction in a transaction, top-level or called from another program. Empty if it failed. */
export function poolsCreatedIn(tx: TxJson | null, signature: string): CreatedPool[] {
  if (!tx || (tx.meta?.err !== null && tx.meta?.err !== undefined)) return [];
  if (typeof tx.blockTime !== 'number') return [];
  const all: RawIx[] = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])];
  const seen = new Set<string>();
  const out: CreatedPool[] = [];
  for (const ix of all) {
    const p = decodePoolCreation(ix, tx.blockTime, signature);
    if (p && !seen.has(p.pool)) {
      seen.add(p.pool);
      out.push(p);
    }
  }
  return out;
}

export interface SolanaIndexerOptions {
  now?: () => number;
  /** Signatures read per account per poll. */
  perAccount?: number;
  /** Transactions fetched per poll. */
  maxTransactions?: number;
  /** On the first poll, ignore creations older than this many seconds. */
  lookbackSeconds?: number;
  /** Cap on tokens reported per poll. */
  maxCandidates?: number;
}

export interface SolanaIndexerRun {
  accountsRead: number;
  signaturesNew: number;
  transactionsRead: number;
  poolsFound: number;
  /** More signatures arrived than one poll could read: the oldest were skipped, and this says so. */
  truncated: boolean;
}

interface RpcAccount {
  data: [string, string];
}

export class SolanaPoolDiscoverySource implements DiscoverySource {
  readonly id = 'aretia:solana-pools';
  readonly chain = 'solana' as const;
  lastRun: SolanaIndexerRun | null = null;
  private readonly o: Required<SolanaIndexerOptions>;
  private anchors: { address: string; label: string }[] | null = null;

  constructor(
    private readonly web3: () => Promise<typeof Web3>,
    private readonly rpc: SolRpc,
    options: SolanaIndexerOptions = {},
  ) {
    this.o = { now: Date.now, perAccount: 40, maxTransactions: 30, lookbackSeconds: 3_600, maxCandidates: 40, ...options };
  }

  /** The accounts only pool creation touches. The Orca fee tiers are derived from the program's own seeds. */
  private async accounts(): Promise<{ address: string; label: string }[]> {
    if (this.anchors) return this.anchors;
    const web3 = await this.web3();
    const program = new web3.PublicKey(ORCA_WHIRLPOOL_PROGRAM);
    const config = new web3.PublicKey(ORCA_CONFIG);
    const out = [{ address: CPMM_CREATE_FEE_RECEIVER, label: 'raydium-cpmm' }];
    for (const spacing of ORCA_TICK_SPACINGS) {
      const le = new Uint8Array(2);
      new DataView(le.buffer).setUint16(0, spacing, true);
      out.push({ address: web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('fee_tier'), config.toBytes(), le], program)[0].toBase58(), label: `orca-${spacing}` });
    }
    this.anchors = out;
    return out;
  }

  private parseCursor(cursor: string | null): Record<string, string> {
    if (!cursor) return {};
    try {
      const v = JSON.parse(cursor) as unknown;
      if (typeof v !== 'object' || v === null) return {};
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, s]) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(s as string))) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async poll(cursor: string | null): Promise<DiscoveryBatch> {
    const anchors = await this.accounts();
    const known = this.parseCursor(cursor);
    const floor = Math.floor(this.o.now() / 1000) - this.o.lookbackSeconds;
    const next: Record<string, string> = { ...known };
    let truncated = false;
    const fresh = new Map<string, number>();
    const lists = await Promise.all(
      anchors.map(async (a) => {
        const params: { limit: number; commitment: string; until?: string } = { limit: this.o.perAccount, commitment: 'finalized' };
        if (known[a.address]) params.until = known[a.address]!;
        return { a, sigs: await this.rpc<{ signature: string; blockTime?: number | null; err: unknown }[]>('getSignaturesForAddress', [a.address, params]) };
      }),
    );
    for (const { a, sigs } of lists) {
      if (sigs.length === 0) continue;
      next[a.address] = sigs[0]!.signature; // newest first
      if (sigs.length >= this.o.perAccount && known[a.address]) truncated = true;
      for (const s of sigs) {
        if (s.err !== null && s.err !== undefined) continue;
        if (!known[a.address] && typeof s.blockTime === 'number' && s.blockTime < floor) continue;
        fresh.set(s.signature, s.blockTime ?? 0);
      }
    }
    // Newest first, capped; anything past the cap is reported as truncated rather than silently dropped.
    const order = [...fresh].sort((x, y) => y[1] - x[1]).map(([sig]) => sig);
    if (order.length > this.o.maxTransactions) truncated = true;
    const chosen = order.slice(0, this.o.maxTransactions);

    const created: CreatedPool[] = [];
    for (let i = 0; i < chosen.length; i += 6) {
      const txs = await Promise.all(
        chosen.slice(i, i + 6).map(async (sig) => {
          try {
            return { sig, tx: await this.rpc<TxJson | null>('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]) };
          } catch {
            return { sig, tx: null };
          }
        }),
      );
      for (const { sig, tx } of txs) created.push(...poolsCreatedIn(tx, sig));
    }
    this.lastRun = { accountsRead: anchors.length, signaturesNew: fresh.size, transactionsRead: chosen.length, poolsFound: created.length, truncated };
    const candidates = await this.candidates(created.slice(0, this.o.maxCandidates));
    return { candidates, nextCursor: JSON.stringify(next) };
  }

  private async candidates(pools: CreatedPool[]): Promise<TokenCandidate[]> {
    if (pools.length === 0) return [];
    // Mints (for decimals) and vaults (for liquidity), in one read.
    const mints = [...new Set(pools.flatMap((p) => [p.mintA, p.mintB]).filter((m) => !HUBS.has(m)))];
    const vaults = pools.flatMap((p) => [p.vaultA, p.vaultB]);
    const addresses = [...mints, ...vaults];
    const got = new Map<string, Uint8Array | null>();
    for (let i = 0; i < addresses.length; i += 90) {
      const slice = addresses.slice(i, i + 90);
      let value: (RpcAccount | null)[] = [];
      try {
        value = (await this.rpc<{ value: (RpcAccount | null)[] }>('getMultipleAccounts', [slice, { encoding: 'base64', commitment: 'finalized' }])).value;
      } catch {
        value = [];
      }
      slice.forEach((addr, k) => {
        const acct = value[k];
        got.set(addr, acct ? Uint8Array.from(atob(acct.data[0]), (c) => c.charCodeAt(0)) : null);
      });
    }
    const decimalsOf = (mint: string): number | null => {
      const d = got.get(mint);
      return d && d.length >= 82 ? d[44]! : null;
    };
    const amountOf = (vault: string): bigint | null => {
      const d = got.get(vault);
      return d ? tokenAccountAmount(d) : null;
    };
    const out: TokenCandidate[] = [];
    const seen = new Set<string>();
    for (const p of pools) {
      const aAmount = amountOf(p.vaultA);
      const bAmount = amountOf(p.vaultB);
      const funded = aAmount !== null && bAmount !== null && aAmount > 0n && bAmount > 0n;
      for (const [mint, other, otherAmount] of [[p.mintA, p.mintB, bAmount], [p.mintB, p.mintA, aAmount]] as const) {
        if (HUBS.has(mint) || seen.has(mint)) continue;
        const ref: TokenRef | null = normalizeTokenRef('solana', mint);
        if (!ref) continue;
        seen.add(mint);
        const decimals = decimalsOf(mint);
        const dollars = DOLLAR_DECIMALS[other];
        out.push({
          ref,
          decimals,
          onchain: decimals !== null,
          firstPoolAt: p.blockTime * 1000,
          // A pool is only reported when it holds liquidity; an empty one leaves the token as "discovered".
          pool: funded ? { venue: p.venue, address: p.pool } : null,
          // USD liquidity only when the other side is a dollar stablecoin: twice that side's balance.
          liquidityUsd: funded && dollars !== undefined && otherAmount !== null ? (Number(otherAmount) / 10 ** dollars) * 2 : null,
          source: `aretia-indexer:${p.venue === 'Raydium CPMM' ? 'raydium-cpmm' : 'orca-whirlpool'}`,
        });
      }
    }
    return out;
  }
}
