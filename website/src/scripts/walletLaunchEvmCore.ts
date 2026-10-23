/**
 * Aretia Launch on the web wallet, Ethereum-style chains: the rules for creating a token, with no network access and no keys.
 *
 * One fixed-supply ERC-20 per creation, made by Aretia's immutable factory contract (contracts-evm/AretiaTokenFactory.sol). The token has no
 * owner and no mint, pause, freeze or fee-on-transfer function: the whole supply is minted once, to the creator, inside the same transaction
 * that creates it. The only Aretia charge is a flat creation fee in the chain's own coin, sent with that same transaction.
 *
 * A chain is switched on only when BOTH its factory address and its fee address are written in LAUNCH_EVM_CHAINS below. Until then the page
 * shows it as not available yet. The fee amount is fixed in code and is also fixed inside each deployed factory; the checks before signing
 * refuse a factory whose on-chain fee or recipient differs from this table.
 */
import { fromSmallestUnit, toSmallestUnit } from './walletTools.js';

export type LaunchEvmChainKey = 'bnb' | 'ethereum' | 'polygon' | 'bscTestnet' | 'sepolia' | 'polygonAmoy';

/**
 * The locked-launch factory (contracts-evm/AretiaLaunchFactory.sol): one transaction creates the token AND opens its pool with the
 * liquidity locked. All of these are fixed inside the deployed factory and read back from the chain before signing.
 */
export interface LaunchSettings {
  /** The deployed AretiaLaunchFactory, lower-case, or null until it is deployed and this table is updated. */
  factory: string | null;
  /** The flat Aretia fee, in wei, sent with the transaction. Equals the factory's `fee`. */
  feeWei: bigint;
  /** The exchange the pool opens on: its factory and the wrapped native coin, lower-case. Equal the factory's `dexFactory` and `wrapped`. */
  dexFactory: string;
  wrapped: string;
  /** The least coin, in wei, a launch must put in the pool. Equals the factory's `minLiquidity`. */
  minLiquidityWei: bigint;
}

/** The smallest share of the supply that must go into the locked pool, in basis points. Equals the factory's `MIN_POOL_BPS`. */
export const MIN_POOL_BPS = 7000;

export interface LaunchEvmChain {
  key: LaunchEvmChainKey;
  name: string;
  chainId: number;
  symbol: string;
  testnet: boolean;
  /** Aretia's flat creation fee, in wei. Must equal the `fee` the deployed factory was created with. */
  feeWei: bigint;
  /** The deployed AretiaTokenFactory, lower-case, or null until it is deployed and this table is updated. */
  factory: string | null;
  /** Where the fee goes: must equal the factory's `feeRecipient`. Lower-case, or null until set. */
  feeAddress: string | null;
  explorer: string;
  /** The locked-launch factory for this network. Absent on networks that have none. */
  launch?: LaunchSettings;
  /** What the wallet needs to add the network if it does not have it (testnets are often missing). */
  addParams?: { chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] };
}

/** "0.003" -> wei, by string arithmetic (no floating point). */
const coin = (amount: string): bigint => BigInt(toSmallestUnit(amount, 18) ?? '0');

/** Aretia's EVM fee address (the owner's), the same on every network. Lower-case. */
export const FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';

/**
 * Mainnet fees set by the owner: about $10 in each chain's coin. Change them here and in the factory deployment together. Testnet fees are
 * token amounts only. Every factory is null until it is deployed and checked, so every network stays off until then.
 */
