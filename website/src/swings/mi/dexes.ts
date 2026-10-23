/**
 * The DEX adapter catalogue: which factory on which chain is indexed, and how strongly each claim is evidenced.
 *
 * Addresses come from dex/entries.ts (Aretia's routing catalogue, itself checked by `npm run test:live`) and, for ApeSwap,
 * from a direct on-chain check made while building this (see `source`). Nothing is invented: a family/chain pair that is not
 * listed here is not indexed. Event signatures are hashed here from their text, and tests pin the hashes.
 */
import { keccak256 } from '../core/keccak.js';
import { EVM_PANCAKE_V3, EVM_V2_DEXES, EVM_V3_DEXES } from '../dex/entries.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmMiChain, MiChain } from './chains.js';
import type { Evidence, PoolKind } from './types.js';

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
} as const;

export const TOPICS = Object.fromEntries(Object.entries(SIGNATURES).map(([k, v]) => [k, topicOf(v)])) as Record<keyof typeof SIGNATURES, string>;

export type DexFamily = 'pancakeswap' | 'uniswap' | 'sushiswap' | 'apeswap';

export interface DexAdapterSpec {
  id: string;
  family: DexFamily;
  name: string;
  chain: EvmMiChain;
  kind: PoolKind;
  /** Lower-case factory address. */
  factory: string;
  creationTopic: string;
  swapTopic: string;
  evidence: Evidence;
  /** Where the address was confirmed. */
  source: string;
}

const FAMILY_OF: Readonly<Record<string, DexFamily>> = { pancakeswap: 'pancakeswap', uniswap: 'uniswap', sushiswap: 'sushiswap' };

function fromEntry(e: DexEntry): DexAdapterSpec | null {
  const family = FAMILY_OF[e.id.split('-')[0]!];
  if (!family || !e.factory || e.chain === 'solana' || e.chain === 'robinhood') return null;
  const v3 = e.protocol === 'uniswap-v3';
  return {
    id: `${family}-${v3 ? 'v3' : 'v2'}-${e.chain}`,
    family,
    name: e.name,
    chain: e.chain as EvmMiChain,
    kind: v3 ? 'v3' : 'v2',
    factory: e.factory.toLowerCase(),
    creationTopic: v3 ? TOPICS.v3PoolCreated : TOPICS.v2PairCreated,
    swapTopic: v3 ? (family === 'pancakeswap' ? TOPICS.pancakeV3Swap : TOPICS.v3Swap) : TOPICS.v2Swap,
    evidence: 'address-verified',
    source: 'Aretia routing catalogue (dex/entries.ts), checked on-chain by dex.live.ts',
  };
}

/**
 * ApeSwap's V2 factories. Its documentation site could not be fetched while building this, so the addresses were confirmed
 * on-chain instead: each answers `allPairsLength()` and its first pair's `name()` is "ApeSwapFinance LPs" (checked 2026-10-23
 * on BNB Chain, Polygon, Arbitrum and Ethereum).
 */
const APESWAP: readonly [EvmMiChain, string][] = [
  ['bnb', '0x0841bd0b734e4f5853f0dd8d7ea041c241fb0da6'],
  ['polygon', '0xcf083be4164828f00cae704ec15a36d711491284'],
  ['arbitrum', '0xcf083be4164828f00cae704ec15a36d711491284'],
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
 *  - 'fixture-tested': the creation and swap decoders pass on real logs captured from that factory (fixtures/real-logs.json)
 *  - 'live-verified': the adapter ran end to end against a live node (mi/live.e2e.ts, `npm run test:live`)
 */
export const EARNED_EVIDENCE: Readonly<Record<string, Evidence>> = {};

export function allSpecs(): DexAdapterSpec[] {
  const out: DexAdapterSpec[] = [];
  for (const e of [...EVM_V2_DEXES, ...EVM_V3_DEXES, ...EVM_PANCAKE_V3]) {
    const s = fromEntry(e);
    if (s) out.push(s);
  }
  out.push(...apeSpecs());
  return out.map((s) => ({ ...s, evidence: EARNED_EVIDENCE[s.id] ?? s.evidence }));
}

export const specById = (id: string): DexAdapterSpec | null => allSpecs().find((s) => s.id === id) ?? null;

/** The Solana programs in scope, with the program ids already used by Aretia's routing. Discovery for them is not built yet. */
export const SOLANA_PROGRAMS: readonly { id: string; name: string; program: string; status: Evidence; note: string }[] = [
  { id: 'pumpswap', name: 'PumpSwap', program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', status: 'planned', note: 'Program id from the routing catalogue; no indexer adapter yet.' },
  { id: 'raydium-cpmm', name: 'Raydium CPMM', program: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', status: 'planned', note: 'Pool creation is decoded by the older discovery source (indexer/solanaIndexer.ts); not part of the new pipeline yet.' },
  { id: 'orca-whirlpool', name: 'Orca Whirlpools', program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', status: 'planned', note: 'As above.' },
  { id: 'meteora-damm-v2', name: 'Meteora DAMM v2', program: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', status: 'planned', note: 'No indexer adapter yet.' },
  { id: 'meteora-dlmm', name: 'Meteora DLMM', program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', status: 'planned', note: 'No indexer adapter yet.' },
  { id: 'meteora-dbc', name: 'Meteora Dynamic Bonding Curve', program: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', status: 'planned', note: 'No indexer adapter yet.' },
];

export type { MiChain };
