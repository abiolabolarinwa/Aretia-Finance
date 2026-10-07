/**
 * Direct integration with Balancer V2: one Vault holds every pool. Quotes come from the Vault's own
 * `queryBatchSwap` (exact for weighted, stable and Gyro pools alike, fees included); Aretia builds the
 * `batchSwap` transaction itself. No aggregator is involved.
 *
 * The Vault has no "pools for this pair" lookup, so Aretia routes through a curated list of pool ids per chain
 * (registry `knownPools`). Each id is checked on-chain (`getPoolTokens`) before it is used, and a pool whose
 * tokens do not match what was expected is ignored.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { decodeParams, encodeFunction } from '../engine/abiGeneric.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

/** Balancer's stand-in address for the chain's native coin inside the Vault. */
export const BALANCER_NATIVE = '0x' + '0'.repeat(40);

const SWAP_STEP = '(bytes32,uint256,uint256,uint256,bytes)';
const FUNDS = '(address,bool,address,bool)';
const SIG = {
  getPoolTokens: 'getPoolTokens(bytes32)',
  query: `queryBatchSwap(uint8,${SWAP_STEP}[],address[],${FUNDS})`,
  batchSwap: `batchSwap(uint8,${SWAP_STEP}[],address[],${FUNDS},int256[],uint256)`,
} as const;
const GIVEN_IN = 0;

export interface BalancerStep {
  poolId: string;
  /** Index into `assets`. */
  assetIn: number;
  assetOut: number;
}

export interface BalancerRoute {
  steps: BalancerStep[];
  assets: string[];
  amountOut: bigint;
}

