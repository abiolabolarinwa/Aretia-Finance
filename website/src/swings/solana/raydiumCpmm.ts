/**
 * Direct integration with Raydium's CPMM program (constant-product pools). Pools are found by deriving their
 * addresses from the program's own seeds, read from the chain, parsed against the program's published account
 * layout, and priced with the program's own rounding. No aggregator is involved.
 *
 * What this version refuses rather than guesses (the pool is reported as unusable, never mispriced):
 *  - pools with swaps disabled or not yet open;
 *  - pools with creator fees switched on;
 *  - pools that use Token-2022 for either mint (transfer fees and extensions change the maths).
 */
import type * as Web3 from '@solana/web3.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { TOKEN_2022_PROGRAM_ID } from '../../scripts/walletTools.js';

export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const DEFAULT_CONFIG_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export type SolRpc = <T>(method: string, params: unknown[]) => Promise<T>;

export interface CpmmPoolState {
  ammConfig: string;
  token0Vault: string;
  token1Vault: string;
  token0Mint: string;
  token1Mint: string;
  token0Program: string;
  token1Program: string;
  observation: string;
  status: number;
  openTime: bigint;
  protocolFees0: bigint;
  protocolFees1: bigint;
  fundFees0: bigint;
  fundFees1: bigint;
  creatorFeeEnabled: boolean;
  creatorFees0: bigint;
  creatorFees1: bigint;
}

export interface CpmmConfigState {
  index: number;
  tradeFeeRate: bigint;
  disableCreatePool: boolean;
}

const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

/** Anchor accounts start with an 8-byte type tag; the fields follow in declaration order. */
export function parsePoolState(web3: typeof Web3, data: Uint8Array): CpmmPoolState | null {
  if (data.length < 405 + 8) return null;
  const key = (o: number): string => new web3.PublicKey(data.slice(o, o + 32)).toBase58();
  return {
    ammConfig: key(8),
    token0Vault: key(72),
    token1Vault: key(104),
    token0Mint: key(168),
    token1Mint: key(200),
    token0Program: key(232),
    token1Program: key(264),
    observation: key(296),
    status: data[329]!,
    openTime: u64(data, 373),
    protocolFees0: u64(data, 341),
    protocolFees1: u64(data, 349),
    fundFees0: u64(data, 357),
    fundFees1: u64(data, 365),
    creatorFeeEnabled: data[390] === 1,
    creatorFees0: u64(data, 397),
    creatorFees1: u64(data, 405),
  };
}

export function parseConfigState(data: Uint8Array): CpmmConfigState | null {
  if (data.length < 8 + 20) return null;
  return { index: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(10, true), tradeFeeRate: u64(data, 12), disableCreatePool: data[9] === 1 };
}

