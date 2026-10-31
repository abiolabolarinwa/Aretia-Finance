/**
 * The DEX adapter catalogue: which factory on which chain is indexed, and how strongly each claim is evidenced.
 *
 * Addresses come from dex/entries.ts (Aretia's routing catalogue, itself checked by `npm run test:live`) and, for ApeSwap,
 * from a direct on-chain check made while building this (see `source`). Nothing is invented: a family/chain pair that is not
 * listed here is not indexed. Event signatures are hashed here from their text, and tests pin the hashes.
 */
import { keccak256 } from '../core/keccak.js';
import { CPMM_CREATE_FEE_RECEIVER, ORCA_FEE_TIER_ACCOUNTS } from '../indexer/solanaIndexer.js';
import { RAYDIUM_CPMM_PROGRAM } from '../solana/raydiumCpmm.js';
import { ORCA_WHIRLPOOL_PROGRAM } from '../solana/orcaWhirlpool.js';
import { PUMPSWAP_PROGRAM, PUMP_MIGRATION_AUTHORITY } from './solana/pumpswap.js';
import { EVM_AERODROME, EVM_PANCAKE_V3, EVM_SLIPSTREAM, EVM_V2_DEXES, EVM_V3_DEXES, EVM_V4 } from '../dex/entries.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmMiChain, MiChain } from './chains.js';
import { EVIDENCE as earned } from './evidence.js';
import type { Evidence } from './types.js';

const hex = (b: Uint8Array): string => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const topicOf = (signature: string): string => hex(keccak256(new TextEncoder().encode(signature)));

export const SIGNATURES = {
  v2PairCreated: 'PairCreated(address,address,address,uint256)',
  v2Swap: 'Swap(address,uint256,uint256,uint256,uint256,address)',
  v2Sync: 'Sync(uint112,uint112)',
  v3PoolCreated: 'PoolCreated(address,address,uint24,int24,address)',
  v3Swap: 'Swap(address,address,int256,int256,uint160,uint128,int24)',
  /** PancakeSwap V3 adds the protocol fee amounts to the Swap event, which changes its signature. */
  pancakeV3Swap: 'Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)',
  /** Aerodrome (Base): V2-style pools with a stable flag, and Slipstream (concentrated liquidity, a Uniswap V3 fork keyed by tick spacing). */
  aeroPoolCreated: 'PoolCreated(address,address,bool,address,uint256)',
  aeroSwap: 'Swap(address,address,uint256,uint256,uint256,uint256)',
  slipstreamPoolCreated: 'PoolCreated(address,address,int24,address)',
  /** Uniswap V4: one PoolManager holds every pool; a pool is its 32-byte id. */
  v4Initialize: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
  v4Swap: 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
} as const;

export const TOPICS = Object.fromEntries(Object.entries(SIGNATURES).map(([k, v]) => [k, topicOf(v)])) as Record<keyof typeof SIGNATURES, string>;

export type DexFamily = 'pancakeswap' | 'uniswap' | 'sushiswap' | 'apeswap' | 'aerodrome';

export interface DexAdapterSpec {
  id: string;
  family: DexFamily;
  name: string;
  chain: EvmMiChain;
  kind: 'v2' | 'v3' | 'v4';
  /** Lower-case factory address (for V4: the PoolManager, which emits both the creation and the swap events). */
  factory: string;
  creationTopic: string;
  swapTopic: string;
  evidence: Evidence;
  /** Where the address was confirmed. */
  source: string;
  /** Uniswap V4: the StateView contract that reads a pool's price and liquidity. */
  stateView?: string;
  /** Pools whose creation event is not Uniswap's: Aerodrome's `PoolCreated(token0, token1, stable, pool)` or Slipstream's `PoolCreated(token0, token1, tickSpacing, pool)`. */
  creationShape?: 'aero' | 'slipstream';
}

const FAMILY_OF: Readonly<Record<string, DexFamily>> = { pancakeswap: 'pancakeswap', uniswap: 'uniswap', sushiswap: 'sushiswap', aerodrome: 'aerodrome' };

function aerodromeSpec(e: DexEntry, family: DexFamily): DexAdapterSpec {
  const slip = e.protocol === 'aerodrome-slipstream';
  return {
    id: slip ? `aerodrome-slipstream-${e.chain}` : `aerodrome-v2-${e.chain}`,
    family,
    name: slip ? 'Aerodrome Slipstream' : 'Aerodrome',
    chain: e.chain as EvmMiChain,
    kind: slip ? 'v3' : 'v2',
    factory: e.factory!.toLowerCase(),
    creationTopic: slip ? TOPICS.slipstreamPoolCreated : TOPICS.aeroPoolCreated,
    swapTopic: slip ? TOPICS.v3Swap : TOPICS.aeroSwap,
    creationShape: slip ? 'slipstream' : 'aero',
    evidence: 'address-verified',
    source: 'Aretia routing catalogue (dex/entries.ts), read back from the chain',
  };
}