const isPoolId = (s: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(s);

function swapsFor(steps: BalancerStep[], amountIn: bigint): unknown[][] {
  // Only the first step carries an amount; later steps take whatever the previous one produced (amount 0 = "all of it").
  return steps.map((s, i) => [s.poolId, BigInt(s.assetIn), BigInt(s.assetOut), i === 0 ? amountIn : 0n, '0x']);
}

const funds = (user: string): unknown[] => [user, false, user, false];

export class EvmBalancerAdapter {
  private readonly tokensCache = new Map<string, string[] | null>();

  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if (entry.mechanism !== 'evm-balancer-vault' || !entry.router) throw new SwingsError('invalid', `${entry.id} is not a complete Balancer entry.`);
  }

  private async call(data: string, block?: bigint): Promise<string> {
    const out = await this.read('eth_call', [{ to: this.entry.router, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return out;
  }

  /** The tokens a pool holds, asked of the Vault. Null when the Vault does not know the pool id. */
  async poolTokens(poolId: string): Promise<string[] | null> {
    if (!isPoolId(poolId)) return null;
    const key = poolId.toLowerCase();
    if (this.tokensCache.has(key)) return this.tokensCache.get(key)!;
    let tokens: string[] | null;
    try {
      const [list] = decodeParams(['address[]', 'uint256[]', 'uint256'], await this.call(encodeFunction(SIG.getPoolTokens, [poolId]))) as [string[]];
      tokens = list.length > 0 ? list.map((t) => t.toLowerCase()) : null;
    } catch {
      tokens = null;
    }
    this.tokensCache.set(key, tokens);
    return tokens;
  }

  /** What the Vault itself says this route pays, or null if it cannot fill the trade. */
  async quote(steps: BalancerStep[], assets: string[], amountIn: bigint, block?: bigint): Promise<bigint | null> {
    try {
      const dummy = '0x' + '1'.repeat(40);
      const data = encodeFunction(SIG.query, [GIVEN_IN, swapsFor(steps, amountIn), assets, funds(dummy)]);
      const [deltas] = decodeParams(['int256[]'], await this.call(data, block)) as [bigint[]];
      const out = deltas[steps[steps.length - 1]!.assetOut];
      return out !== undefined && out < 0n ? -out : null;
    } catch {
      return null;
    }
  }

  /** The best one- or two-hop route through the known pools, by output. */
  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<BalancerRoute | null> {
    const chain = this.entry.chain;
    const a = normalizeTokenRef(chain, tokenIn);
    const b = normalizeTokenRef(chain, tokenOut);
    if (!a || !b || a.address === b.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    const pools: { id: string; tokens: string[] }[] = [];
    for (const id of this.entry.knownPools ?? []) {
      const tokens = await this.poolTokens(id);
      if (tokens) pools.push({ id, tokens });
    }
    const has = (p: { tokens: string[] }, t: string): boolean => p.tokens.includes(t);
    const candidates: { steps: BalancerStep[]; assets: string[] }[] = [];
    for (const p of pools) if (has(p, a.address) && has(p, b.address)) candidates.push({ steps: [{ poolId: p.id, assetIn: 0, assetOut: 1 }], assets: [a.address, b.address] });
    for (const p1 of pools) {
      if (!has(p1, a.address)) continue;
      for (const mid of p1.tokens) {
        if (mid === a.address || mid === b.address) continue;
        for (const p2 of pools) {
          if (p2.id === p1.id || !has(p2, mid) || !has(p2, b.address)) continue;
          candidates.push({ steps: [{ poolId: p1.id, assetIn: 0, assetOut: 1 }, { poolId: p2.id, assetIn: 1, assetOut: 2 }], assets: [a.address, mid, b.address] });
        }
      }
    }
    const quoted = await Promise.all(candidates.slice(0, 24).map(async (c) => ({ ...c, amountOut: await this.quote(c.steps, c.assets, amountIn, block) })));
    const found = quoted.filter((q): q is BalancerRoute => q.amountOut !== null && q.amountOut > 0n);
    return found.sort((x, y) => (x.amountOut !== y.amountOut ? (x.amountOut > y.amountOut ? -1 : 1) : x.steps.length - y.steps.length))[0] ?? null;
  }
}

export interface BalancerSwapParams {
  steps: BalancerStep[];
  /** Token addresses, in the order `steps` index them. The wrapped native token is replaced by the Vault's native sentinel when `nativeIn` / `nativeOut`. */
  assets: string[];
  amountIn: bigint;
  minOut: bigint;
  recipient: string;
  deadline: number;
  nativeIn?: boolean;
  nativeOut?: boolean;
}

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export function buildBalancerSwap(entry: DexEntry, p: BalancerSwapParams, nowSeconds: number = Math.floor(Date.now() / 1000)): EvmTxPlan {
  if (entry.mechanism !== 'evm-balancer-vault' || !entry.router || !entry.wrappedNative) throw new SwingsError('invalid', `${entry.id} cannot build Balancer swaps.`);
  if (p.steps.length < 1 || p.steps.length > 3) throw new SwingsError('invalid', 'A route needs one to three steps.');
  if (p.assets.length < 2 || !p.assets.every(isAddr)) throw new SwingsError('invalid', 'Invalid asset list.');
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i]!;
    if (!isPoolId(s.poolId)) throw new SwingsError('invalid', 'A step has an invalid pool id.');
    if (!Number.isInteger(s.assetIn) || !Number.isInteger(s.assetOut) || s.assetIn < 0 || s.assetOut < 0 || s.assetIn >= p.assets.length || s.assetOut >= p.assets.length || s.assetIn === s.assetOut) throw new SwingsError('invalid', 'A step points at an invalid asset.');
    if (i > 0 && p.steps[i - 1]!.assetOut !== s.assetIn) throw new SwingsError('invalid', 'The steps do not connect.');
  }
  if (p.steps[0]!.assetIn !== 0) throw new SwingsError('invalid', 'The route must start from the first asset.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!isAddr(p.recipient)) throw new SwingsError('invalid', 'Invalid recipient.');
  if (p.deadline <= nowSeconds) throw new SwingsError('expired', 'The deadline has already passed.');
  if (p.nativeIn && p.nativeOut) throw new SwingsError('invalid', 'A swap cannot start and end in the native coin.');
  const wrapped = entry.wrappedNative.toLowerCase();
  const lastAsset = p.steps[p.steps.length - 1]!.assetOut;
  if (p.nativeIn && p.assets[0]!.toLowerCase() !== wrapped) throw new SwingsError('invalid', 'A native-coin swap must start at the wrapped native token.');
  if (p.nativeOut && p.assets[lastAsset]!.toLowerCase() !== wrapped) throw new SwingsError('invalid', 'A swap into the native coin must end at the wrapped native token.');

  const assets = p.assets.map((a) => a.toLowerCase());
  const sentinel = (i: number): string => ((i === 0 && p.nativeIn) || (i === lastAsset && p.nativeOut) ? BALANCER_NATIVE : assets[i]!);
  const sent = assets.map((_, i) => sentinel(i));
  // Limits: what the Vault may take (positive) and the least it must give (negative). Intermediate assets must net to zero.
  const limits = assets.map((_, i) => (i === 0 ? p.amountIn : i === lastAsset ? -p.minOut : 0n));
  const recipient = p.recipient.toLowerCase();
  const data = encodeFunction(SIG.batchSwap, [GIVEN_IN, swapsFor(p.steps, p.amountIn), sent, [recipient, false, recipient, false], limits, BigInt(p.deadline)]);
  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data,
    value: p.nativeIn ? p.amountIn : 0n,
    approval: p.nativeIn ? null : { token: assets[0]!, spender: entry.router.toLowerCase(), amount: p.amountIn },
    summary: `${entry.name}: sell ${p.amountIn} (raw) of ${assets[0]} for at least ${p.minOut} (raw) of ${assets[lastAsset]} through ${p.steps.length} pool${p.steps.length === 1 ? '' : 's'}, to ${recipient}.`,
  };
}

export interface InspectedBalancerSwap {
  steps: { poolId: string; assetIn: number; assetOut: number; amount: bigint }[];
  assets: string[];
  recipient: string;
  limits: bigint[];
  deadline: number;
}

/** Reads a `batchSwap` call back into its parts. Null for any other call. */
export function inspectBalancerSwap(data: string): InspectedBalancerSwap | null {
  try {
    const prefix = encodeFunction('batchSwap(uint8,(bytes32,uint256,uint256,uint256,bytes)[],address[],(address,bool,address,bool),int256[],uint256)', [0, [], [], ['0x' + '0'.repeat(40), false, '0x' + '0'.repeat(40), false], [], 0n]).slice(0, 10);
    if (data.slice(0, 10).toLowerCase() !== prefix) return null;
    const [, swaps, assets, fundsTuple, limits, deadline] = decodeParams(['uint8', `${SWAP_STEP}[]`, 'address[]', FUNDS, 'int256[]', 'uint256'], '0x' + data.slice(10)) as [bigint, unknown[][], string[], unknown[], bigint[], bigint];
    return {
      steps: swaps.map((s) => ({ poolId: s[0] as string, assetIn: Number(s[1]), assetOut: Number(s[2]), amount: s[3] as bigint })),
      assets,
      recipient: fundsTuple[2] as string,
      limits,
      deadline: Number(deadline),
    };
  } catch {
    return null;
  }
}

export interface BalancerSimulation {
  ok: boolean;
  amountOut: bigint | null;
  error: string | null;
}

/** Runs the exact transaction against the real Vault with `eth_call`; the amount out is read from the returned deltas. */
export async function simulateBalancerSwap(read: EvmRead, plan: EvmTxPlan, from: string, outIndex: number, options: { balanceOverride?: bigint } = {}): Promise<BalancerSimulation> {
  try {
    const params: unknown[] = [{ from, to: plan.to, data: plan.data, value: '0x' + plan.value.toString(16) }, 'latest'];
    if (options.balanceOverride !== undefined) params.push({ [from]: { balance: '0x' + options.balanceOverride.toString(16) } });
    const out = await read('eth_call', params);
    if (typeof out !== 'string') return { ok: false, amountOut: null, error: 'The node returned no result.' };
    const [deltas] = decodeParams(['int256[]'], out) as [bigint[]];
    const d = deltas[outIndex];
    return { ok: true, amountOut: d !== undefined && d < 0n ? -d : null, error: null };
  } catch (e) {
    return { ok: false, amountOut: null, error: e instanceof Error ? e.message.slice(0, 200) : 'The simulation failed.' };
  }
}

