/**
 * Swaps for the web wallet, using Jupiter's Swap API behind our own screen.
 *
 * Jupiter quotes the route and supplies the swap instructions; this page adds Aretia's 1% fee as one
 * extra transfer and assembles the transaction itself. Because the swap instructions come from a third
 * party, nothing is signed on trust: the page decodes it, checks the fee payer, simulates it on our
 * RPC with the wallet's own balances watched, and judges the swap by what it would do to those
 * balances (see judgeSwapSimulation). Only then does it ask the connected wallet to sign, checks the
 * wallet returned the same transaction, and submits it through the RPC proxy. Keys never leave the
 * wallet.
 *
 * Data leaving the page: the token pair, amount and wallet address go to Jupiter (quote and swap
 * build) and to Aretia's RPC proxy.
 */
import type * as Web3 from '@solana/web3.js';
import { fetchAccount, loadWeb3, rpcCall } from './walletSend';
import {
  ataAddress,
  createAtaIdempotentInstruction,
  judgeSwapSimulation,
  MIN_NEW_ACCOUNT_LAMPORTS,
  parseTokenAccount,
  sizeImpact,
  solTransferInstruction,
  splitSwapFee,
  SWAP_FEE_ACCOUNT_RENT_LAMPORTS,
  SWAP_FEE_WALLET,
  SWAP_SOL_OVERHEAD_LAMPORTS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  transferCheckedInstruction,
  type SwapSimulation,
  type SwapVerdict,
} from './walletTools';

const JUPITER_API = 'https://lite-api.jup.ag';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Most the swap may pay in priority fee, in lamports (0.0005 SOL). */
const MAX_PRIORITY_LAMPORTS = 500_000;
/** Accounts watched in one simulation. */
const MAX_WATCHED = 100;

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  icon: string | null;
  /** Jupiter's verified flag; null when unknown (for example a token read from the wallet). */
  verified: boolean | null;
}

// ---------------------------------------------------------------- Jupiter API

class JupiterError extends Error {}