function fromEntry(e: DexEntry): DexAdapterSpec | null {
  const family = FAMILY_OF[e.id.split('-')[0]!];
  if (!family || !e.factory || e.chain === 'solana') return null;
  if (family === 'aerodrome') return aerodromeSpec(e, family);
  const v4 = e.protocol === 'uniswap-v4';
  const v3 = e.protocol === 'uniswap-v3';
  if (v4 && !e.stateView) return null;
  return {
    id: `${family}-${v4 ? 'v4' : v3 ? 'v3' : 'v2'}-${e.chain}`,
    family,
    name: e.name,
    chain: e.chain as EvmMiChain,
    kind: v4 ? 'v4' : v3 ? 'v3' : 'v2',
    factory: e.factory.toLowerCase(),
    creationTopic: v4 ? TOPICS.v4Initialize : v3 ? TOPICS.v3PoolCreated : TOPICS.v2PairCreated,
    swapTopic: v4 ? TOPICS.v4Swap : v3 ? (family === 'pancakeswap' ? TOPICS.pancakeV3Swap : TOPICS.v3Swap) : TOPICS.v2Swap,
    ...(v4 ? { stateView: e.stateView!.toLowerCase() } : {}),
    evidence: 'address-verified',
    source: 'Aretia routing catalogue (dex/entries.ts), checked on-chain by dex.live.ts',
  };
}

/**
 * ApeSwap's V2 factories. Its documentation site could not be fetched while building this, so the addresses were confirmed
 * on-chain instead: each answers `allPairsLength()` and its first pair's `name()` is "ApeSwapFinance LPs" (checked 2026-10-23
 * on BNB Chain, Polygon and Ethereum).
 */
const APESWAP: readonly [EvmMiChain, string][] = [
  ['bnb', '0x0841bd0b734e4f5853f0dd8d7ea041c241fb0da6'],
  ['polygon', '0xcf083be4164828f00cae704ec15a36d711491284'],
  ['ethereum', '0xbae5dc9b19004883d0377419fef3c2c8832d7d7b'],
];

const apeSpecs = (): DexAdapterSpec[] =>
  APESWAP.map(([chain, factory]) => ({
    id: `apeswap-v2-${chain}`,
    family: 'apeswap' as const,
    name: 'ApeSwap',
    chain,
    kind: 'v2' as const,
    factory,
    creationTopic: TOPICS.v2PairCreated,
    swapTopic: TOPICS.v2Swap,
    evidence: 'address-verified' as const,
    source: 'On-chain: allPairsLength() answers and the first pair is named "ApeSwapFinance LPs"',
  }));

/**
 * Evidence earned beyond the address check. Each entry is backed by a test that fails if it stops being true:
 *  - 'fixture-tested': the creation and swap decoders pass on real logs captured from that factory (fixtures/real-logs.json);
 *    evidence.ts is checked by decode.test.ts (and prints the table when MI_WRITE_SPECS=1) from what the decoders actually achieved
 *  - 'live-verified': the adapter ran end to end against a live node (mi/live.e2e.ts, `npm run test:live`)
 */
export const EARNED_EVIDENCE: Readonly<Record<string, Evidence>> = earned as Record<string, Evidence>;

/**
 * Adapters that ran end to end against a live public node (engine.live.ts, `npm run test:live`) and passed. Only an entry
 * backed by such a run belongs here, with the date and what was observed.
 */
export const LIVE_VERIFIED: Readonly<Record<string, { date: string; observed: string }>> = {
  'raydium-cpmm-solana': { date: '2026-10-23', observed: '5 pools and 6 tokens found from one hour of creations, 4 named from Metaplex metadata, 107 real swaps decoded from vault balance changes, SOL price read from Orca; a second run duplicated nothing' },
  'pumpswap-solana': { date: '2026-10-23', observed: '15 pump.fun graduation pools and 16 tokens found from one hour (all 16 named, Metaplex or Token-2022 metadata), 413 real swaps decoded from vault balance changes, SOL price read from Orca; a second run duplicated nothing. Pools created directly, not by graduation, are not found.' },
  'orca-whirlpool-solana': { date: '2026-10-23', observed: '3 pools and 3 tokens found from one hour of creations, 58 real swaps decoded from vault balance changes; a second run duplicated nothing' },
  'pancakeswap-v2-bnb': { date: '2026-10-23', observed: '31 pools and 34 tokens discovered from 2,400 blocks, 371 real swaps decoded and priced, resume from the checkpoint and a repeated backfill changed nothing' },
};

