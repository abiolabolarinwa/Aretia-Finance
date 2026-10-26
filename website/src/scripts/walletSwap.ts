/**
 * Swaps for the web wallet, using Jupiter's Swap API behind our own screen.
 *
 * Jupiter quotes the route and supplies the swap instructions; this page adds Aretia's fee as one
 * extra transfer and assembles the transaction itself. Because the swap instructions come from a third
 * party, nothing is signed on trust: every instruction must be on an allow-list of programs and
 * instruction kinds (see vetSwapInstructions), the page checks the fee payer, simulates it on our RPC
 * with every account of the wallet's that the transaction can write to watched, and judges the swap by
 * what it would do to those balances and their authorities (see judgeSwapSimulation). Only then does it
 * ask the connected wallet to sign, checks the
 * wallet returned the same transaction, and submits it through the RPC proxy. Keys never leave the
 * wallet.
 *
 * Data leaving the page: the token pair, amount and wallet address go to Jupiter (quote and swap
 * build) and to Aretia's RPC proxy.
 */
import type * as Web3 from '@solana/web3.js';
import { fetchAccount, loadWeb3, rpcCall } from './walletSend';
import { checkSignedTransaction } from './walletSignedCheck';
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
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  tokenAccountOwnedBy,
  tokenControlChange,
  transferCheckedInstruction,
  vetSwapInstructions,
  isWsolAccount,
  type PlainInstruction,
  type SwapSimulation,
  type SwapVerdict,
} from './walletTools';

const JUPITER_API = 'https://lite-api.jup.ag';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Most the swap may pay in priority fee, in lamports (0.0005 SOL). */
const MAX_PRIORITY_LAMPORTS = 500_000;
/** Longest a quote may be reused when building a swap. */
const QUOTE_MAX_AGE_MS = 8_000;
/** Accounts watched in one simulation (the RPC's limit for one read). A swap that writes to more is refused. */
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
      // Jupiter's free service allows about one request a second per visitor: wait a moment before the one retry instead of asking again at once.
      if (res.status === 429) await new Promise((resolve) => setTimeout(resolve, 1_200));
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
  /** When the quote was fetched (ms). A quote older than a few seconds is fetched again before it is used to build a swap. */
  fetchedAt: number;
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
    fetchedAt: Date.now(),
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
  /** The address lookup tables the transaction uses, kept so a wallet's returned copy can be read back and compared. */
  lookupTables?: Web3.AddressLookupTableAccount[];
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
  /** The program that owns the account. */
  owner?: string;
  data: [string, string];
}