async function jupJson<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${JUPITER_API}${path}`, { ...init, signal: controller.signal });
      const body = (await res.json().catch(() => null)) as { error?: string; errorCode?: string } | null;
      if (res.ok) return body as T;
      if (res.status === 400 || res.status === 404) {
        // A real answer ("no route", "bad amount"): retrying will not change it.
        const code = body?.errorCode ?? '';
        throw new JupiterError(code === 'COULD_NOT_FIND_ANY_ROUTE' || /route/i.test(body?.error ?? '') ? 'Jupiter found no route for this pair and amount.' : (body?.error ?? 'Jupiter could not quote this swap.'));
      }
      lastError = new Error(`Jupiter answered ${res.status}`);
    } catch (e) {
      if (e instanceof JupiterError) throw e;
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error && lastError.name !== 'AbortError' ? lastError : new Error('Jupiter did not answer in time. Try again in a moment.');
}

interface JupQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
}

export interface Quote {
  raw: JupQuote;
  inAmount: bigint;
  outAmount: bigint;
  /** The least the swap will accept; below this the on-chain program rejects it. */
  minOut: bigint;
  slippageBps: number;
  routes: string[];
}

export async function fetchQuote(inMint: string, outMint: string, amountRaw: bigint, slippageBps: number): Promise<Quote> {
  const q = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: amountRaw.toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: 'true', maxAccounts: '54' });
  const raw = await jupJson<JupQuote>(`/swap/v1/quote?${q}`);
  return {
    raw,
    inAmount: BigInt(raw.inAmount),
    outAmount: BigInt(raw.outAmount),
    minOut: BigInt(raw.otherAmountThreshold),
    slippageBps: raw.slippageBps,
    routes: [...new Set((raw.routePlan ?? []).map((r) => r.swapInfo?.label).filter((l): l is string => typeof l === 'string'))],
  };
}

/** How much your own trade size moves the price, from the full quote and one 1/100th its size. */
export async function fetchSizeImpact(inMint: string, outMint: string, full: Quote): Promise<number | null> {
  const small = full.inAmount / 100n;
  if (small < 1n) return null;
  try {
    const q = await fetchQuote(inMint, outMint, small, full.slippageBps);
    return sizeImpact(full.inAmount, full.outAmount, q.inAmount, q.outAmount);
  } catch {
    return null;
  }
}

interface JupToken {
  id: string;
  symbol?: string;
  name?: string;
  icon?: string;
  decimals?: number;
  isVerified?: boolean;
}

const safeIcon = (url: unknown): string | null => (typeof url === 'string' && url.startsWith('https://') ? url : null);

/** Token search by name, symbol or mint. Names and symbols are untrusted text; callers must render them as text. */
export async function searchTokens(query: string): Promise<TokenInfo[]> {
  const tokens = await jupJson<JupToken[]>(`/tokens/v2/search?query=${encodeURIComponent(query.trim())}`);
  return tokens
    .filter((t) => typeof t.id === 'string' && typeof t.decimals === 'number')
    .slice(0, 20)
    .map((t) => ({ mint: t.id, symbol: (t.symbol ?? '').slice(0, 20) || t.id.slice(0, 4), name: (t.name ?? '').slice(0, 60), decimals: t.decimals!, icon: safeIcon(t.icon), verified: t.isVerified ?? false }));
}

// ---------------------------------------------------------------- planning

export interface SwapPlan {
  quote: Quote;
  transaction: Web3.VersionedTransaction;
  verdict: SwapVerdict;
  /** Problems that stop the swap: bad transaction shape or a failed simulation check. */
  blockers: string[];
  priorityFeeLamports: number;
  /** Aretia's fee, in the token being sold (raw units). Zero for dust amounts. */
  feeRaw: bigint;
  /** The fee goes to an account that does not exist yet for this token, so the swap opens it (paid by the user). */
  opensFeeAccount: boolean;
  /** The simulation shows the swap opening a token account for the token you are buying. */
  opensOutputAccount: boolean;
  plannedAt: number;
}

interface JupInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}
interface JupSwapInstructions {
  computeBudgetInstructions?: JupInstruction[];
  setupInstructions?: JupInstruction[];
  swapInstruction?: JupInstruction;
  cleanupInstruction?: JupInstruction | null;
  otherInstructions?: JupInstruction[];
  addressLookupTableAddresses?: string[];
  prioritizationFeeLamports?: number;
}

export interface PlanArgs {
  user: string;
  from: TokenInfo;
  to: TokenInfo;
  amountRaw: bigint;
  slippageBps: number;
  /** Other tokens in the wallet, watched so the swap cannot quietly reduce them. */
  heldOthers: { mint: string; symbol: string }[];
  quote?: Quote;
  /** Overrides the Trade tab's fee rate. Aretia Swings passes 0n: it carries no 1% fee (see swings/core/fee.ts). */
  feeBps?: bigint;
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

interface SimAccount {
  lamports: number;
  data: [string, string];
}

/** Everything checked before the wallet is asked to sign. Throws only when a service cannot be reached. */
export async function planSwap(args: PlanArgs): Promise<SwapPlan> {
  const web3 = await loadWeb3();
  // Aretia's fee comes off what the user sells; Jupiter swaps the rest.
  const { fee, net } = splitSwapFee(args.amountRaw, args.feeBps);
  const quote = args.quote ?? (await fetchQuote(args.from.mint, args.to.mint, net, args.slippageBps));
  const built = await jupJson<JupSwapInstructions>('/swap/v1/swap-instructions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: args.user,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: MAX_PRIORITY_LAMPORTS, priorityLevel: 'medium' } },
    }),
  });
  if (!built.swapInstruction) throw new Error('Jupiter did not return a swap for this pair.');

  const blockers: string[] = [];

  // Accounts to watch: the wallet's SOL, the two token accounts in the swap, and every other token it holds.
  const inIsSol = args.from.mint === SOL_MINT;
  const outIsSol = args.to.mint === SOL_MINT;
  const ataFor = async (mint: string): Promise<{ ata: string; program: string } | null> => {
    const mintAccount = await fetchAccount(mint);
    if (!mintAccount || (mintAccount.owner !== TOKEN_PROGRAM_ID && mintAccount.owner !== TOKEN_2022_PROGRAM_ID)) return null;
    return { ata: ataAddress(web3, args.user, mint, mintAccount.owner), program: mintAccount.owner };
  };
  const [inInfo, outInfo] = await Promise.all([inIsSol ? null : ataFor(args.from.mint), outIsSol ? null : ataFor(args.to.mint)]);
  const inAta = inInfo?.ata ?? null;
  const outAta = outInfo?.ata ?? null;
  if (!inIsSol && !inAta) blockers.push(`${args.from.symbol} could not be read as a token.`);
  if (!outIsSol && !outAta) blockers.push(`${args.to.symbol} could not be read as a token.`);

  // Aretia's fee: one transfer, in the token being sold, to the fee wallet. For a token this also opens the
  // fee wallet's account the first time (rent paid by the user, shown in the review).
  const feeInstructions: Web3.TransactionInstruction[] = [];
  let feeRaw = fee;
  let opensFeeAccount = false;
  if (fee > 0n) {
    if (inIsSol) {
      // A brand-new system account must end up with the rent minimum, or the network rejects the transfer.
      const feeWallet = await fetchAccount(SWAP_FEE_WALLET);
      if (BigInt(feeWallet?.lamports ?? 0) + fee < MIN_NEW_ACCOUNT_LAMPORTS) feeRaw = 0n;
      else feeInstructions.push(solTransferInstruction(web3, args.user, SWAP_FEE_WALLET, fee));
    } else if (inInfo && inAta) {
      const feeAta = ataAddress(web3, SWAP_FEE_WALLET, args.from.mint, inInfo.program);
      opensFeeAccount = (await fetchAccount(feeAta)) === null;
      if (opensFeeAccount) feeInstructions.push(createAtaIdempotentInstruction(web3, args.user, feeAta, SWAP_FEE_WALLET, args.from.mint, inInfo.program));
      feeInstructions.push(transferCheckedInstruction(web3, inInfo.program, inAta, args.from.mint, feeAta, args.user, fee, args.from.decimals));
    }
  }

  // Assemble the transaction: Jupiter's setup, then the fee, then the swap and clean-up.
  const toInstruction = (i: JupInstruction): Web3.TransactionInstruction =>
    new web3.TransactionInstruction({
      programId: new web3.PublicKey(i.programId),
      keys: i.accounts.map((a) => ({ pubkey: new web3.PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: bytesFromBase64(i.data) as unknown as Buffer,
    });
  const tableAddresses = built.addressLookupTableAddresses ?? [];
  const [tableAccounts, blockhashResult] = await Promise.all([
    tableAddresses.length ? rpcCall<{ value: ({ data: [string, string] } | null)[] }>('getMultipleAccounts', [tableAddresses, { encoding: 'base64', commitment: 'confirmed' }]) : Promise.resolve({ value: [] as ({ data: [string, string] } | null)[] }),
    rpcCall<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]),
  ]);
  const tables = tableAddresses.map((address, n) => {
    const account = tableAccounts.value[n];
    if (!account) throw new Error('A lookup table Jupiter needs could not be read. Try again.');
    return new web3.AddressLookupTableAccount({ key: new web3.PublicKey(address), state: web3.AddressLookupTableAccount.deserialize(bytesFromBase64(account.data[0])) });
  });
  const instructions = [
    ...(built.computeBudgetInstructions ?? []).map(toInstruction),
    ...(built.setupInstructions ?? []).map(toInstruction),
    ...feeInstructions,
    toInstruction(built.swapInstruction),
    ...(built.cleanupInstruction ? [toInstruction(built.cleanupInstruction)] : []),
    ...(built.otherInstructions ?? []).map(toInstruction),
  ];
  const message = new web3.TransactionMessage({ payerKey: new web3.PublicKey(args.user), recentBlockhash: blockhashResult.value.blockhash, instructions }).compileToV0Message(tables);
  const transaction = new web3.VersionedTransaction(message);
  try {
    transaction.serialize();
  } catch {
    throw new Error('This route is too large to add the Aretia fee. Try a smaller amount or a different pair.');
  }
  if (transaction.message.header.numRequiredSignatures !== 1) blockers.push('The swap transaction asks for a signature from someone other than your wallet. It was blocked.');

  const others = args.heldOthers.filter((h) => h.mint !== SOL_MINT && h.mint !== args.from.mint && h.mint !== args.to.mint).slice(0, Math.floor((MAX_WATCHED - 3) / 2));
  const otherAddrs = others.map((h) => [ataAddress(web3, args.user, h.mint, TOKEN_PROGRAM_ID), ataAddress(web3, args.user, h.mint, TOKEN_2022_PROGRAM_ID)] as const);
  const addresses = [args.user, ...(inAta ? [inAta] : []), ...(outAta ? [outAta] : []), ...otherAddrs.flat()];

  const wire = toBase64(transaction.serialize());
  const [pre, simResult] = await Promise.all([
    rpcCall<{ value: (SimAccount | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]),
    rpcCall<{ value: { err: unknown; logs: string[] | null; accounts: (SimAccount | null)[] | null } }>('simulateTransaction', [
      wire,
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } },
    ]),
  ]);
  const post = simResult.value.accounts ?? [];

  const tokenAmount = (a: SimAccount | null | undefined): bigint | null => (a ? (parseTokenAccount(bytesFromBase64(a.data[0]))?.amount ?? 0n) : null);
  let idx = 1;
  const inIdx = inAta ? idx++ : -1;
  const outIdx = outAta ? idx++ : -1;
  const sumOther = (list: (SimAccount | null | undefined)[], i: number): bigint => (tokenAmount(list[i]) ?? 0n) + (tokenAmount(list[i + 1]) ?? 0n);
  const failure = simResult.value.err === null ? null : ((simResult.value.logs ?? []).filter((l) => /failed|error|insufficient|slippage/i.test(l)).pop() ?? JSON.stringify(simResult.value.err));
  const sim: SwapSimulation = {
    solPre: BigInt(pre.value[0]?.lamports ?? 0),
    solPost: BigInt(post[0]?.lamports ?? pre.value[0]?.lamports ?? 0),
    inPre: inIdx >= 0 ? tokenAmount(pre.value[inIdx]) : null,
    inPost: inIdx >= 0 ? (tokenAmount(post[inIdx]) ?? 0n) : null,
    outPre: outIdx >= 0 ? (tokenAmount(pre.value[outIdx]) ?? 0n) : null,
    outPost: outIdx >= 0 ? tokenAmount(post[outIdx]) : null,
    others: others.map((h, n) => ({ symbol: h.symbol, pre: sumOther(pre.value, idx + n * 2), post: sumOther(post, idx + n * 2) })),
    error: failure,
  };
  const verdict = judgeSwapSimulation({
    inputIsSol: inIsSol,
    outputIsSol: outIsSol,
    amountIn: args.amountRaw,
    minOut: quote.minOut,
    sim,
    overheadLamports: SWAP_SOL_OVERHEAD_LAMPORTS + (opensFeeAccount ? SWAP_FEE_ACCOUNT_RENT_LAMPORTS : 0n),
  });

  return {
    quote,
    transaction,
    verdict,
    blockers: [...blockers, ...verdict.problems],
    priorityFeeLamports: built.prioritizationFeeLamports ?? 0,
    feeRaw,
    opensFeeAccount,
    opensOutputAccount: outIdx >= 0 && tokenAmount(pre.value[outIdx]) === null,
    plannedAt: Date.now(),
  };
}

// ---------------------------------------------------------------- signing

interface SignedTx {
  serialize(): Uint8Array;
  message: { serialize(): Uint8Array };
}
interface SigningContext {
  signTransaction?: (tx: Web3.VersionedTransaction) => Promise<SignedTx>;
}

/** Asks the connected wallet to sign, checks it returned the same transaction, and submits it. Returns the signature. */
export async function signAndSubmitSwap(plan: SwapPlan): Promise<string> {
  const ctx = window.AretiaWallet?.getWalletContextState() as SigningContext | undefined;
  if (!ctx?.signTransaction) throw new Error('The connected wallet cannot sign from this page.');
  const signed = await ctx.signTransaction(plan.transaction);
  const sent = signed.message.serialize();
  const built = plan.transaction.message.serialize();
  if (sent.length !== built.length || sent.some((b, i) => b !== built[i])) {
    throw new Error('The wallet returned a different transaction from the one shown. Nothing was sent.');
  }
  return rpcCall<string>('sendTransaction', [toBase64(signed.serialize()), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
}