/** The amount held by an SPL token account. */
export function tokenAccountAmount(data: Uint8Array): bigint | null {
  return data.length >= 72 ? u64(data, 64) : null;
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

interface RawAccount {
  data: [string, string];
  owner: string;
}

/** Orders two mints the way the program does: by their raw bytes. */
export function sortMints(web3: typeof Web3, a: string, b: string): [string, string] {
  const ba = new web3.PublicKey(a).toBytes();
  const bb = new web3.PublicKey(b).toBytes();
  for (let i = 0; i < 32; i++) if (ba[i] !== bb[i]) return ba[i]! < bb[i]! ? [a, b] : [b, a];
  return [a, b];
}

export class RaydiumCpmmAdapter {
  readonly program: Web3.PublicKey;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(RAYDIUM_CPMM_PROGRAM);
  }

  configAddress(index: number): string {
    const seed = new Uint8Array(2);
    new DataView(seed.buffer).setUint16(0, index, false); // big-endian, as the program derives it
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('amm_config'), seed], this.program)[0].toBase58();
  }

  poolAddress(config: string, mint0: string, mint1: string): string {
    const k = (s: string): Uint8Array => new this.web3.PublicKey(s).toBytes();
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('pool'), k(config), k(mint0), k(mint1)], this.program)[0].toBase58();
  }

  /** The vault authority every pool of this program shares. */
  authorityAddress(): string {
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('vault_and_lp_mint_auth_seed')], this.program)[0].toBase58();
  }

  private async accounts(addresses: string[]): Promise<(RawAccount | null)[]> {
    if (addresses.length === 0) return [];
    const r = await this.rpc<{ value: (RawAccount | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
    return r.value;
  }

  /** Every usable CPMM pool for a pair, across the fee configurations. Pools that cannot be priced exactly are left out. */
  async getPools(a: TokenRef, b: TokenRef, indexes: readonly number[] = DEFAULT_CONFIG_INDEXES): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const [m0, m1] = sortMints(this.web3, ta.address, tb.address);
    const configs = indexes.map((i) => this.configAddress(i));
    const pools = configs.map((c) => this.poolAddress(c, m0, m1));

    const poolAccounts = await this.accounts(pools);
    const found = poolAccounts.map((acc, i) => ({ acc, i })).filter((x): x is { acc: RawAccount; i: number } => x.acc !== null && x.acc.owner === RAYDIUM_CPMM_PROGRAM);
    if (found.length === 0) return [];
    const states = found.map((f) => ({ ...f, state: parsePoolState(this.web3, fromBase64(f.acc.data[0])) })).filter((f): f is typeof f & { state: CpmmPoolState } => f.state !== null);
    const configAccounts = await this.accounts(states.map((s) => s.state.ammConfig));
    const vaultAccounts = await this.accounts(states.flatMap((s) => [s.state.token0Vault, s.state.token1Vault]));

    const nowSeconds = BigInt(Math.floor(this.now() / 1000));
    const out: LiquidityPool[] = [];
    states.forEach((s, k) => {
      const st = s.state;
      const cfg = configAccounts[k] ? parseConfigState(fromBase64(configAccounts[k]!.data[0])) : null;
      const v0 = vaultAccounts[k * 2] ? tokenAccountAmount(fromBase64(vaultAccounts[k * 2]!.data[0])) : null;
      const v1 = vaultAccounts[k * 2 + 1] ? tokenAccountAmount(fromBase64(vaultAccounts[k * 2 + 1]!.data[0])) : null;
      if (!cfg || v0 === null || v1 === null) return;
      // The program's own address derivation must reproduce this pool: a mismatch means it is not the pool we asked for.
      if (st.token0Mint !== m0 || st.token1Mint !== m1 || configs[s.i] !== st.ammConfig) return;
      if (st.token0Program === TOKEN_2022_PROGRAM_ID || st.token1Program === TOKEN_2022_PROGRAM_ID) return; // not priced exactly yet
      if (st.creatorFeeEnabled) return; // creator fees change the output; not modelled
      const swapDisabled = (st.status & 4) !== 0;
      const reserve0 = v0 - st.protocolFees0 - st.fundFees0 - st.creatorFees0;
      const reserve1 = v1 - st.protocolFees1 - st.fundFees1 - st.creatorFees1;
      out.push({
        ref: { chain: 'solana', dex: 'raydium-cpmm', address: pools[s.i]! },
        model: 'constant-product',
        curve: 'raydium-cpmm',
        token0: { chain: 'solana', address: m0 },
        token1: { chain: 'solana', address: m1 },
        reserve0: reserve0 > 0n ? reserve0 : 0n,
        reserve1: reserve1 > 0n ? reserve1 : 0n,
        feePpm: Number(cfg.tradeFeeRate),
        updatedAt: this.now(),
        block: null,
        status: !swapDisabled && st.openTime <= nowSeconds && reserve0 > 0n && reserve1 > 0n ? 'active' : 'inactive',
        extra: {
          ammConfig: st.ammConfig,
          vault0: st.token0Vault,
          vault1: st.token1Vault,
          program0: st.token0Program,
          program1: st.token1Program,
          observation: st.observation,
          authority: this.authorityAddress(),
        },
      });
    });
    return out;
  }
}
