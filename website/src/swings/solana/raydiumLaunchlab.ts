/**
 * Direct integration with Raydium LaunchLab, the bonding-curve launchpad behind LetsBonk and other launchers: where a
 * token trades from its launch until its curve fills and it moves to Raydium's own pools. Before this, such a token had
 * no pool Aretia could read.
 *
 * The pool of a token is found by the program's own address derivation (seeds "pool", the token's mint and the quote
 * mint), parsed against the layout of the program's published IDL, and swapped with `buy_exact_in` and `sell_exact_in`.
 * Like PumpSwap, the program itself is the quoter: a swap is simulated from the user's account and the amount
 * delivered is the price, so a change on the program's side can never make Aretia quote something it will not do.
 *
 * Unlike pump.fun's curve, LaunchLab trades against a quote token account (wrapped SOL for SOL-priced launches), so
 * the route builder's normal wrapping and unwrapping applies unchanged.
 *
 * Scope, stated plainly: pools still in their funding (trading) state. A migrated pool lives on Raydium's own AMM, which
 * is a different venue. Quote tokens other than wrapped SOL and USDC are not looked for.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { type SolRpc } from './raydiumCpmm.js';

export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Quote tokens a launch can be priced in that Aretia looks for. */
export const LAUNCHLAB_QUOTES: readonly string[] = [WSOL, USDC];

const DISC_BUY_EXACT_IN = Uint8Array.from([250, 234, 13, 123, 213, 156, 19, 236]);
const DISC_SELL_EXACT_IN = Uint8Array.from([149, 39, 222, 155, 211, 124, 152, 26]);

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface LaunchlabPool {
  /** 0 while the curve is trading, 1 while it migrates, 2 once it has migrated. */
  status: number;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  globalConfig: string;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  creator: string;
}

/** Reads a pool-state account. Null when it is too short to be one. */
export function parseLaunchlabPool(web3: typeof Web3, data: Uint8Array): LaunchlabPool | null {
  if (data.length < 365) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { status: data[17]!, virtualBase: view.getBigUint64(37, true), virtualQuote: view.getBigUint64(45, true), realBase: view.getBigUint64(53, true), realQuote: view.getBigUint64(61, true), globalConfig: pk(141), platformConfig: pk(173), baseMint: pk(205), quoteMint: pk(237), baseVault: pk(269), quoteVault: pk(301), creator: pk(333) };
}

export class LaunchlabAdapter {
  private readonly program: Web3.PublicKey;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(LAUNCHLAB_PROGRAM);
  }

  private pda(seeds: Uint8Array[]): string {
    return this.web3.PublicKey.findProgramAddressSync(seeds, this.program)[0].toBase58();
  }
  private key = (a: string): Uint8Array => new this.web3.PublicKey(a).toBytes();

  poolAddress = (baseMint: string, quoteMint: string): string => this.pda([enc('pool'), this.key(baseMint), this.key(quoteMint)]);
  authority = (): string => this.pda([enc('vault_auth_seed')]);
  eventAuthority = (): string => this.pda([enc('__event_authority')]);
  /** Where the platform's and the creator's share of the fee is kept; the live program asks for the system program and then both after the named accounts. */
  platformFeeVault = (platformConfig: string, quoteMint: string): string => this.pda([this.key(platformConfig), this.key(quoteMint)]);
  creatorFeeVault = (creator: string, quoteMint: string): string => this.pda([this.key(creator), this.key(quoteMint)]);

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  /** The token's launch pools against each quote token Aretia looks for, in either order of the pair, still trading. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const pairs: { base: string; quote: string }[] = [];
    if (LAUNCHLAB_QUOTES.includes(tb.address) && !LAUNCHLAB_QUOTES.includes(ta.address)) pairs.push({ base: ta.address, quote: tb.address });
    if (LAUNCHLAB_QUOTES.includes(ta.address) && !LAUNCHLAB_QUOTES.includes(tb.address)) pairs.push({ base: tb.address, quote: ta.address });
    if (pairs.length === 0) return [];
    const addrs = pairs.map((p) => this.poolAddress(p.base, p.quote));
    const raw = await this.accounts(addrs);
    const found = raw
      .map((acc, i) => ({ acc, p: pairs[i]!, address: addrs[i]! }))
      .filter((x): x is { acc: { data: [string, string]; owner: string }; p: { base: string; quote: string }; address: string } => x.acc !== null && x.acc.owner === LAUNCHLAB_PROGRAM)
      .map((x) => ({ ...x, state: parseLaunchlabPool(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is typeof x & { state: LaunchlabPool } => x.state !== null && x.state.baseMint === x.p.base && x.state.quoteMint === x.p.quote);
    if (found.length === 0) return [];
    // The token programs of the two mints decide the associated-account addresses.
    const mints = await this.accounts(found.flatMap((f) => [f.state.baseMint, f.state.quoteMint]));
    const out: LiquidityPool[] = [];
    found.forEach((f, k) => {
      const baseAcc = mints[k * 2];
      const quoteAcc = mints[k * 2 + 1];
      if (!baseAcc || !quoteAcc) return;
      const s = f.state;
      out.push({
        ref: { chain: 'solana', dex: 'raydium-launchlab', address: f.address },
        model: 'constant-product',
        token0: { chain: 'solana', address: s.baseMint },
        token1: { chain: 'solana', address: s.quoteMint },
        reserve0: s.virtualBase,
        reserve1: s.virtualQuote,
        feePpm: 0,
        updatedAt: this.now(),
        block: null,
        status: s.status === 0 && s.virtualBase > 0n && s.virtualQuote > 0n ? 'active' : 'inactive',
        extra: { baseVault: s.baseVault, quoteVault: s.quoteVault, globalConfig: s.globalConfig, platformConfig: s.platformConfig, creator: s.creator, baseProgram: baseAcc.owner, quoteProgram: quoteAcc.owner },
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

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/**
 * One LaunchLab swap: `buy_exact_in` when the quote token goes in, `sell_exact_in` when the launched token does. The
 * minimum output is enforced by the program. No share-fee (referral) rate is set.
 */
export function launchlabSwapInstruction(web3: typeof Web3, adapter: LaunchlabAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Web3.TransactionInstruction {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'raydium-launchlab') throw new SwingsError('invalid', 'This pool cannot be swapped by the LaunchLab builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const base = pool.token0.address;
  const quote = pool.token1.address;
  const buying = tokenIn.address === quote;
  if (!buying && tokenIn.address !== base) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const userBase = buying ? outAccount : inAccount;
  const userQuote = buying ? inAccount : outAccount;
  const keys = [
    meta(user, true, true), meta(adapter.authority()), meta(x.globalConfig!), meta(x.platformConfig!), meta(pool.ref.address, true), meta(userBase, true), meta(userQuote, true),
    meta(x.baseVault!, true), meta(x.quoteVault!, true), meta(base), meta(quote), meta(x.baseProgram!), meta(x.quoteProgram ?? TOKEN_PROGRAM_ID), meta(adapter.eventAuthority()), meta(LAUNCHLAB_PROGRAM),
    meta('11111111111111111111111111111111'), meta(adapter.platformFeeVault(x.platformConfig!, quote), true), meta(adapter.creatorFeeVault(x.creator!, quote), true),
  ];
  // amount_in, minimum_amount_out, share_fee_rate = 0
  return new web3.TransactionInstruction({ programId: pk(LAUNCHLAB_PROGRAM), keys, data: Buffer.from(concat(buying ? DISC_BUY_EXACT_IN : DISC_SELL_EXACT_IN, u64le(amountIn), u64le(minOut), u64le(0n))) });
}
