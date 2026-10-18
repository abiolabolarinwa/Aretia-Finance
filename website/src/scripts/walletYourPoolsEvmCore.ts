/**
 * "Your pools" for Aretia Pool on Ethereum-style chains: which pools a wallet has a position in, what each has earned, and how to say so.
 * Pure: no network, no keys. Reading the chain is in walletYourPoolsEvmFlow.ts.
 *
 * A position is found from the pool contract's own event logs: the tokens of every pool the wallet opened or was handed (`Created` with
 * the wallet as owner, `PositionTransferred` with the wallet as the new owner) or deposited into (`LiquidityChanged`). Each token found is
 * then checked against the contract's current `positions`, because a position can have been handed on since. Aretia takes nothing when
 * fees are claimed: a claim is the contract's own `claimFees`, and 20% of each trading fee was already paid to Aretia at trade time.
 */
import { keccak256 } from '../swings/core/keccak.js';
import { amountText } from './walletYourPoolsCore';
import { lockTextOf, poolClaimable, type EvmPoolChain, type EvmPoolState, type EvmPosition } from './walletAretiaPoolEvmCore';

const enc = new TextEncoder();
const topicOf = (signature: string): string => '0x' + [...keccak256(enc.encode(signature))].map((x) => x.toString(16).padStart(2, '0')).join('');

export const POOL_EVENT_TOPICS = {
  created: topicOf('Created(address,address,address,uint256,uint256,uint256,uint256,bool)'),
  transferred: topicOf('PositionTransferred(address,address,address)'),
  liquidity: topicOf('LiquidityChanged(address,address,bool,uint256,uint256,uint256)'),
} as const;

const addrTopic = (a: string): string => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

/** The eth_getLogs filters (topics only) that find every token a wallet may have a position in. */
export function ownerLogFilters(owner: string): { name: keyof typeof POOL_EVENT_TOPICS; topics: (string | null)[] }[] {
  const me = addrTopic(owner);
  return [
    { name: 'created', topics: [POOL_EVENT_TOPICS.created, null, null, me] },
    { name: 'transferred', topics: [POOL_EVENT_TOPICS.transferred, null, null, me] },
    { name: 'liquidity', topics: [POOL_EVENT_TOPICS.liquidity, null, me] },
  ];
}

export interface RawLog {
  topics?: unknown;
}

/** The distinct token addresses named in a set of logs (topic 1 of each), lower-case. Anything malformed is ignored. */
export function tokensFromLogs(logs: readonly RawLog[]): string[] {
  const out = new Set<string>();
  for (const l of logs) {
    const t = Array.isArray(l.topics) ? l.topics[1] : undefined;
    if (typeof t === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(t)) out.add('0x' + t.slice(26).toLowerCase());
  }
  return [...out];
}

export interface EvmPoolRow {
  chain: EvmPoolChain;
  token: string;
  symbol: string;
  decimals: number;
  pool: EvmPoolState;
  position: EvmPosition;
  /** Fees the position could claim now, wei. */
  claimable: bigint;
}

export const rowHasClaimable = (r: EvmPoolRow): boolean => r.claimable > 0n;
export const rowName = (r: EvmPoolRow): string => `${r.symbol} / ${r.chain.symbol}`;
export const rowLockText = (r: EvmPoolRow): string => lockTextOf(r.position);
export const rowClaimText = (r: EvmPoolRow): string => (r.claimable > 0n ? `${amountText(r.claimable, 18)} ${r.chain.symbol}` : 'Nothing to claim yet');

export function rowFrom(chain: EvmPoolChain, token: string, meta: { symbol: string; decimals: number }, pool: EvmPoolState, position: EvmPosition): EvmPoolRow {
  return { chain, token, symbol: meta.symbol, decimals: meta.decimals, pool, position, claimable: poolClaimable(pool, position) };
}

/** Pools with something to claim first, then by name. */
export const sortRows = (rows: readonly EvmPoolRow[]): EvmPoolRow[] => [...rows].sort((a, b) => Number(rowHasClaimable(b)) - Number(rowHasClaimable(a)) || rowName(a).localeCompare(rowName(b)));
