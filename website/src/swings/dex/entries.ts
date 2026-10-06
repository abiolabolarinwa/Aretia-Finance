/**
 * Real protocol deployments Aretia routes through directly. All lower-case. An entry is only a claim until
 * `npm run test:live` has proved on-chain that the contracts exist and answer correctly (dex/dex.live.ts);
 * that test is the evidence, and a failing test means the entry must be fixed or removed.
 *
 * Sources: each protocol's published deployment lists. Nothing here is test data or a placeholder.
 */
import { POOLS } from '../../data/site.js';
import type { DexEntry } from '../engine/registry.js';

export const WRAPPED_NATIVE = {
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  bnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  polygon: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  base: '0x4200000000000000000000000000000000000006',
} as const;

export const EVM_V2_DEXES: readonly DexEntry[] = [
  {
    id: 'uniswap-v2-ethereum',
    name: 'Uniswap V2',
    chain: 'ethereum',
    protocol: 'uniswap-v2',
    model: 'constant-product',
    mechanism: 'evm-v2-router',
    router: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
    factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
    feePpm: 3000,
    wrappedNative: WRAPPED_NATIVE.ethereum,
    status: 'ACTIVE',
  },
  {
    id: 'pancakeswap-v2-bnb',
    name: 'PancakeSwap V2',
    chain: 'bnb',
    protocol: 'uniswap-v2',
    model: 'constant-product',
    mechanism: 'evm-v2-router',
    router: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
    factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
    feePpm: 2500,
    wrappedNative: WRAPPED_NATIVE.bnb,
    status: 'ACTIVE',
  },
  {
    id: 'quickswap-v2-polygon',
    name: 'QuickSwap V2',
    chain: 'polygon',
    protocol: 'uniswap-v2',
    model: 'constant-product',
    mechanism: 'evm-v2-router',
    router: '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff',
    factory: '0x5757371414417b8c6caad45baef941abc7d3ab32',
    feePpm: 3000,
    wrappedNative: WRAPPED_NATIVE.polygon,
    status: 'ACTIVE',
  },
  {
    id: 'uniswap-v2-base',
    name: 'Uniswap V2',
    chain: 'base',
    protocol: 'uniswap-v2',
    model: 'constant-product',
    mechanism: 'evm-v2-router',
    router: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
    factory: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
    feePpm: 3000,
    wrappedNative: WRAPPED_NATIVE.base,
    status: 'ACTIVE',
  },
];

/**
 * Uniswap V3 (concentrated liquidity) on the chains where it is deployed and integrated. `router` is SwapRouter02,
 * `quoter` is QuoterV2. BNB Chain (PancakeSwap V3) is not integrated yet.
 */
export const EVM_V3_DEXES: readonly DexEntry[] = [
  {
    id: 'uniswap-v3-ethereum',
    name: 'Uniswap V3',
    chain: 'ethereum',
    protocol: 'uniswap-v3',
    model: 'concentrated',
    mechanism: 'evm-v3-router',
    router: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
    quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
    wrappedNative: WRAPPED_NATIVE.ethereum,
    status: 'ACTIVE',
  },
  {
    id: 'uniswap-v3-polygon',
    name: 'Uniswap V3',
    chain: 'polygon',
    protocol: 'uniswap-v3',
    model: 'concentrated',
    mechanism: 'evm-v3-router',
    router: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
    quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
    wrappedNative: WRAPPED_NATIVE.polygon,
    status: 'ACTIVE',
  },
  {
    id: 'uniswap-v3-base',
    name: 'Uniswap V3',
    chain: 'base',
    protocol: 'uniswap-v3',
    model: 'concentrated',
    mechanism: 'evm-v3-router',
    router: '0x2626664c2603336e57b271c5c0b26f421741e481',
    factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
    quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
    wrappedNative: WRAPPED_NATIVE.base,
    status: 'ACTIVE',
  },
];

/** Every direct venue Aretia routes through. */
export const EVM_DEXES: readonly DexEntry[] = [...EVM_V2_DEXES, ...EVM_V3_DEXES];

/** Solana venues integrated directly. Raydium CPMM only so far: constant-product pools, single hop, no Token-2022. */
export const SOLANA_DEXES: readonly DexEntry[] = [
  {
    id: 'raydium-cpmm',
    name: 'Raydium CPMM',
    chain: 'solana',
    protocol: 'raydium',
    model: 'constant-product',
    mechanism: 'solana-program',
    router: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    status: 'ACTIVE',
    notes: 'Pools with creator fees and Token-2022 mints are excluded because they cannot be priced exactly yet.',
  },
  {
    id: 'meteora-damm-v2',
    name: 'Meteora DAMM v2',
    chain: 'solana',
    protocol: 'meteora',
    model: 'concentrated',
    mechanism: 'solana-program',
    router: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
    // ACT's launch pools, from the one place they are recorded (data/site.ts POOLS). Other DAMM v2 pools are not discovered yet.
    knownPools: POOLS.map((p) => p.address),
    status: 'ACTIVE',
    notes: 'Quoted by simulating the swap on the program itself, so it needs the user\'s account. Only the pools listed here are used.',
  },
];
