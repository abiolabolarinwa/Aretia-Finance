/**
 * Direct integration with Raydium's original AMM (version 4), which still holds much of Solana's older liquidity:
 * BOME, MEW, the SOL/USDC pool and many others. Before this, a token whose only pool was an AMM v4 pool needed an
 * outside route.
 *
 * An AMM v4 pool cannot be derived from the token pair (its address is chosen when it is created), so the candidate pool
 * addresses of a token come from DexScreener and every one is checked on-chain before it is used: it must be owned by the
 * AMM v4 program, name exactly this pair of mints, and be in a state that allows swaps. A wrong or hostile answer from the
 * index can therefore not send a swap anywhere; at worst it is ignored.
 *
 * The swap is `swap_base_in_v2`, the form of the instruction that does not touch the old order book, so it needs only the
 * pool, its authority and its two vaults. It is priced by simulating it on the program from the user's account, and the
 * program enforces the minimum output. A pool still tied to its order book that the program refuses fails the simulation
 * and is not offered.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { dexScreenerPoolHints, type PoolHints } from './meteoraDbc.js';
import { type SolRpc, tokenAccountAmount } from './raydiumCpmm.js';

export const AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
/** The pool authority is derived from this seed alone; every AMM v4 pool shares it. */
const AUTHORITY_SEED = 'amm authority';
const SWAP_BASE_IN_V2 = 16;
const POOL_SIZE = 752;

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface AmmV4Pool {
  status: bigint;
  swapFeeNumerator: bigint;
  swapFeeDenominator: bigint;
  needTakePnlCoin: bigint;
  needTakePnlPc: bigint;
  coinVault: string;
  pcVault: string;
  coinMint: string;
  pcMint: string;
}

/** Reads a pool account. Null when it is not the size of one. */
export function parseAmmV4Pool(web3: typeof Web3, data: Uint8Array): AmmV4Pool | null {
  if (data.length !== POOL_SIZE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { status: view.getBigUint64(0, true), swapFeeNumerator: view.getBigUint64(176, true), swapFeeDenominator: view.getBigUint64(184, true), needTakePnlCoin: view.getBigUint64(192, true), needTakePnlPc: view.getBigUint64(200, true), coinVault: pk(336), pcVault: pk(368), coinMint: pk(400), pcMint: pk(432) };
}

/** Statuses in which the program lets swaps through (initialised, swap-enabled). */
const swappable = (status: bigint): boolean => status === 1n || status === 6n || status === 7n;

export class AmmV4Adapter {
  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
    private readonly hints: PoolHints = dexScreenerPoolHints(),
  ) {}

  authority = (): string => this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode(AUTHORITY_SEED)], new this.web3.PublicKey(AMM_V4_PROGRAM))[0].toBase58();

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  /** Pools of the pair, verified on-chain, with the balances their vaults hold now. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const [ha, hb] = await Promise.all([this.hints(ta.address), this.hints(tb.address)]);
    const candidates = [...new Set([...ha, ...hb])].slice(0, 30);
    if (candidates.length === 0) return [];
    const raw = await this.accounts(candidates);
    const found = raw
      .map((acc, i) => ({ acc, address: candidates[i]! }))
      .filter((x): x is { acc: { data: [string, string]; owner: string }; address: string } => x.acc !== null && x.acc.owner === AMM_V4_PROGRAM)
      .map((x) => ({ ...x, state: parseAmmV4Pool(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is typeof x & { state: AmmV4Pool } => x.state !== null && ((x.state.coinMint === ta.address && x.state.pcMint === tb.address) || (x.state.coinMint === tb.address && x.state.pcMint === ta.address)));
    if (found.length === 0) return [];
    const vaults = await this.accounts(found.flatMap((f) => [f.state.coinVault, f.state.pcVault]));
    const out: LiquidityPool[] = [];
    found.forEach((f, k) => {
      const vc = vaults[k * 2];
      const vp = vaults[k * 2 + 1];
      if (!vc || !vp || vc.owner !== TOKEN_PROGRAM_ID || vp.owner !== TOKEN_PROGRAM_ID) return;
      const s = f.state;
      // What traders can use is the vault balance less the pool's unclaimed profit.
      const coin = (tokenAccountAmount(fromBase64(vc.data[0])) ?? 0n) - s.needTakePnlCoin;
      const pc = (tokenAccountAmount(fromBase64(vp.data[0])) ?? 0n) - s.needTakePnlPc;
      out.push({
        ref: { chain: 'solana', dex: 'raydium-amm-v4', address: f.address },
        model: 'constant-product',
        token0: { chain: 'solana', address: s.coinMint },
        token1: { chain: 'solana', address: s.pcMint },
        reserve0: coin > 0n ? coin : 0n,
        reserve1: pc > 0n ? pc : 0n,
        feePpm: s.swapFeeDenominator > 0n ? Number((s.swapFeeNumerator * 1_000_000n) / s.swapFeeDenominator) : 0,
        updatedAt: this.now(),
        block: null,
        status: swappable(s.status) && coin > 0n && pc > 0n ? 'active' : 'inactive',
        extra: { coinVault: s.coinVault, pcVault: s.pcVault },
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

/** One `swap_base_in_v2`: exactly `amountIn` of the input token for at least `minOut` of the other. The program enforces the floor. */
export function ammV4SwapInstruction(web3: typeof Web3, adapter: AmmV4Adapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Web3.TransactionInstruction {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'raydium-amm-v4') throw new SwingsError('invalid', 'This pool cannot be swapped by the AMM v4 builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (tokenIn.address !== pool.token0.address && tokenIn.address !== pool.token1.address) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const data = new Uint8Array(17);
  data[0] = SWAP_BASE_IN_V2;
  data.set(u64le(amountIn), 1);
  data.set(u64le(minOut), 9);
  const keys = [meta(TOKEN_PROGRAM_ID), meta(pool.ref.address, true), meta(adapter.authority()), meta(x.coinVault!, true), meta(x.pcVault!, true), meta(inAccount, true), meta(outAccount, true), meta(user, false, true)];
  return new web3.TransactionInstruction({ programId: pk(AMM_V4_PROGRAM), keys, data: Buffer.from(data) });
}

// ------------------------------------------------------------------ the older form, through the pool's order book

const SWAP_BASE_IN = 9;
const MARKET_MIN_SIZE = 380;

/** The accounts of the order book (a Serum or OpenBook market) a pool is tied to, read from the pool and the market. */
export interface AmmV4Book {
  openOrders: string;
  targetOrders: string;
  serumProgram: string;
  market: string;
  bids: string;
  asks: string;
  eventQueue: string;
  baseVault: string;
  quoteVault: string;
  vaultSigner: string;
}

/** Reads the book's accounts. The signer is derived from the market and the nonce the market stores. Null when the market is too short. */
export function parseAmmV4Book(web3: typeof Web3, pool: Uint8Array, market: Uint8Array): AmmV4Book | null {
  if (pool.length !== POOL_SIZE || market.length < MARKET_MIN_SIZE) return null;
  const pk = (d: Uint8Array, o: number): Web3.PublicKey => new web3.PublicKey(d.subarray(o, o + 32));
  const serumProgram = pk(pool, 560);
  const marketKey = pk(pool, 528);
  const nonce = new DataView(market.buffer, market.byteOffset, market.byteLength).getBigUint64(45, true);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, true);
  let signer: Web3.PublicKey;
  try {
    signer = web3.PublicKey.createProgramAddressSync([marketKey.toBytes(), nonceBytes], serumProgram);
  } catch {
    return null;
  }
  return { openOrders: pk(pool, 496).toBase58(), targetOrders: pk(pool, 592).toBase58(), serumProgram: serumProgram.toBase58(), market: marketKey.toBase58(), bids: pk(market, 285).toBase58(), asks: pk(market, 317).toBase58(), eventQueue: pk(market, 253).toBase58(), baseVault: pk(market, 117).toBase58(), quoteVault: pk(market, 165).toBase58(), vaultSigner: signer.toBase58() };
}

