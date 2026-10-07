/**
 * Direct integration with PumpSwap (pump.fun's AMM), the largest venue for new Solana tokens. Pools are found by
 * the program's own address derivation, parsed against the layout the program publishes, and swapped with its
 * `buy_exact_quote_in` and `sell` instructions. Like Orca and DAMM v2, the program itself is the quoter: a swap
 * is simulated from the user's account and the amount delivered is the price.
 *
 * Source of truth: the program's on-chain IDL (accounts, discriminators, PDA seeds) and real swap transactions, which
 * showed three trailing accounts the published IDL does not list yet (`pool_v2` and the buyback fee recipient with its
 * token account). Every account list here was proven by simulating buys and sells on the real program (see
 * solana.live.ts). If PumpSwap changes its account list again, simulation fails and the route is simply not offered.
 *
 * Scope, stated plainly: canonical pump.fun pools only (index 0, created by the pump.fun program for a token that
 * graduated). Other creators' pools for the same pair are not discovered, because they cannot be derived from the pair.
 */
import type * as Web3 from '@solana/web3.js';
import { ataAddress } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { tokenAccountAmount, type SolRpc } from './raydiumCpmm.js';

export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
/** The pump.fun bonding-curve program: it is the creator of every canonical PumpSwap pool, through a per-token authority. */
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** The second seed of the fee-config account, a constant of the fee program. */
const FEE_CONFIG_SEED = Uint8Array.from([12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99]);

const DISC_BUY_EXACT_QUOTE_IN = Uint8Array.from([198, 46, 21, 82, 180, 217, 232, 112]);
const DISC_SELL = Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]);

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface PumpPool {
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
  isCashback: boolean;
}

/** Reads a pool account. Null when it is too short or not a pool. */
export function parsePumpPool(web3: typeof Web3, data: Uint8Array): PumpPool | null {
  if (data.length < 245) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { index: view.getUint16(9, true), creator: pk(11), baseMint: pk(43), quoteMint: pk(75), baseVault: pk(139), quoteVault: pk(171), coinCreator: pk(211), isCashback: data[244] === 1 };
}

export interface PumpGlobal {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  coinCreatorFeeBps: bigint;
  disableFlags: number;
  protocolFeeRecipients: string[];
  buybackFeeRecipients: string[];
}

/** Reads the global config: fees, which actions are disabled, and the fee recipients a swap must name. */
export function parsePumpGlobal(web3: typeof Web3, data: Uint8Array): PumpGlobal | null {
  if (data.length < 899) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const list = (o: number): string[] => Array.from({ length: 8 }, (_, i) => new web3.PublicKey(data.subarray(o + i * 32, o + i * 32 + 32)).toBase58()).filter((a) => a !== '11111111111111111111111111111111');
  return {
    lpFeeBps: view.getBigUint64(40, true),
    protocolFeeBps: view.getBigUint64(48, true),
    disableFlags: data[56]!,
    protocolFeeRecipients: list(57),
    coinCreatorFeeBps: view.getBigUint64(313, true),
    buybackFeeRecipients: list(643),
  };
}

export class PumpSwapAdapter {
  private readonly program: Web3.PublicKey;
  private global: PumpGlobal | null = null;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(PUMPSWAP_PROGRAM);
  }

  private pda(seeds: Uint8Array[], program: Web3.PublicKey = this.program): string {
    return this.web3.PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  }
  private key = (a: string): Uint8Array => new this.web3.PublicKey(a).toBytes();

  /** The canonical pool of a token against a quote: index 0, created by the pump.fun program's per-token authority. */
  canonicalPool(baseMint: string, quoteMint: string): string {
    const authority = this.pda([enc('pool-authority'), this.key(baseMint)], new this.web3.PublicKey(PUMP_PROGRAM));
    return this.pda([enc('pool'), new Uint8Array(2), this.key(authority), this.key(baseMint), this.key(quoteMint)]);
  }

  globalConfigAddress = (): string => this.pda([enc('global_config')]);
  eventAuthority = (): string => this.pda([enc('__event_authority')]);
  globalVolumeAccumulator = (): string => this.pda([enc('global_volume_accumulator')]);
  userVolumeAccumulator = (user: string): string => this.pda([enc('user_volume_accumulator'), this.key(user)]);
  creatorVault = (coinCreator: string): string => this.pda([enc('creator_vault'), this.key(coinCreator)]);
  poolV2 = (baseMint: string): string => this.pda([enc('pool-v2'), this.key(baseMint)]);
  feeConfig = (): string => this.pda([enc('fee_config'), FEE_CONFIG_SEED], new this.web3.PublicKey(PUMP_FEE_PROGRAM));

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  async globalConfig(): Promise<PumpGlobal> {
    if (this.global) return this.global;
    const [acc] = await this.accounts([this.globalConfigAddress()]);
    const g = acc && acc.owner === PUMPSWAP_PROGRAM ? parsePumpGlobal(this.web3, fromBase64(acc.data[0])) : null;
    if (!g) throw new SwingsError('provider-failed', 'PumpSwap\'s global configuration could not be read.');
    this.global = g;
    return g;
  }

  /** Canonical pools for a pair, in either order, that hold liquidity and allow buying and selling. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const candidates = [{ base: ta.address, quote: tb.address }, { base: tb.address, quote: ta.address }].map((c) => ({ ...c, pool: this.canonicalPool(c.base, c.quote) }));
    const raw = await this.accounts(candidates.map((c) => c.pool));
    const found = raw
      .map((acc, i) => ({ acc, c: candidates[i]! }))
      .filter((x): x is { acc: { data: [string, string]; owner: string }; c: (typeof candidates)[number] } => x.acc !== null && x.acc.owner === PUMPSWAP_PROGRAM)
      .map((x) => ({ ...x, state: parsePumpPool(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is typeof x & { state: PumpPool } => x.state !== null && x.state.baseMint === x.c.base && x.state.quoteMint === x.c.quote && x.state.index === 0);
    if (found.length === 0) return [];
    const [global, ...vaults] = [await this.globalConfig(), ...(await this.accounts(found.flatMap((f) => [f.state.baseVault, f.state.quoteVault])))];
    // Disabled buying or selling (flags 3 and 4) means the pool cannot be used in both directions.
    const swappable = (global.disableFlags & 0b11000) === 0;
    const feePpm = Number(global.lpFeeBps + global.protocolFeeBps + global.coinCreatorFeeBps) * 100;
    const out: LiquidityPool[] = [];
    found.forEach((f, k) => {
      const vb = vaults[k * 2];
      const vq = vaults[k * 2 + 1];
      if (!vb || !vq) return;
      const reserveBase = tokenAccountAmount(fromBase64(vb.data[0])) ?? 0n;
      const reserveQuote = tokenAccountAmount(fromBase64(vq.data[0])) ?? 0n;
      const s = f.state;
      out.push({
        ref: { chain: 'solana', dex: 'pumpswap', address: f.c.pool },
        model: 'constant-product',
        token0: { chain: 'solana', address: s.baseMint },
        token1: { chain: 'solana', address: s.quoteMint },
        reserve0: reserveBase,
        reserve1: reserveQuote,
        feePpm,
        updatedAt: this.now(),
        block: null,
        status: swappable && reserveBase > 0n && reserveQuote > 0n ? 'active' : 'inactive',
        extra: {
          baseVault: s.baseVault,
          quoteVault: s.quoteVault,
          coinCreator: s.coinCreator,
          baseProgram: vb.owner,
          quoteProgram: vq.owner,
          cashback: s.isCashback ? '1' : '0',
        },
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
 * The instructions of one PumpSwap swap, in order: idempotent creation of the three token accounts the program
 * writes (protocol fee recipient, coin-creator vault, buyback recipient; the user pays rent only if one is missing),
 * then the swap. Selling the base token calls `sell`; buying it with the quote token calls `buy_exact_quote_in`.
 */
