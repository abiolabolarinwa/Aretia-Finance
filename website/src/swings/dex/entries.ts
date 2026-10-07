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

/**
 * PancakeSwap V3 on BNB Chain: the same concentrated-liquidity design as Uniswap V3 with its own contracts and fee
 * tiers (0.01%, 0.05%, 0.25%, 1%). `router` is its SmartRouter, which takes the same swap calls.
 */
export const EVM_PANCAKE_V3: readonly DexEntry[] = [
  {
    id: 'pancakeswap-v3-bnb',
    name: 'PancakeSwap V3',
    chain: 'bnb',
    protocol: 'uniswap-v3',
    model: 'concentrated',
    mechanism: 'evm-v3-router',
    router: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
    factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    quoter: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
    feeTiers: [100, 500, 2500, 10_000],
    wrappedNative: WRAPPED_NATIVE.bnb,
    status: 'ACTIVE',
  },
];

/** Aerodrome on Base: the largest venue there. Volatile and stable pools behind one router. */
export const EVM_AERODROME: readonly DexEntry[] = [
  {
    id: 'aerodrome-base',
    name: 'Aerodrome',
    chain: 'base',
    protocol: 'aerodrome',
    model: 'constant-product',
    mechanism: 'evm-aerodrome-router',
    router: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    factory: '0x420dd381b31aef6683db6b902084cb0ffece40da',
    wrappedNative: WRAPPED_NATIVE.base,
    status: 'ACTIVE',
    notes: 'Priced by the router itself (exact for volatile and stable pools).',
  },
];

const BALANCER_VAULT = '0xba12222222228d8ba445958a75a0704d566bf2c8';

/**
 * Balancer V2: one Vault per chain holds every pool. The Vault cannot list pools by pair, so these are curated pool
 * ids (weighted pools, chosen from Balancer's own listing by liquidity and re-checked on-chain before use). Liquidity
 * on V2 has shrunk since late 2025, so only pools that still hold meaningful value are listed.
 */
export const EVM_BALANCER: readonly DexEntry[] = [
  {
    id: 'balancer-v2-ethereum',
    name: 'Balancer V2',
    chain: 'ethereum',
    protocol: 'balancer',
    model: 'constant-product',
    mechanism: 'evm-balancer-vault',
    router: BALANCER_VAULT,
    wrappedNative: WRAPPED_NATIVE.ethereum,
    knownPools: [
      '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014', // BAL / WETH
      '0xa6f548df93de924d73be7d25dc02554c6bd66db500020000000000000000000e', // WBTC / WETH
      '0x3de27efa2f1aa663ae5d458857e731c129069f29000200000000000000000588', // wstETH / AAVE
      '0x39eb558131e5ebeb9f76a6cbf6898f6e6dce5e4e0002000000000000000005c8', // QI / WETH
      '0x9232a548dd9e81bac65500b5e0d918f8ba93675c000200000000000000000423', // WETH / LIT
      '0x92762b42a06dcdddc5b7362cfb01e631c4d44b40000200000000000000000182', // GNO / COW
    ],
    status: 'ACTIVE',
  },
  {
    id: 'balancer-v2-polygon',
    name: 'Balancer V2',
    chain: 'polygon',
    protocol: 'balancer',
    model: 'constant-product',
    mechanism: 'evm-balancer-vault',
    router: BALANCER_VAULT,
    wrappedNative: WRAPPED_NATIVE.polygon,
    knownPools: [
      '0x03cd191f589d12b0582a99808cf19851e468e6b500010000000000000000000a', // WBTC / USDC / WETH
      '0x0297e37f1873d2dab4487aa67cd56b58e2f27875000100000000000000000002', // wPOL / USDC / WETH / BAL
      '0x3bd8a254163f8328efcc4f8c36da566753462433000200000000000000000dc1', // USDC / TEL
    ],
    status: 'ACTIVE',
  },
  {
    id: 'balancer-v2-base',
    name: 'Balancer V2',
    chain: 'base',
    protocol: 'balancer',
    model: 'constant-product',
    mechanism: 'evm-balancer-vault',
    router: BALANCER_VAULT,
    wrappedNative: WRAPPED_NATIVE.base,
    knownPools: [
      '0x007bb7a4bfc214df06474e39142288e99540f2b3000200000000000000000191', // WETH / IMO
      '0x5332584890d6e415a6dc910254d6430b8aab7e69000200000000000000000103', // OLAS / USDC
      '0x2da6e67c45af2aaa539294d9fa27ea50ce4e2c5f0002000000000000000001a3', // WETH / OLAS
    ],
    status: 'ACTIVE',
  },
];

/**
 * Curve standard stable pools (int128-indexed, ERC-20 coins). Each pool is its own contract. Pool addresses are
 * curated and re-checked on-chain (`coins`, a live `get_dy`) before use; a pool of another kind never routes.
 */
export const EVM_CURVE: readonly DexEntry[] = [
  {
    id: 'curve-ethereum',
    name: 'Curve',
    chain: 'ethereum',
    protocol: 'curve',
    model: 'stable',
    mechanism: 'evm-curve-pool',
    knownPools: [
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7', // 3pool: DAI / USDC / USDT
      '0x4dece678ceceb27446b35c672dc7d61f30bad69e', // crvUSD / USDC
    ],
    wrappedNative: WRAPPED_NATIVE.ethereum,
    status: 'ACTIVE',
  },
  {
    id: 'curve-base',
    name: 'Curve',
    chain: 'base',
    protocol: 'curve',
    model: 'stable',
    mechanism: 'evm-curve-pool',
    knownPools: ['0xf6c5f01c7f3148891ad0e19df78743d31e390d1f'], // 4pool
    wrappedNative: WRAPPED_NATIVE.base,
    status: 'ACTIVE',
  },
];

/** Every direct venue Aretia routes through. */
export const EVM_DEXES: readonly DexEntry[] = [...EVM_V2_DEXES, ...EVM_V3_DEXES, ...EVM_PANCAKE_V3, ...EVM_AERODROME, ...EVM_BALANCER, ...EVM_CURVE];

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
    id: 'orca-whirlpool',
    name: 'Orca Whirlpool',
    chain: 'solana',
    protocol: 'orca',
    model: 'concentrated',
    mechanism: 'solana-program',
    router: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    status: 'ACTIVE',
    notes: 'Priced by simulating the swap on the program itself. Pools with Token-2022 mints are not routed.',
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
