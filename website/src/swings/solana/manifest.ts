/**
 * Direct integration with Manifest, a fully on-chain order book on Solana: a swap takes the best resting orders of a market
 * until it is filled. Before this, a token traded only on a Manifest market needed an outside route.
 *
 * A Manifest market is an account of its own (not derived from the token pair), so the candidate markets of a pair come from
 * Manifest's public market list and every one is checked on-chain before it is used: owned by the Manifest program, a market
 * account, naming exactly this pair of mints, with its two vaults. A wrong or hostile answer from the list can therefore not
 * send a swap anywhere; at worst it is ignored.
 *
 * The swap is `Swap` in exact-in mode, priced by simulating it on the program from the user's account (an order book has no
 * formula), and the program enforces the minimum output. Matching against another trader's "global" order needs extra
 * accounts the program names when it needs them; a market whose best orders are of that kind fails the simulation and is not
 * offered, rather than quoted wrongly.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { type SolRpc, tokenAccountAmount } from './raydiumCpmm.js';

export const MANIFEST_PROGRAM = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms';
const SYSTEM = '11111111111111111111111111111111';
const IX_SWAP = 4;
/** `MARKET_FIXED_DISCRIMINANT` of the program, little-endian. */
const MARKET_DISCRIMINANT = 4859840929024028656n;
const MARKETS_URL = 'https://mfx-stats-mainnet.fly.dev/tickers';
const MAX_CANDIDATES = 8;

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface ManifestMarket {
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
}

/** Reads a market account. Null when it is too short or is not one. */
export function parseManifestMarket(web3: typeof Web3, data: Uint8Array): ManifestMarket | null {
  if (data.length < 144 || new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(0, true) !== MARKET_DISCRIMINANT) return null;
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { baseMint: pk(16), quoteMint: pk(48), baseVault: pk(80), quoteVault: pk(112) };
}

/** Candidate market addresses for a pair, from Manifest's public market list. Unverified: each is checked on-chain before use. */
export type MarketHints = (a: string, b: string) => Promise<string[]>;

export function manifestMarketHints(fetchImpl: typeof fetch = (...x) => fetch(...x), now: () => number = Date.now): MarketHints {
  let cache: { at: number; rows: { id: string; base: string; target: string; live: boolean }[] } | null = null;
  return async (a, b) => {
    try {
      if (!cache || now() - cache.at > 300_000) {
        const res = await fetchImpl(MARKETS_URL, { headers: { accept: 'application/json' } });
        if (!res.ok) return [];
        const body = (await res.json()) as unknown;
        if (!Array.isArray(body)) return [];
        cache = {
          at: now(),
          rows: body
            .map((t) => t as { pool_id?: unknown; base_currency?: unknown; target_currency?: unknown; bid?: unknown; ask?: unknown })
            .filter((t): t is { pool_id: string; base_currency: string; target_currency: string; bid?: unknown; ask?: unknown } => typeof t.pool_id === 'string' && typeof t.base_currency === 'string' && typeof t.target_currency === 'string')
            .map((t) => ({ id: t.pool_id, base: t.base_currency, target: t.target_currency, live: !!t.bid && !!t.ask })),
        };
      }
      return cache.rows
        .filter((r) => (r.base === a && r.target === b) || (r.base === b && r.target === a))
        .filter((r) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.id))
        .sort((x, y) => Number(y.live) - Number(x.live))
        .slice(0, MAX_CANDIDATES)
        .map((r) => r.id);
    } catch {
      return [];
    }
  };
}

export class ManifestAdapter {
  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
    private readonly hints: MarketHints = manifestMarketHints(),
  ) {}

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  /** Markets of the pair, verified on-chain, with what their vaults hold now. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const candidates = await this.hints(ta.address, tb.address);
    if (candidates.length === 0) return [];
    const raw = await this.accounts(candidates);
    const found = raw
      .map((acc, i) => ({ acc, address: candidates[i]! }))
      .filter((x): x is { acc: { data: [string, string]; owner: string }; address: string } => x.acc !== null && x.acc.owner === MANIFEST_PROGRAM)
      .map((x) => ({ ...x, state: parseManifestMarket(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is typeof x & { state: ManifestMarket } => x.state !== null && ((x.state.baseMint === ta.address && x.state.quoteMint === tb.address) || (x.state.baseMint === tb.address && x.state.quoteMint === ta.address)));
    if (found.length === 0) return [];
    const side = await this.accounts(found.flatMap((f) => [f.state.baseVault, f.state.quoteVault, f.state.baseMint, f.state.quoteMint]));
    const out: LiquidityPool[] = [];
    found.forEach((f, k) => {
      const [vb, vq, mb, mq] = [side[k * 4], side[k * 4 + 1], side[k * 4 + 2], side[k * 4 + 3]];
      if (!vb || !vq || !mb || !mq) return;
      const base = tokenAccountAmount(fromBase64(vb.data[0])) ?? 0n;
      const quote = tokenAccountAmount(fromBase64(vq.data[0])) ?? 0n;
      out.push({
        ref: { chain: 'solana', dex: 'manifest', address: f.address },
        model: 'constant-product',
        token0: { chain: 'solana', address: f.state.baseMint },
        token1: { chain: 'solana', address: f.state.quoteMint },
        reserve0: base,
        reserve1: quote,
        feePpm: 0,
        updatedAt: this.now(),
        block: null,
        status: base > 0n || quote > 0n ? 'active' : 'inactive',
        extra: { baseVault: f.state.baseVault, quoteVault: f.state.quoteVault, baseProgram: mb.owner, quoteProgram: mq.owner },
      });
    });
    return out;
  }
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** One `Swap` in exact-in mode: at most `amountIn` of the input token for at least `minOut` of the other. The program enforces the floor. */
export function manifestSwapInstruction(web3: typeof Web3, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Web3.TransactionInstruction {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'manifest') throw new SwingsError('invalid', 'This market cannot be swapped by the Manifest builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const baseIn = tokenIn.address === pool.token0.address;
  if (!baseIn && tokenIn.address !== pool.token1.address) throw new SwingsError('invalid', 'The input token is not in this market.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const traderBase = baseIn ? inAccount : outAccount;
  const traderQuote = baseIn ? outAccount : inAccount;
  const baseProgram = x.baseProgram ?? TOKEN_PROGRAM_ID;
  const quoteProgram = x.quoteProgram ?? TOKEN_PROGRAM_ID;
  const keys = [meta(user, true, true), meta(pool.ref.address, true), meta(SYSTEM), meta(traderBase, true), meta(traderQuote, true), meta(x.baseVault!, true), meta(x.quoteVault!, true), meta(baseProgram)];
  // A Token-2022 side also names its mint; the quote token program is named when it differs from the base one.
  if (baseProgram === TOKEN_2022_PROGRAM_ID) keys.push(meta(pool.token0.address));
  if (quoteProgram !== baseProgram || quoteProgram === TOKEN_2022_PROGRAM_ID) keys.push(meta(quoteProgram));
  if (quoteProgram === TOKEN_2022_PROGRAM_ID) keys.push(meta(pool.token1.address));
  // instruction 4, in_atoms, out_atoms, is_base_in, is_exact_in
  const data = new Uint8Array(1 + 8 + 8 + 1 + 1);
  data[0] = IX_SWAP;
  data.set(u64le(amountIn), 1);
  data.set(u64le(minOut), 9);
  data[17] = baseIn ? 1 : 0;
  data[18] = 1;
  return new web3.TransactionInstruction({ programId: pk(MANIFEST_PROGRAM), keys, data: Buffer.from(data) });
}