export async function pumpSwapInstructions(web3: typeof Web3, adapter: PumpSwapAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Promise<Web3.TransactionInstruction[]> {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'pumpswap') throw new SwingsError('invalid', 'This pool cannot be swapped by the PumpSwap builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const baseMint = pool.token0.address;
  const quoteMint = pool.token1.address;
  const selling = tokenIn.address === baseMint;
  if (!selling && tokenIn.address !== quoteMint) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const g = await adapter.globalConfig();
  const feeRecipient = g.protocolFeeRecipients[0];
  const buybackRecipient = g.buybackFeeRecipients[0];
  if (!feeRecipient || !buybackRecipient) throw new SwingsError('provider-failed', 'PumpSwap lists no fee recipient.');

  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const creatorAuthority = adapter.creatorVault(x.coinCreator!);
  const feeRecipientAta = ataAddress(web3, feeRecipient, quoteMint, x.quoteProgram!);
  const creatorAta = ataAddress(web3, creatorAuthority, quoteMint, x.quoteProgram!);
  const buybackAta = ataAddress(web3, buybackRecipient, quoteMint, x.quoteProgram!);
  const userBase = selling ? inAccount : outAccount;
  const userQuote = selling ? outAccount : inAccount;
  const globalConfig = adapter.globalConfigAddress();
  const feeConfig = adapter.feeConfig();

  const idempotentAta = (ata: string, owner: string): Web3.TransactionInstruction =>
    new web3.TransactionInstruction({ programId: pk(ATA_PROGRAM), keys: [meta(user, true, true), meta(ata, true), meta(owner), meta(quoteMint), meta('11111111111111111111111111111111'), meta(x.quoteProgram!)], data: Buffer.from([1]) });

  const common = [
    meta(pool.ref.address, true), meta(user, true, true), meta(globalConfig), meta(baseMint), meta(quoteMint), meta(userBase, true), meta(userQuote, true),
    meta(x.baseVault!, true), meta(x.quoteVault!, true), meta(feeRecipient), meta(feeRecipientAta, true), meta(x.baseProgram!), meta(x.quoteProgram!),
    meta('11111111111111111111111111111111'), meta(ATA_PROGRAM), meta(adapter.eventAuthority()), meta(PUMPSWAP_PROGRAM), meta(creatorAta, true), meta(creatorAuthority),
  ];
  // Trailing accounts the live program requires: the pool's v2 record, then the buyback fee recipient and its token account.
  const tail = [meta(adapter.poolV2(baseMint)), meta(buybackRecipient), meta(buybackAta, true)];
  const swap = selling
    ? new web3.TransactionInstruction({ programId: pk(PUMPSWAP_PROGRAM), keys: [...common, meta(feeConfig), meta(PUMP_FEE_PROGRAM), ...tail], data: Buffer.from(concat(DISC_SELL, u64le(amountIn), u64le(minOut))) })
    : new web3.TransactionInstruction({
        programId: pk(PUMPSWAP_PROGRAM),
        keys: [...common, meta(adapter.globalVolumeAccumulator()), meta(adapter.userVolumeAccumulator(user), true), meta(feeConfig), meta(PUMP_FEE_PROGRAM), ...tail],
        // spendable_quote_in, min_base_amount_out, track_volume = false
        data: Buffer.from(concat(DISC_BUY_EXACT_QUOTE_IN, u64le(amountIn), u64le(minOut), Uint8Array.from([0]))),
      });
  return [idempotentAta(feeRecipientAta, feeRecipient), idempotentAta(creatorAta, creatorAuthority), idempotentAta(buybackAta, buybackRecipient), swap];
}