export function allSpecs(): DexAdapterSpec[] {
  const out: DexAdapterSpec[] = [];
  for (const e of [...EVM_V2_DEXES, ...EVM_V3_DEXES, ...EVM_PANCAKE_V3, ...EVM_V4, ...EVM_AERODROME, ...EVM_SLIPSTREAM]) {
    const s = fromEntry(e);
    if (s) out.push(s);
  }
  out.push(...apeSpecs());
  return out.map((s) => ({ ...s, evidence: LIVE_VERIFIED[s.id] ? ('live-verified' as Evidence) : (EARNED_EVIDENCE[s.id] ?? s.evidence) }));
}

export const specById = (id: string): DexAdapterSpec | null => allSpecs().find((s) => s.id === id) ?? null;

export interface SolanaAdapterSpec {
  id: string;
  family: 'raydium' | 'orca' | 'pump';
  name: string;
  chain: 'solana';
  kind: 'cpmm' | 'clmm';
  /** The program that owns the pools. */
  program: string;
  /** Accounts only pool creation touches: their signatures are the creations (see indexer/solanaIndexer.ts). */
  anchors: readonly string[];
  /** What the pool-creation decoder reports as the venue. */
  venue: 'Raydium CPMM' | 'Orca Whirlpool' | 'PumpSwap';
  evidence: Evidence;
  source: string;
}

/**
 * The Solana venues whose pool creation can be found without a streaming provider, and whose swaps are read from the balance
 * changes of the pool's token accounts. Program ids are the routing catalogue's (checked on chain by its live tests).
 */
export const SOLANA_SPECS: readonly SolanaAdapterSpec[] = [
  { id: 'raydium-cpmm-solana', family: 'raydium', name: 'Raydium CPMM', chain: 'solana', kind: 'cpmm', program: RAYDIUM_CPMM_PROGRAM, anchors: [CPMM_CREATE_FEE_RECEIVER], venue: 'Raydium CPMM', evidence: 'address-verified', source: 'Aretia routing catalogue; the pool-creation fee receiver is touched only by pool creation' },
  { id: 'orca-whirlpool-solana', family: 'orca', name: 'Orca Whirlpools', chain: 'solana', kind: 'clmm', program: ORCA_WHIRLPOOL_PROGRAM, anchors: Object.values(ORCA_FEE_TIER_ACCOUNTS), venue: 'Orca Whirlpool', evidence: 'address-verified', source: 'Aretia routing catalogue; each fee-tier account is named by every pool created in that tier' },
  { id: 'pumpswap-solana', family: 'pump', name: 'PumpSwap', chain: 'solana', kind: 'cpmm', program: PUMPSWAP_PROGRAM, anchors: [PUMP_MIGRATION_AUTHORITY], venue: 'PumpSwap', evidence: 'address-verified', source: 'create_pool decoded from the official IDL (pump-fun/pump-public-docs); pools found through the pump.fun migration authority (observed on mainnet, not named in the docs): graduations only, not pools created directly' },
].map((s) => ({ ...s, evidence: LIVE_VERIFIED[s.id] ? ('live-verified' as Evidence) : (EARNED_EVIDENCE[s.id] ?? s.evidence) })) as readonly SolanaAdapterSpec[];

export const solanaSpecById = (id: string): SolanaAdapterSpec | null => SOLANA_SPECS.find((s) => s.id === id) ?? null;

/** Any adapter, EVM or Solana, by id. */
export const adapterById = (id: string): { id: string; name: string; chain: MiChain; evidence: Evidence } | null => specById(id) ?? solanaSpecById(id);

/**
 * Solana programs in scope that are NOT indexed. PumpSwap and Meteora (DAMM v2, DLMM, Dynamic Bonding Curve) have program ids in
 * the routing catalogue, but no account that only their pool creation touches is known, so finding their pools needs a streaming
 * provider (a webhook or Geyser feed) or scanning the program's whole transaction stream.
 */
export const SOLANA_PLANNED: readonly { id: string; name: string; program: string; status: Evidence; note: string }[] = [
  { id: 'meteora-damm-v2', name: 'Meteora DAMM v2', program: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', status: 'planned', note: 'Needs a streaming provider to find pools (no creation-only account).' },
  { id: 'meteora-dlmm', name: 'Meteora DLMM', program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', status: 'planned', note: 'Not built.' },
  { id: 'meteora-dbc', name: 'Meteora Dynamic Bonding Curve', program: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', status: 'planned', note: 'Not built.' },
];

export type { MiChain };
