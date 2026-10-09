/**
 * One interface for every Solana venue Aretia routes through, so the provider can compare, chain and split
 * across them without knowing which program is underneath. A venue finds pools for a pair and builds that
 * program's swap instruction; it never signs or sends. Adding a venue means adding an entry here and in the
 * registry, nothing in the routing code.
 */
import type * as Web3 from '@solana/web3.js';
import type { TokenRef } from '../core/types.js';
import type { AretiaDexRegistry } from '../engine/registry.js';
import { quoteConstantProduct } from '../engine/amm.js';
import type { LiquidityPool } from '../engine/types.js';
import { dammSwapInstruction, MeteoraDammAdapter } from './meteoraDamm.js';
import { OrcaWhirlpoolAdapter, whirlpoolSwapInstruction } from './orcaWhirlpool.js';
import { PumpSwapAdapter, pumpSwapInstructions } from './pumpswap.js';
import { PumpCurveAdapter, pumpCurveInstructions } from './pumpCurve.js';
import { LaunchlabAdapter, launchlabSwapInstruction } from './raydiumLaunchlab.js';
import { DbcAdapter, dbcSwapInstruction } from './meteoraDbc.js';
import { BoopAdapter, boopSwapInstructions } from './boopCurve.js';
import { MoonshotAdapter, moonshotSwapInstructions } from './moonshotCurve.js';
import { AmmV4Adapter, ammV4SwapInstruction } from './raydiumAmmV4.js';
import { ClmmAdapter, clmmSwapInstruction } from './raydiumClmm.js';
import { ManifestAdapter, manifestSwapInstruction } from './manifest.js';
import { dlmmSwapInstruction, MeteoraDlmmAdapter } from './meteoraDlmm.js';
import { cpmmSwapInstruction } from './builder.js';
import { RaydiumCpmmAdapter, type SolRpc } from './raydiumCpmm.js';
import { TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';

export interface SolanaVenue {
  /** Registry id, also the `dex` of every pool this venue returns. */
  readonly id: string;
  readonly name: string;
  /** Pools holding exactly this pair that can trade now. */
  getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]>;
  /**
   * Aretia's own exact price, when it has one. Venues without it are priced by the program itself, by simulating
   * the swap from the user's account.
   */
  localQuote?(pool: LiquidityPool, tokenIn: TokenRef, amountIn: bigint): bigint;
  /** The token program that owns a mint, which decides its associated-account address. */
  programFor(pool: LiquidityPool, mint: string): string;
  /** One instruction, or several when the venue needs accounts created first (all in the same transaction). */
  swapInstruction(user: string, pool: LiquidityPool, tokenIn: TokenRef, tokenOut: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Promise<Web3.TransactionInstruction | Web3.TransactionInstruction[]>;
  /** One line for the review screen. */
  label(pool: LiquidityPool, amountIn: bigint, minOut: bigint): string;
}

const other = (pool: LiquidityPool, tokenIn: TokenRef): TokenRef => (pool.token0.address === tokenIn.address ? pool.token1 : pool.token0);
const exact = (name: string, pool: LiquidityPool, amountIn: bigint, minOut: bigint): string => `${name} pool ${pool.ref.address.slice(0, 8)}…: swap exactly ${amountIn} (raw) for at least ${minOut} (raw), or the whole transaction fails.`;

export function createSolanaVenues(web3: typeof Web3, rpc: SolRpc, registry: AretiaDexRegistry, now: () => number): SolanaVenue[] {
  const venues: SolanaVenue[] = [];
  for (const entry of registry.routable('solana')) {
    if (entry.mechanism !== 'solana-program') continue;
    if (entry.id === 'raydium-cpmm') {
      const adapter = new RaydiumCpmmAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        localQuote: (pool, tokenIn, amountIn) => quoteConstantProduct(pool, tokenIn, amountIn),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.program0! : pool.extra!.program1!),
        swapInstruction: (user, pool, tokenIn, tokenOut, i, o, amountIn, minOut) => cpmmSwapInstruction(web3, user, { pool, tokenIn, tokenOut, amountIn, minOut }, i, o),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'meteora-damm-v2') {
      const adapter = new MeteoraDammAdapter(web3, rpc, entry.knownPools ?? [], now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.programA! : pool.extra!.programB!),
        swapInstruction: (user, pool, _tokenIn, _tokenOut, i, o, amountIn, minOut) => dammSwapInstruction(web3, user, pool, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'meteora-dlmm') {
      const adapter = new MeteoraDlmmAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.programX! : pool.extra!.programY!),
        swapInstruction: (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => dlmmSwapInstruction(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'pumpswap') {
      const adapter = new PumpSwapAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.baseProgram! : pool.extra!.quoteProgram!),
        swapInstruction: (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => pumpSwapInstructions(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'manifest') {
      const adapter = new ManifestAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.baseProgram! : pool.extra!.quoteProgram!),
        swapInstruction: async (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => manifestSwapInstruction(web3, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'raydium-clmm') {
      const adapter = new ClmmAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.program0! : pool.extra!.program1!),
        swapInstruction: async (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => {
          const zeroForOne = tokenIn.address === pool.token0.address;
          const arrays = await adapter.tickArraysFor(pool.ref.address, { tickCurrent: Number(pool.extra!.tickCurrent), tickSpacing: Number(pool.extra!.tickSpacing) }, zeroForOne);
          return clmmSwapInstruction(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut, arrays);
        },
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'raydium-amm-v4') {
      const adapter = new AmmV4Adapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: () => TOKEN_PROGRAM_ID,
        swapInstruction: async (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => ammV4SwapInstruction(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'moonshot') {
      const adapter = new MoonshotAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: () => TOKEN_PROGRAM_ID,
        swapInstruction: (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => moonshotSwapInstructions(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'boop') {
      const adapter = new BoopAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: () => TOKEN_PROGRAM_ID,
        swapInstruction: async (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => boopSwapInstructions(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'meteora-dbc') {
      const adapter = new DbcAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.baseProgram! : pool.extra!.quoteProgram!),
        swapInstruction: async (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => dbcSwapInstruction(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'raydium-launchlab') {
      const adapter = new LaunchlabAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.baseProgram! : pool.extra!.quoteProgram!),
        swapInstruction: async (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => launchlabSwapInstruction(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'pump-curve') {
      const adapter = new PumpCurveAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: (pool, mint) => (mint === pool.token0.address ? pool.extra!.mintProgram! : TOKEN_PROGRAM_ID),
        swapInstruction: (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => pumpCurveInstructions(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    } else if (entry.id === 'orca-whirlpool') {
      const adapter = new OrcaWhirlpoolAdapter(web3, rpc, now);
      venues.push({
        id: entry.id,
        name: entry.name,
        getPools: (a, b) => adapter.getPools(a, b),
        programFor: () => TOKEN_PROGRAM_ID,
        swapInstruction: (user, pool, tokenIn, _tokenOut, i, o, amountIn, minOut) => whirlpoolSwapInstruction(web3, adapter, user, pool, tokenIn, i, o, amountIn, minOut),
        label: (pool, amountIn, minOut) => exact(entry.name, pool, amountIn, minOut),
      });
    }
  }
  return venues;
}

export { other as otherToken };