/**
 * The same pools as `AmmV4Adapter`, swapped the older way: `swap_base_in` through the pool's own order book. A pool the program
 * refuses to swap through the newer instruction (`swap_base_in_v2`) can still be swapped this way, so this is offered as a venue
 * of its own and the router keeps whichever of the two pays more. Each is priced by simulating it on the program.
 */
export class AmmV4BookAdapter {
  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly base: AmmV4Adapter,
    private readonly now: () => number = Date.now,
  ) {}

  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const pools = await this.base.getPools(a, b);
    if (pools.length === 0) return [];
    const poolAccs = (await this.rpc<{ value: ({ data: [string, string] } | null)[] }>('getMultipleAccounts', [pools.map((p) => p.ref.address), { encoding: 'base64', commitment: 'confirmed' }])).value;
    const marketKeys = poolAccs.map((acc) => (acc ? new this.web3.PublicKey(fromBase64(acc.data[0]).subarray(528, 560)).toBase58() : this.web3.PublicKey.default.toBase58()));
    const marketAccs = (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [marketKeys, { encoding: 'base64', commitment: 'confirmed' }])).value;
    const out: LiquidityPool[] = [];
    pools.forEach((p, i) => {
      const poolAcc = poolAccs[i];
      const marketAcc = marketAccs[i];
      if (!poolAcc || !marketAcc) return;
      const book = parseAmmV4Book(this.web3, fromBase64(poolAcc.data[0]), fromBase64(marketAcc.data[0]));
      if (!book || marketAcc.owner !== book.serumProgram) return;
      out.push({ ...p, ref: { ...p.ref, dex: 'raydium-amm-v4-book' }, updatedAt: this.now(), extra: { ...p.extra, ...book } });
    });
    return out;
  }
}

/** One `swap_base_in` through the pool's order book: exactly `amountIn` of the input token for at least `minOut` of the other. */
export function ammV4BookSwapInstruction(web3: typeof Web3, adapter: AmmV4Adapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Web3.TransactionInstruction {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'raydium-amm-v4-book' || !x.market) throw new SwingsError('invalid', 'This pool cannot be swapped by the order-book builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (tokenIn.address !== pool.token0.address && tokenIn.address !== pool.token1.address) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const data = new Uint8Array(17);
  data[0] = SWAP_BASE_IN;
  data.set(u64le(amountIn), 1);
  data.set(u64le(minOut), 9);
  const keys = [
    meta(TOKEN_PROGRAM_ID), meta(pool.ref.address, true), meta(adapter.authority()), meta(x.openOrders!, true), meta(x.targetOrders!, true), meta(x.coinVault!, true), meta(x.pcVault!, true),
    meta(x.serumProgram!), meta(x.market!, true), meta(x.bids!, true), meta(x.asks!, true), meta(x.eventQueue!, true), meta(x.baseVault!, true), meta(x.quoteVault!, true), meta(x.vaultSigner!),
    meta(inAccount, true), meta(outAccount, true), meta(user, false, true),
  ];
  return new web3.TransactionInstruction({ programId: pk(AMM_V4_PROGRAM), keys, data: Buffer.from(data) });
}
