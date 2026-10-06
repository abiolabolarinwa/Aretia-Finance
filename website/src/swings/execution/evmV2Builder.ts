/**
 * Aretia-built transactions for Uniswap-V2-style routers. The output is a plain, inspectable request
 * (target, calldata, value, and any approval needed): nothing is signed or sent here, and nothing is
 * outsourced to an aggregator. `inspectV2Swap` turns the calldata back into words, so what the user is
 * asked to sign can be checked against what was quoted.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { SwingsError } from '../core/types.js';
import { addressArray, address, decodeAddressArrayCall, decodeUintArray, encodeCall, selector, uint } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';

const SIGS = {
  tokensForTokens: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  ethForTokens: 'swapExactETHForTokens(uint256,address[],address,uint256)',
  tokensForEth: 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  tokensForTokensFee: 'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  ethForTokensFee: 'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)',
  tokensForEthFee: 'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
} as const;

export interface V2SwapParams {
  /** Token addresses along the route, lower-case. The wrapped native token stands in for the native coin. */
  path: string[];
  amountIn: bigint;
  /** The least the user accepts. Required: a swap with no floor is refused. */
  minOut: bigint;
  recipient: string;
  /** Unix seconds after which the router refuses the swap. */
  deadline: number;
  nativeIn?: boolean;
  nativeOut?: boolean;
  /** Use the router variants that tolerate tokens taking a fee on transfer. */
  feeOnTransfer?: boolean;
}

export interface EvmTxPlan {
  chain: DexEntry['chain'];
  to: string;
  data: string;
  /** Wei to attach (only when selling the native coin). */
  value: bigint;
  /** Present when the router must be approved to spend the sold token first. */
  approval: { token: string; spender: string; amount: bigint } | null;
  /** One-line, plain-language statement of what this transaction does. */
  summary: string;
}

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export function buildV2Swap(entry: DexEntry, p: V2SwapParams, nowSeconds: number = Math.floor(Date.now() / 1000)): EvmTxPlan {
  if (entry.mechanism !== 'evm-v2-router' || !entry.router || !entry.wrappedNative) throw new SwingsError('invalid', `${entry.id} cannot build V2 swaps.`);
  if (p.path.length < 2 || p.path.length > 4 || !p.path.every(isAddr)) throw new SwingsError('invalid', 'A route needs two to four valid token addresses.');
  for (let i = 1; i < p.path.length; i++) if (p.path[i]!.toLowerCase() === p.path[i - 1]!.toLowerCase()) throw new SwingsError('invalid', 'A route cannot swap a token for itself.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!isAddr(p.recipient)) throw new SwingsError('invalid', 'Invalid recipient.');
  if (p.deadline <= nowSeconds) throw new SwingsError('expired', 'The deadline has already passed.');
  if (p.nativeIn && p.nativeOut) throw new SwingsError('invalid', 'A swap cannot start and end in the native coin.');
  const wrapped = entry.wrappedNative.toLowerCase();
  if (p.nativeIn && p.path[0]!.toLowerCase() !== wrapped) throw new SwingsError('invalid', 'A native-coin swap must start at the wrapped native token.');
  if (p.nativeOut && p.path[p.path.length - 1]!.toLowerCase() !== wrapped) throw new SwingsError('invalid', 'A swap into the native coin must end at the wrapped native token.');

  const fee = p.feeOnTransfer === true;
  const path = addressArray(p.path.map((a) => a.toLowerCase()));
  const to = address(p.recipient.toLowerCase());
  let data: string;
  let value = 0n;
  if (p.nativeIn) {
    data = encodeCall(fee ? SIGS.ethForTokensFee : SIGS.ethForTokens, [uint(p.minOut), path, to, uint(BigInt(p.deadline))]);
    value = p.amountIn;
  } else if (p.nativeOut) data = encodeCall(fee ? SIGS.tokensForEthFee : SIGS.tokensForEth, [uint(p.amountIn), uint(p.minOut), path, to, uint(BigInt(p.deadline))]);
  else data = encodeCall(fee ? SIGS.tokensForTokensFee : SIGS.tokensForTokens, [uint(p.amountIn), uint(p.minOut), path, to, uint(BigInt(p.deadline))]);

  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data,
    value,
    approval: p.nativeIn ? null : { token: p.path[0]!.toLowerCase(), spender: entry.router.toLowerCase(), amount: p.amountIn },
    summary: `${entry.name}: sell ${p.amountIn} (raw) of ${p.path[0]} for at least ${p.minOut} (raw) of ${p.path[p.path.length - 1]} via ${p.path.length - 1} pool${p.path.length === 2 ? '' : 's'}, to ${p.recipient}.`,
  };
}

export interface InspectedSwap {
  function: string;
  amountIn: bigint | null;
  minOut: bigint;
  path: string[];
  recipient: string;
  deadline: number;
}

/** Reads a V2 router swap's calldata back into its parts. Returns null for anything that is not one of the swap calls. */
export function inspectV2Swap(data: string): InspectedSwap | null {
  const sel = data.slice(2, 10).toLowerCase();
  const names = Object.values(SIGS);
  const sig = names.find((s) => selector(s) === sel);
  if (!sig) return null;
  const ethIn = sig.includes('swapExactETHForTokens');
  const staticCount = ethIn ? 4 : 5;
  const arrayIndex = ethIn ? 1 : 2;
  const { statics, path } = decodeAddressArrayCall(data, staticCount, arrayIndex);
  const at = (i: number): bigint => BigInt(statics[i] as bigint);
  return ethIn
    ? { function: sig.split('(')[0]!, amountIn: null, minOut: at(0), path, recipient: '0x' + at(2).toString(16).padStart(40, '0'), deadline: Number(at(3)) }
    : { function: sig.split('(')[0]!, amountIn: at(0), minOut: at(1), path, recipient: '0x' + at(3).toString(16).padStart(40, '0'), deadline: Number(at(4)) };
}

export interface SimulationResult {
  ok: boolean;
  /** The router's own per-hop amounts when the call succeeds (`getAmountsOut`-shaped). */
  amounts: bigint[] | null;
  error: string | null;
}

/**
 * Asks the venue's router what this exact transaction would do, with `eth_call` from the user's address and no
 * signature. A failure here (bad path, slippage, missing allowance, no balance) means the user must not be asked to sign.
 * `balanceFloor` temporarily gives the sender balance (a node state override) so a read-only check can run for any address.
 */
export async function simulateV2Swap(read: EvmRead, plan: EvmTxPlan, from: string, options: { balanceOverride?: bigint } = {}): Promise<SimulationResult> {
  const call = { from, to: plan.to, data: plan.data, value: '0x' + plan.value.toString(16) };
  try {
    const params: unknown[] = [call, 'latest'];
    if (options.balanceOverride !== undefined) params.push({ [from]: { balance: '0x' + options.balanceOverride.toString(16) } });
    const out = await read('eth_call', params);
    if (typeof out !== 'string') return { ok: false, amounts: null, error: 'The node returned no result.' };
    // The router returns the amounts array (a view of what each hop produced).
    return { ok: true, amounts: decodeUintArray(out), error: null };
  } catch (e) {
    return { ok: false, amounts: null, error: e instanceof Error ? e.message.slice(0, 200) : 'The simulation failed.' };
  }
}
