/**
 * Transactions for Slipstream, the concentrated-liquidity pools of Aerodrome (Base) and Velodrome (Optimism). Pricing is
 * the V3 adapter's (evmV3.ts, which reads the venue's own quoter); this file builds the swap the Slipstream router
 * takes. Its calls differ from Uniswap's SwapRouter02: the deadline is a field of the call, pools are named by tick
 * spacing, and there is no wrapping multicall. Output cannot be the native coin here, as with V3.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { SwingsError } from '../core/types.js';
import { address, encodeBytes, encodeCall, selector, uint, word, wordToBigInt, words } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';
import { encodeV3Path, type V3SwapParams } from './evmV3.js';

const SIG = {
  exactSingle: 'exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))',
  exactPath: 'exactInput((bytes,address,uint256,uint256,uint256))',
} as const;

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/** `exactInputSingle` for one pool, `exactInput` for a two-pool path. `fees` are tick spacings. */
export function buildSlipstreamSwap(entry: DexEntry, p: V3SwapParams, nowSeconds: number = Math.floor(Date.now() / 1000)): EvmTxPlan {
  if (entry.mechanism !== 'evm-slipstream-router' || !entry.router || !entry.wrappedNative) throw new SwingsError('invalid', `${entry.id} cannot build Slipstream swaps.`);
  if (p.tokens.length < 2 || p.tokens.length > 3 || !p.tokens.every(isAddr)) throw new SwingsError('invalid', 'A route needs two or three valid token addresses.');
  if (p.fees.length !== p.tokens.length - 1) throw new SwingsError('invalid', 'A Slipstream route needs one tick spacing per hop.');
  for (let i = 1; i < p.tokens.length; i++) if (p.tokens[i]!.toLowerCase() === p.tokens[i - 1]!.toLowerCase()) throw new SwingsError('invalid', 'A route cannot swap a token for itself.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!isAddr(p.recipient)) throw new SwingsError('invalid', 'Invalid recipient.');
  if (p.deadline <= nowSeconds) throw new SwingsError('expired', 'The deadline has already passed.');
  if (p.nativeIn && p.tokens[0]!.toLowerCase() !== entry.wrappedNative.toLowerCase()) throw new SwingsError('invalid', 'A native-coin swap must start at the wrapped native token.');

  const tokens = p.tokens.map((t) => t.toLowerCase());
  const recipient = p.recipient.toLowerCase();
  const router = entry.router.toLowerCase();
  const data =
    tokens.length === 2
      ? encodeCall(SIG.exactSingle, [address(tokens[0]!), address(tokens[1]!), uint(BigInt(p.fees[0]!)), address(recipient), uint(BigInt(p.deadline)), uint(p.amountIn), uint(p.minOut), uint(0n)])
      : // A struct holding `bytes` is dynamic: one offset to the struct, its five head words, then the path.
        '0x' + selector(SIG.exactPath) + word('20') + word('a0') + word(recipient.slice(2)) + word(p.deadline.toString(16)) + word(p.amountIn.toString(16)) + word(p.minOut.toString(16)) + encodeBytes(encodeV3Path(tokens, p.fees));
  return {
    chain: entry.chain,
    to: router,
    data,
    value: p.nativeIn ? p.amountIn : 0n,
    approval: p.nativeIn ? null : { token: tokens[0]!, spender: router, amount: p.amountIn },
    summary: `${entry.name}: sell ${p.amountIn} (raw) of ${tokens[0]} for at least ${p.minOut} (raw) of ${tokens[tokens.length - 1]} through ${tokens.length - 1} pool${tokens.length === 2 ? '' : 's'} (tick spacing ${p.fees.join(', ')}), to ${recipient}.`,
  };
}

export interface SlipstreamSimulation {
  ok: boolean;
  amountOut: bigint | null;
  error: string | null;
}

/** Runs the exact transaction against the real router with `eth_call`; the router returns the amount it paid. */
export async function simulateSlipstreamSwap(read: EvmRead, plan: EvmTxPlan, from: string): Promise<SlipstreamSimulation> {
  try {
    const out = await read('eth_call', [{ from, to: plan.to, data: plan.data, value: '0x' + plan.value.toString(16) }, 'latest']);
    if (typeof out !== 'string') return { ok: false, amountOut: null, error: 'The node returned no result.' };
    const w = words(out);
    return { ok: true, amountOut: w[0] ? wordToBigInt(w[0]) : null, error: null };
  } catch (e) {
    return { ok: false, amountOut: null, error: e instanceof Error ? e.message.slice(0, 200) : 'The simulation failed.' };
  }
}
