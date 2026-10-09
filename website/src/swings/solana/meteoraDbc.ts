/**
 * Direct integration with Meteora's Dynamic Bonding Curve (DBC), the launchpad engine behind Bags and many other
 * Solana launchers: where a token trades from its launch until its curve fills and it migrates to a normal pool.
 * Before this, such a token had no pool Aretia could read.
 *
 * A DBC pool cannot be derived from the token pair alone, because its address also depends on the launcher's config.
 * So the candidate pool addresses of a token are asked of DexScreener, and every one is then checked on-chain before
 * it is used: it must be owned by the DBC program, parse as a pool of that very token, and name a config whose quote
 * token is the other side of the swap. A wrong or hostile answer from the index therefore cannot send a swap anywhere:
 * at worst it is ignored. The swap itself is `swap2` in exact-in mode, priced by simulating it on the program from the
 * user's account, which also enforces the minimum output.
 *
 * Scope, stated plainly: curves still trading (not migrated) whose tokens carry no transfer hook.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { type SolRpc } from './raydiumCpmm.js';

export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
/** The program's fixed pool authority, from its published IDL. */
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const DISC_SWAP2 = Uint8Array.from([65, 75, 63, 76, 235, 91, 91, 136]);
const DISC_VIRTUAL_POOL = Uint8Array.from([213, 224, 5, 209, 98, 69, 119, 92]);
const MAX_CANDIDATES = 8;

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface DbcPool {
  config: string;
  baseMint: string;
  baseVault: string;
  quoteVault: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  migrated: boolean;
  migrationProgress: number;
}

/** Reads a virtual-pool account. Null when it is too short or is not one. */
export function parseDbcPool(web3: typeof Web3, data: Uint8Array): DbcPool | null {
  if (data.length < 312 || !DISC_VIRTUAL_POOL.every((b, i) => data[i] === b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { config: pk(72), baseMint: pk(136), baseVault: pk(168), quoteVault: pk(200), baseReserve: view.getBigUint64(232, true), quoteReserve: view.getBigUint64(240, true), migrated: data[305] !== 0, migrationProgress: data[308]! };
}

/** The quote token a config prices its curves in. Null when the account is too short. */
export function parseDbcConfigQuote(web3: typeof Web3, data: Uint8Array): string | null {
  return data.length >= 40 ? new web3.PublicKey(data.subarray(8, 40)).toBase58() : null;
}

/** Candidate pool addresses for a token, from DexScreener. Unverified: every one is checked on-chain before use. */
export type PoolHints = (mint: string) => Promise<string[]>;

export function dexScreenerPoolHints(fetchImpl: typeof fetch = (...a) => fetch(...a)): PoolHints {
  return async (mint) => {
    try {
      const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      const out: string[] = [];
      for (const p of body) {
        const a = (p as { pairAddress?: unknown }).pairAddress;
        if (typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !out.includes(a)) out.push(a);
        if (out.length >= MAX_CANDIDATES) break;
      }
      return out;
    } catch {
      return [];
    }
  };
}

export class DbcAdapter {
  private readonly hintCache = new Map<string, { at: number; pools: string[] }>();

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
    private readonly hints: PoolHints = dexScreenerPoolHints(),
  ) {}

  eventAuthority = (): string => this.web3.PublicKey.findProgramAddressSync([enc('__event_authority')], new this.web3.PublicKey(DBC_PROGRAM))[0].toBase58();

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  private async candidates(mint: string): Promise<string[]> {
    const hit = this.hintCache.get(mint);
    if (hit && this.now() - hit.at < 60_000) return hit.pools;
    const pools = await this.hints(mint);
    this.hintCache.set(mint, { at: this.now(), pools });
    return pools;
  }

  /** Open DBC curves of a token against the other side of the pair, in either order. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const out: LiquidityPool[] = [];
    for (const [base, quote] of [[ta.address, tb.address], [tb.address, ta.address]] as const) {
      const hints = await this.candidates(base);
      if (hints.length === 0) continue;
      const raw = await this.accounts(hints);
      const pools = raw
        .map((acc, i) => ({ acc, address: hints[i]! }))
        .filter((x): x is { acc: { data: [string, string]; owner: string }; address: string } => x.acc !== null && x.acc.owner === DBC_PROGRAM)
        .map((x) => ({ ...x, state: parseDbcPool(this.web3, fromBase64(x.acc.data[0])) }))
        .filter((x): x is typeof x & { state: DbcPool } => x.state !== null && x.state.baseMint === base);
      if (pools.length === 0) continue;
      const side = await this.accounts([...pools.map((p) => p.state.config), base, quote]);
      const mintBase = side[pools.length];
      const mintQuote = side[pools.length + 1];
      if (!mintBase || !mintQuote) continue;
      pools.forEach((p, k) => {
        const cfg = side[k];
        const cfgQuote = cfg && cfg.owner === DBC_PROGRAM ? parseDbcConfigQuote(this.web3, fromBase64(cfg.data[0])) : null;
        if (cfgQuote !== quote) return;
        const s = p.state;
        out.push({
          ref: { chain: 'solana', dex: 'meteora-dbc', address: p.address },
          model: 'constant-product',
          token0: { chain: 'solana', address: base },
          token1: { chain: 'solana', address: quote },
          reserve0: s.baseReserve,
          reserve1: s.quoteReserve,
          feePpm: 0,
          updatedAt: this.now(),
          block: null,
          status: !s.migrated && s.migrationProgress === 0 && s.baseReserve > 0n ? 'active' : 'inactive',
          extra: { config: s.config, baseVault: s.baseVault, quoteVault: s.quoteVault, baseProgram: mintBase.owner, quoteProgram: mintQuote.owner },
        });
      });
    }
    return out;
  }
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** One DBC swap: `swap2` in exact-in mode (amount, minimum out, mode 0). The program enforces the minimum output. */
export function dbcSwapInstruction(web3: typeof Web3, adapter: DbcAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Web3.TransactionInstruction {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'meteora-dbc') throw new SwingsError('invalid', 'This pool cannot be swapped by the DBC builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const base = pool.token0.address;
  const quote = pool.token1.address;
  if (tokenIn.address !== base && tokenIn.address !== quote) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const keys = [
    meta(DBC_POOL_AUTHORITY), meta(x.config!), meta(pool.ref.address, true), meta(inAccount, true), meta(outAccount, true), meta(x.baseVault!, true), meta(x.quoteVault!, true), meta(base), meta(quote), meta(user, false, true),
    meta(x.baseProgram ?? TOKEN_PROGRAM_ID), meta(x.quoteProgram ?? TOKEN_PROGRAM_ID),
    // The optional referral account is left out by naming the program itself, as Anchor expects.
    meta(DBC_PROGRAM), meta(adapter.eventAuthority()), meta(DBC_PROGRAM),
  ];
  return new web3.TransactionInstruction({ programId: pk(DBC_PROGRAM), keys, data: Buffer.from(concat(DISC_SWAP2, u64le(amountIn), u64le(minOut), Uint8Array.from([0]))) });
}
