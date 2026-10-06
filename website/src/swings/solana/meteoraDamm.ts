/**
 * Direct integration with Meteora DAMM v2 (program cp-amm), the venue ACT's own pools live on.
 *
 * Pricing here is deliberately NOT re-implemented. DAMM v2 prices through a concentrated range, a base-fee
 * schedule, an optional dynamic fee and a fee mode, and any of those can change with the program. Instead the
 * program itself is the quoter: the exact transaction is simulated against the real program with the user's own
 * accounts, and the amount it would deliver is read from the balance change. That is exact by construction and
 * cannot drift from the program's maths. (Aretia's own local maths for this venue is a later, separately
 * verified step; it would be checked against this same simulation.)
 *
 * Pool layout and address constants were read from the program source and confirmed against the real
 * ACT/USDC pool on mainnet (see solana.live.ts).
 */
import type * as Web3 from '@solana/web3.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { tokenAccountAmount, type SolRpc } from './raydiumCpmm.js';

export const METEORA_DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

export interface DammPoolState {
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  liquidity: bigint;
  sqrtPrice: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  activationPoint: bigint;
  /** 0 = slot, 1 = unix timestamp. */
  activationType: number;
  /** 0 = enabled, 1 = disabled. */
  poolStatus: number;
}

const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number): bigint => u64(d, o) + (u64(d, o + 8) << 64n);
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Anchor tag, then PoolFeesStruct (160 bytes), then the fields in declaration order. */
export function parseDammPool(web3: typeof Web3, data: Uint8Array): DammPoolState | null {
  if (data.length < 8 + 500) return null;
  const key = (o: number): string => new web3.PublicKey(data.slice(o, o + 32)).toBase58();
  return {
    tokenAMint: key(168),
    tokenBMint: key(200),
    tokenAVault: key(232),
    tokenBVault: key(264),
    liquidity: u128(data, 360),
    sqrtMinPrice: u128(data, 424),
    sqrtMaxPrice: u128(data, 440),
    sqrtPrice: u128(data, 456),
    activationPoint: u64(data, 472),
    activationType: data[480]!,
    poolStatus: data[481]!,
  };
}

interface RawAccount {
  data: [string, string];
  owner: string;
}

export class MeteoraDammAdapter {
  readonly program: Web3.PublicKey;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    /** Pool addresses Aretia knows about for this venue (for ACT: the treasury's launch pools). */
    private readonly knownPools: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(METEORA_DAMM_V2_PROGRAM);
  }

  poolAuthority(): string {
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('pool_authority')], this.program)[0].toBase58();
  }

  eventAuthority(): string {
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('__event_authority')], this.program)[0].toBase58();
  }

  private async accounts(addresses: string[]): Promise<(RawAccount | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: (RawAccount | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  /** Known pools that hold exactly this pair and can currently trade. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    if (this.knownPools.length === 0) return [];
    const raw = await this.accounts([...this.knownPools]);
    const states = raw
      .map((acc, i) => ({ acc, address: this.knownPools[i]! }))
      .filter((x): x is { acc: RawAccount; address: string } => x.acc !== null && x.acc.owner === METEORA_DAMM_V2_PROGRAM)
      .map((x) => ({ address: x.address, state: parseDammPool(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is { address: string; state: DammPoolState } => x.state !== null)
      .filter((x) => [x.state.tokenAMint, x.state.tokenBMint].sort().join() === [ta.address, tb.address].sort().join());
    if (states.length === 0) return [];

    // The vaults and the two mints (for each mint's token program) in one read.
    const extra = await this.accounts(states.flatMap((s) => [s.state.tokenAVault, s.state.tokenBVault, s.state.tokenAMint, s.state.tokenBMint]));
    let slot: number | null = null;
    const out: LiquidityPool[] = [];
    for (let i = 0; i < states.length; i++) {
      const s = states[i]!.state;
      const [vaultA, vaultB, mintA, mintB] = extra.slice(i * 4, i * 4 + 4);
      if (!vaultA || !vaultB || !mintA || !mintB) continue;
      const reserve0 = tokenAccountAmount(fromBase64(vaultA.data[0])) ?? 0n;
      const reserve1 = tokenAccountAmount(fromBase64(vaultB.data[0])) ?? 0n;
      // Activation is by slot or by time; compare in the right unit. If the slot cannot be read the pool is not used.
      let activated: boolean;
      if (s.activationType === 1) activated = BigInt(Math.floor(this.now() / 1000)) >= s.activationPoint;
      else {
        slot ??= (await this.rpc<number>('getSlot', [{ commitment: 'confirmed' }]).catch(() => null)) ?? -1;
        activated = slot >= 0 && BigInt(slot) >= s.activationPoint;
      }
      out.push({
        ref: { chain: 'solana', dex: 'meteora-damm-v2', address: states[i]!.address },
        model: 'concentrated',
        token0: { chain: 'solana', address: s.tokenAMint },
        token1: { chain: 'solana', address: s.tokenBMint },
        reserve0,
        reserve1,
        // The fee is not a single number here (schedule and dynamic fee): the program reports the effect through simulation.
        feePpm: 0,
        updatedAt: this.now(),
        block: null,
        status: s.poolStatus === 0 && activated && s.liquidity > 0n ? 'active' : 'inactive',
        extra: {
          vaultA: s.tokenAVault,
          vaultB: s.tokenBVault,
          programA: mintA.owner,
          programB: mintB.owner,
          poolAuthority: this.poolAuthority(),
          eventAuthority: this.eventAuthority(),
        },
      });
    }
    return out;
  }
}

let cachedDisc: Uint8Array | null = null;
/** Anchor tag of the `swap` instruction: first 8 bytes of sha256("global:swap"). */
export async function dammSwapDiscriminator(): Promise<Uint8Array> {
  if (cachedDisc) return cachedDisc;
  cachedDisc = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:swap'))).slice(0, 8);
  return cachedDisc;
}

const u64le = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
};

/** The `swap` instruction with the program's account list. The optional referral account is passed as the program id (none). */
export async function dammSwapInstruction(web3: typeof Web3, user: string, pool: LiquidityPool, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Promise<Web3.TransactionInstruction> {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'meteora-damm-v2') throw new SwingsError('invalid', 'This pool cannot be swapped by the DAMM v2 builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable: boolean, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const disc = await dammSwapDiscriminator();
  const data = new Uint8Array(24);
  data.set(disc, 0);
  data.set(u64le(amountIn), 8);
  data.set(u64le(minOut), 16);
  return new web3.TransactionInstruction({
    programId: pk(METEORA_DAMM_V2_PROGRAM),
    keys: [
      meta(x.poolAuthority!, false),
      meta(pool.ref.address, true),
      meta(inAccount, true),
      meta(outAccount, true),
      meta(x.vaultA!, true),
      meta(x.vaultB!, true),
      meta(pool.token0.address, false),
      meta(pool.token1.address, false),
      meta(user, false, true),
      meta(x.programA!, false),
      meta(x.programB!, false),
      meta(METEORA_DAMM_V2_PROGRAM, false), // referral_token_account: not used
      meta(x.eventAuthority!, false),
      meta(METEORA_DAMM_V2_PROGRAM, false),
    ],
    data: Buffer.from(data),
  });
}