/** Everything checked before the wallet is asked to sign. Throws only when a service cannot be reached. */
export async function planSwap(args: PlanArgs): Promise<SwapPlan> {
  const web3 = await loadWeb3();
  // Aretia's fee comes off what the user sells; Jupiter swaps the rest.
  const { fee, net } = splitSwapFee(args.amountRaw, args.feeBps);
  // The quote on screen may be minutes old. Prices move, and a swap built from a stale quote fails on-chain with a
  // slippage error, so a quote older than a few seconds is replaced with a fresh one before anything is built.
  const reusable = args.quote && Date.now() - args.quote.fetchedAt < QUOTE_MAX_AGE_MS ? args.quote : undefined;
  const quote = reusable ?? (await fetchQuote(args.from.mint, args.to.mint, net, args.slippageBps));
  const built = await jupJson<JupSwapInstructions>('/swap/v1/swap-instructions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: args.user,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: MAX_PRIORITY_LAMPORTS, priorityLevel: 'high' } },
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

  // Every instruction Jupiter sent must be on the allow-list, before anything is simulated or shown for signing.
  const plain = (i: JupInstruction): PlainInstruction => ({ programId: i.programId, accounts: i.accounts, data: bytesFromBase64(i.data) });
  const jupiterInstructions = [
    ...[...(built.computeBudgetInstructions ?? []), ...(built.setupInstructions ?? [])].map((i) => ({ role: 'support' as const, ix: plain(i) })),
    { role: 'swap' as const, ix: plain(built.swapInstruction) },
    ...[...(built.cleanupInstruction ? [built.cleanupInstruction] : []), ...(built.otherInstructions ?? [])].map((i) => ({ role: 'support' as const, ix: plain(i) })),
  ];
  blockers.push(...vetSwapInstructions(jupiterInstructions, { user: args.user, wsolAccount: ataAddress(web3, args.user, SOL_MINT, TOKEN_PROGRAM_ID), maxPriorityLamports: MAX_PRIORITY_LAMPORTS }));

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

  // Watched: the wallet, the two token accounts of the swap, and every other account the transaction can write to (an account
  // it cannot write to cannot change). Those that turn out to be token accounts of this wallet are held to "nothing lost, no
  // new authority", whatever their address; the rest (pools, vaults, Aretia's fee account) are not the wallet's.
  const writable = [...new Set(instructions.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))];
  const swapAccounts = [args.user, ...(inAta ? [inAta] : []), ...(outAta ? [outAta] : [])];
  const extra = writable.filter((a) => !swapAccounts.includes(a));
  if (swapAccounts.length + extra.length > MAX_WATCHED) blockers.push('This route touches more accounts than Aretia can check in one simulation. It was blocked; try a smaller amount or a different pair.');
  const addresses = [...swapAccounts, ...extra].slice(0, MAX_WATCHED);

  const wire = toBase64(transaction.serialize());
  const [pre, simResult] = await Promise.all([
    rpcCall<{ value: (SimAccount | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]),
    rpcCall<{ value: { err: unknown; logs: string[] | null; accounts: (SimAccount | null)[] | null } }>('simulateTransaction', [
      wire,
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } },
    ]),
  ]);
  const post = simResult.value.accounts ?? [];

  const dataOf = (a: SimAccount | null | undefined): Uint8Array | null => (a ? bytesFromBase64(a.data[0]) : null);
  const tokenAmount = (a: SimAccount | null | undefined): bigint | null => (a ? (parseTokenAccount(bytesFromBase64(a.data[0]))?.amount ?? 0n) : null);
  const isUserToken = (a: SimAccount | null | undefined): boolean => !!a && (a.owner === TOKEN_PROGRAM_ID || a.owner === TOKEN_2022_PROGRAM_ID) && tokenAccountOwnedBy(dataOf(a)!, args.user);
  const inIdx = inAta ? 1 : -1;
  const outIdx = outAta ? swapAccounts.length - 1 : -1;
  const ran = simResult.value.err === null;
  const symbolOf = (data: Uint8Array): string => {
    const mint = new web3.PublicKey(data.subarray(0, 32)).toBase58();
    return args.heldOthers.find((h) => h.mint === mint)?.symbol ?? `the token ${mint.slice(0, 4)}…${mint.slice(-4)}`;
  };
  const others: SwapSimulation['others'] = [];
  addresses.forEach((_, n) => {
    const before = pre.value[n];
    if (n === 0 || !isUserToken(before)) return;
    // No account of the wallet may get a new owner, delegate or close authority, whatever its balance does.
    const changed = ran ? tokenControlChange(dataOf(before)!, dataOf(post[n])) : null;
    if (changed) blockers.push(`The simulation shows this swap changing ${changed} for one of your token accounts. It was blocked.`);
    // The two accounts of the swap are judged below; a wSOL account that is closed has paid its SOL back into the wallet.
    if (n === inIdx || n === outIdx || (isWsolAccount(dataOf(before)!) && !post[n])) return;
    others.push({ symbol: symbolOf(dataOf(before)!), pre: tokenAmount(before) ?? 0n, post: tokenAmount(post[n]) ?? 0n });
  });
  // A wallet reassigned to another program keeps its balance but is no longer the person's to spend.
  if (ran && post[0]?.owner !== undefined && post[0].owner !== SYSTEM_PROGRAM_ID) blockers.push('The simulation shows this swap handing your wallet account to another program. It was blocked.');

  const rawFailure = simResult.value.err === null ? null : ((simResult.value.logs ?? []).filter((l) => /failed|error|insufficient|slippage/i.test(l)).pop() ?? JSON.stringify(simResult.value.err));
  // Jupiter's custom error 0x1771 is its slippage check: the price moved past the allowance.
  const failure = rawFailure !== null && /0x1771\b/i.test(rawFailure) ? 'the price moved more than your slippage setting allows. Review again for a fresh price, or raise the slippage.' : rawFailure;
  const sim: SwapSimulation = {
    solPre: BigInt(pre.value[0]?.lamports ?? 0),
    solPost: BigInt(post[0]?.lamports ?? pre.value[0]?.lamports ?? 0),
    inPre: inIdx >= 0 ? tokenAmount(pre.value[inIdx]) : null,
    inPost: inIdx >= 0 ? (tokenAmount(post[inIdx]) ?? 0n) : null,
    outPre: outIdx >= 0 ? (tokenAmount(pre.value[outIdx]) ?? 0n) : null,
    outPost: outIdx >= 0 ? tokenAmount(post[outIdx]) : null,
    others,
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
    lookupTables: tables,
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

/**
 * Signed swaps that went out through the public path, kept so a swap the network has not picked up can be sent again.
 * Sending the same signed bytes twice is harmless: the signature is the same, so it can land only once.
 */
const SENT = new Map<string, { wire: string; at: number; lastResend: number }>();
const RESEND_EVERY_MS = 3_000;

/**
 * Sends a swap again if it was submitted here, is still unconfirmed and was last sent over 3 seconds ago. The caller polls the status
 * and calls this only while it is not yet seen. Returns whether it was sent. Never throws: a failed resend changes nothing.
 */
export async function resendSwap(signature: string, now: number = Date.now()): Promise<boolean> {
  const sent = SENT.get(signature);
  if (!sent || now - sent.lastResend < RESEND_EVERY_MS) return false;
  sent.lastResend = now;
  try {
    // Preflight is skipped: the first send already passed it, and a second one would only add delay.
    await rpcCall<string>('sendTransaction', [sent.wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
    return true;
  } catch {
    return false;
  }
}

/** Forgets a swap once it is confirmed, failed or expired. */
export function forgetSwap(signature: string): void {
  SENT.delete(signature);
}

/** Asks the connected wallet to sign, checks it returned the same transaction, and submits it. Returns the signature. */
export async function signAndSubmitSwap(plan: SwapPlan, opts: { protectedSubmit?: boolean } = {}): Promise<string> {
  const ctx = window.AretiaWallet?.getWalletContextState() as SigningContext | undefined;
  if (!ctx?.signTransaction) throw new Error('The connected wallet cannot sign from this page.');
  const signed = await ctx.signTransaction(plan.transaction);
  // The wallet must hand back what was shown. Guard instructions some wallets add (Phantom's Lighthouse) are allowed; nothing else is.
  const checked = checkSignedTransaction(await loadWeb3(), plan.transaction, signed as Web3.VersionedTransaction, plan.lookupTables ?? []);
  if (!checked.ok) throw new Error(`The wallet returned a different transaction from the one shown (${checked.reason}). Nothing was sent.`);
  if (opts.protectedSubmit) {
    // Protected sending goes through Aretia's relay to Jito. If it cannot, nothing is sent the public way instead:
    // that would quietly defeat what the user asked for.
    const stop = 'Protected sending failed, so nothing was sent. Try again, or turn protected sending off to send it the normal way.';
    let res: Response;
    try {
      res = await fetch('/api/swings-submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: toBase64(signed.serialize()) }) });
    } catch {
      throw new Error(stop);
    }
    const out = (await res.json().catch(() => null)) as { signature?: unknown } | null;
    if (!res.ok || typeof out?.signature !== 'string') throw new Error(stop);
    return out.signature;
  }
  const wire = toBase64(signed.serialize());
  const signature = await rpcCall<string>('sendTransaction', [wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  const now = Date.now();
  for (const [key, v] of SENT) if (now - v.at > 5 * 60_000) SENT.delete(key);
  SENT.set(signature, { wire, at: now, lastResend: now });
  return signature;
}