export const LAUNCH_EVM_CHAINS: readonly LaunchEvmChain[] = [
  { key: 'bnb', name: 'BNB Chain', chainId: 56, symbol: 'BNB', testnet: false, feeWei: coin('0.014'), factory: '0xc3eb98c45795cffb10b61178332cc6fcbbc0385c', feeAddress: FEE_ADDRESS, explorer: 'https://bscscan.com', launch: { factory: null, feeWei: coin('0.028'), dexFactory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', minLiquidityWei: coin('0.07') } },
  { key: 'ethereum', name: 'Ethereum', chainId: 1, symbol: 'ETH', testnet: false, feeWei: coin('0.0042'), factory: '0x951a22270faa7d1c25efad2356c414cbddaba324', feeAddress: FEE_ADDRESS, explorer: 'https://etherscan.io', launch: { factory: null, feeWei: coin('0.0084'), dexFactory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', minLiquidityWei: coin('0.02') } },
  { key: 'polygon', name: 'Polygon', chainId: 137, symbol: 'POL', testnet: false, feeWei: coin('105'), factory: '0xca1aa427ba5906d00377a835dd9b36b049034f0c', feeAddress: FEE_ADDRESS, explorer: 'https://polygonscan.com', launch: { factory: null, feeWei: coin('210'), dexFactory: '0x5757371414417b8c6caad45baef941abc7d3ab32', wrapped: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', minLiquidityWei: coin('500') } },
  { key: 'bscTestnet', name: 'BNB Chain testnet (test)', chainId: 97, symbol: 'tBNB', testnet: true, feeWei: coin('0.0001'), factory: null, feeAddress: FEE_ADDRESS, explorer: 'https://testnet.bscscan.com', addParams: { chainName: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 }, rpcUrls: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545'], blockExplorerUrls: ['https://testnet.bscscan.com'] } },
  { key: 'sepolia', name: 'Ethereum Sepolia (test)', chainId: 11155111, symbol: 'ETH', testnet: true, feeWei: coin('0.0001'), factory: null, feeAddress: FEE_ADDRESS, explorer: 'https://sepolia.etherscan.io', addParams: { chainName: 'Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'] } },
  { key: 'polygonAmoy', name: 'Polygon Amoy (test)', chainId: 80002, symbol: 'POL', testnet: true, feeWei: coin('0.1'), factory: null, feeAddress: FEE_ADDRESS, explorer: 'https://amoy.polygonscan.com', addParams: { chainName: 'Polygon Amoy', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://rpc-amoy.polygon.technology'], blockExplorerUrls: ['https://amoy.polygonscan.com'] } },
];

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isEvmAddress = (a: string): boolean => ADDR.test(a);

/** True when the chain has both addresses set (lower-case) and a positive fee: the only state in which the page lets anyone create. */
export function chainEnabled(c: LaunchEvmChain): boolean {
  return c.factory !== null && c.feeAddress !== null && isEvmAddress(c.factory) && isEvmAddress(c.feeAddress) && c.factory === c.factory.toLowerCase() && c.feeAddress === c.feeAddress.toLowerCase() && c.feeWei > 0n;
}

/** True when the chain has a locked-launch factory set (lower-case) with a positive fee and minimum: the only state in which the page lets anyone create a token. */
export function launchEnabled(c: LaunchEvmChain, feeAddress: string | null = c.feeAddress): boolean {
  const l = c.launch;
  return (
    l !== undefined &&
    l.factory !== null &&
    feeAddress !== null &&
    isEvmAddress(l.factory) &&
    l.factory === l.factory.toLowerCase() &&
    isEvmAddress(feeAddress) &&
    feeAddress === feeAddress.toLowerCase() &&
    l.feeWei > 0n &&
    l.minLiquidityWei > 0n &&
    isEvmAddress(l.dexFactory) &&
    isEvmAddress(l.wrapped)
  );
}

export const chainByKey = (key: string, table: readonly LaunchEvmChain[] = LAUNCH_EVM_CHAINS): LaunchEvmChain | undefined => table.find((c) => c.key === key);

export const EVM_LIMITS = { nameMaxBytes: 32, symbolMaxBytes: 11, decimalsMax: 18, supplyMax: 2n ** 256n - 1n } as const;

export interface EvmLaunchForm {
  chain: LaunchEvmChainKey;
  name: string;
  symbol: string;
  decimals: string;
  /** A whole-token amount, commas allowed. */
  supply: string;
  /** The share of the supply that goes into the locked pool, a percentage such as "70" or "85.5". At least 70. */
  poolPct: string;
  /** The coin that goes into the locked pool with it, a decimal such as "0.5". At least the network's minimum. */
  poolCoin: string;
}

export const DEFAULT_EVM_FORM: EvmLaunchForm = { chain: 'bnb', name: '', symbol: '', decimals: '18', supply: '1,000,000,000', poolPct: '70', poolCoin: '' };

export interface EvmLaunchConfig {
  chain: LaunchEvmChain;
  /** Lower-case. */
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyRaw: bigint;
  /** The share of the supply that goes into the locked pool, in basis points (7000 to 10000). */
  poolBps: number;
  /** The coin that goes into the locked pool, in wei. */
  poolCoinWei: bigint;
}

/** The tokens that go into the pool: the same division the factory makes. */
export const poolTokensOf = (c: Pick<EvmLaunchConfig, 'totalSupplyRaw' | 'poolBps'>): bigint => (c.totalSupplyRaw * BigInt(c.poolBps)) / 10_000n;

/** The exact coin the transaction sends: the fee plus the coin for the pool. */
export const launchValueOf = (c: Pick<EvmLaunchConfig, 'chain' | 'poolCoinWei'>): bigint => (c.chain.launch?.feeWei ?? 0n) + c.poolCoinWei;

export interface EvmFieldIssue {
  field: keyof EvmLaunchForm | 'form';
  message: string;
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;
const hasControl = (s: string): boolean => [...s].some((c) => { const n = c.charCodeAt(0); return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029; });
const SYMBOL = /^[A-Za-z0-9]+$/;

export type EvmLaunchValidation = { ok: true; config: EvmLaunchConfig } | { ok: false; issues: EvmFieldIssue[] };

export function validateEvmLaunch(form: EvmLaunchForm, creator: string, table: readonly LaunchEvmChain[] = LAUNCH_EVM_CHAINS): EvmLaunchValidation {
  const issues: EvmFieldIssue[] = [];
  const add = (field: EvmFieldIssue['field'], message: string) => issues.push({ field, message });

  const chain = chainByKey(form.chain, table);
  if (!chain) add('chain', 'Choose a network.');
  else if (!launchEnabled(chain)) add('chain', `Creating a token with locked liquidity on ${chain.name} is not available yet.`);
  if (!isEvmAddress(creator)) add('form', 'Connect an Ethereum-style wallet first.');

  const name = form.name.trim();
  if (name === '' || utf8Length(name) > EVM_LIMITS.nameMaxBytes || hasControl(name)) add('name', `Required, at most ${EVM_LIMITS.nameMaxBytes} bytes (about that many letters), no line breaks.`);
  const symbol = form.symbol.trim();
  if (!SYMBOL.test(symbol) || symbol.length > EVM_LIMITS.symbolMaxBytes) add('symbol', `Letters and digits only, 1 to ${EVM_LIMITS.symbolMaxBytes} characters.`);

  let decimals = Number.NaN;
  if (/^\d{1,2}$/.test(form.decimals.trim())) decimals = Number(form.decimals.trim());
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > EVM_LIMITS.decimalsMax) add('decimals', `A whole number from 0 to ${EVM_LIMITS.decimalsMax}.`);

  let totalSupplyRaw = 0n;
  if (Number.isInteger(decimals) && decimals >= 0 && decimals <= EVM_LIMITS.decimalsMax) {
    const raw = toSmallestUnit(form.supply.replace(/,/g, '').trim(), decimals);
    if (raw === null || BigInt(raw) <= 0n) add('supply', 'A number above zero, with no more decimal places than the token has.');
    else {
      totalSupplyRaw = BigInt(raw);
      if (totalSupplyRaw > EVM_LIMITS.supplyMax) add('supply', 'Too large for a token.');
    }
  }

  // The share of the supply that goes into the locked pool, and the coin that goes in with it.
  let poolBps = 0;
  const pct = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(form.poolPct.trim());
  if (pct) poolBps = Number(pct[1]) * 100 + Number((pct[2] ?? '').padEnd(2, '0'));
  if (!pct || poolBps > 10_000 || poolBps < MIN_POOL_BPS) add('poolPct', `A percentage from ${MIN_POOL_BPS / 100} to 100. At least ${MIN_POOL_BPS / 100}% of the supply must go into the locked pool.`);
  else if (totalSupplyRaw > 0n && (totalSupplyRaw * BigInt(poolBps)) / 10_000n === 0n) add('poolPct', 'The supply is too small for that share to hold a whole unit.');
  let poolCoinWei = 0n;
  const coinText = form.poolCoin.trim().startsWith('.') ? `0${form.poolCoin.trim()}` : form.poolCoin.trim();
  const coinRaw = toSmallestUnit(coinText, 18);
  if (coinRaw === null || BigInt(coinRaw) <= 0n) add('poolCoin', 'A number above zero, such as 0.5.');
  else {
    poolCoinWei = BigInt(coinRaw);
    const min = chain?.launch?.minLiquidityWei;
    if (chain && min !== undefined && poolCoinWei < min) add('poolCoin', `At least ${fromSmallestUnit(min, 18)} ${chain.symbol}: a pool with less is too thin to protect anyone.`);
  }

  if (issues.length > 0 || !chain) return { ok: false, issues };
  return { ok: true, config: { chain, creator: creator.toLowerCase(), name, symbol, decimals, totalSupplyRaw, poolBps, poolCoinWei } };
}

export interface EvmDisclosure {
  severity: 'info' | 'caution';
  text: string;
}

/** Plain-language consequences, shown before signing. Never says a token is safe. */
export function evmDisclosuresOf(config: EvmLaunchConfig): EvmDisclosure[] {
  const share = `${config.poolBps / 100}%`;
  return [
    { severity: 'info', text: 'Nobody can ever create more of this token, pause it, freeze a holder or take a fee on transfers. The token contract has no owner and no such functions.' },
    { severity: 'info', text: `${share} of the supply and the coin you put in go into a trading pool in this same transaction, and the pool's liquidity is locked for good: nobody, including you and Aretia, can ever take it out. This is not a setting you can turn off.` },
    { severity: 'caution', text: `You keep the other ${(10_000 - config.poolBps) / 100}% of the supply in your wallet. Nothing locks it, and you could sell it at any time. Locked liquidity stops the pool being emptied; it does not stop selling.` },
    { severity: 'caution', text: 'Anyone can buy or sell against the pool as soon as it exists. The starting price is simply the coin divided by the tokens in the pool, and nothing checks it against any market. A price that is too low or too high can be traded away quickly.' },
    config.chain.testnet
      ? { severity: 'info', text: `This is a test network (${config.chain.name}). The coins used have no value, and the token is not real money.` }
      : { severity: 'caution', text: `This is on ${config.chain.name} mainnet. The transaction is real, the fee, the pool coin and network gas are paid in your ${config.chain.symbol}, and a created token or pool cannot be deleted or undone.` },
  ];
}
