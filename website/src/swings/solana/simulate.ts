/**
 * Simulation for Aretia-built Solana swaps. The transaction is run against the real programs on the RPC with
 * the user's accounts watched, and judged by what it would do to those balances (the same judge the Trade tab
 * uses), not by anything the builder says it will do.
 */
import type * as Web3 from '@solana/web3.js';
import { judgeSwapSimulation, parseTokenAccount, SWAP_SOL_OVERHEAD_LAMPORTS, type SwapSimulation, type SwapVerdict } from '../../scripts/walletTools.js';
import type { SolRpc } from './raydiumCpmm.js';

interface SimAccount {
  lamports: number;
  data: [string, string];
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface SolanaSimArgs {
  user: string;
  /** The user's token accounts for the swap; null for native SOL on that side. */
  inAccount: string | null;
  outAccount: string | null;
  inputIsSol: boolean;
  outputIsSol: boolean;
  amountIn: bigint;
  minOut: bigint;
  /** Extra SOL the swap may legitimately use (rent for a new token account, wrapping). */
  overheadLamports?: bigint;
}

export interface SolanaSimResult {
  verdict: SwapVerdict;
  blockers: string[];
  /** The program logs, for debugging; never shown to the user as a promise. */
  logs: string[];
  opensOutputAccount: boolean;
  unitsConsumed: number | null;
}

export async function simulateSolanaSwap(rpc: SolRpc, tx: Web3.VersionedTransaction, a: SolanaSimArgs): Promise<SolanaSimResult> {
  const addresses = [a.user, ...(a.inAccount && !a.inputIsSol ? [a.inAccount] : []), ...(a.outAccount && !a.outputIsSol ? [a.outAccount] : [])];
  // Wrapped SOL accounts are watched too, but the SOL judge reads the wallet's lamports.
  const wire = btoa(String.fromCharCode(...tx.serialize()));
  const [pre, sim] = await Promise.all([
    rpc<{ value: (SimAccount | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]),
    rpc<{ value: { err: unknown; logs: string[] | null; accounts: (SimAccount | null)[] | null; unitsConsumed?: number } }>('simulateTransaction', [
      wire,
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } },
    ]),
  ]);
  const post = sim.value.accounts ?? [];
  const amount = (acc: SimAccount | null | undefined): bigint | null => (acc ? (parseTokenAccount(fromBase64(acc.data[0]))?.amount ?? 0n) : null);
  const inIdx = a.inAccount && !a.inputIsSol ? 1 : -1;
  const outIdx = a.outAccount && !a.outputIsSol ? (inIdx >= 0 ? 2 : 1) : -1;
  const failure = sim.value.err === null ? null : ((sim.value.logs ?? []).filter((l) => /failed|error|insufficient|slippage|exceeded/i.test(l)).pop() ?? JSON.stringify(sim.value.err));
  const state: SwapSimulation = {
    solPre: BigInt(pre.value[0]?.lamports ?? 0),
    solPost: BigInt(post[0]?.lamports ?? pre.value[0]?.lamports ?? 0),
    inPre: inIdx >= 0 ? amount(pre.value[inIdx]) : null,
    inPost: inIdx >= 0 ? (amount(post[inIdx]) ?? 0n) : null,
    outPre: outIdx >= 0 ? (amount(pre.value[outIdx]) ?? 0n) : null,
    outPost: outIdx >= 0 ? amount(post[outIdx]) : null,
    others: [],
    error: failure,
  };
  const verdict = judgeSwapSimulation({ inputIsSol: a.inputIsSol, outputIsSol: a.outputIsSol, amountIn: a.amountIn, minOut: a.minOut, sim: state, overheadLamports: a.overheadLamports ?? SWAP_SOL_OVERHEAD_LAMPORTS });
  return { verdict, blockers: verdict.problems, logs: sim.value.logs ?? [], opensOutputAccount: outIdx >= 0 && amount(pre.value[outIdx]) === null, unitsConsumed: sim.value.unitsConsumed ?? null };
}
