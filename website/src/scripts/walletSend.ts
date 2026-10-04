/**
 * Send and Pay for the web wallet: plan a transfer, check it, then hand it to the visitor's own
 * wallet to sign. Nothing here holds a key. The page builds an unsigned transaction, simulates it
 * on a public RPC (no signature, no funds move), shows the result, and only after an explicit
 * click asks the connected wallet to sign; it then submits the signed bytes and watches for
 * confirmation. Names (.sns) are resolved with Bonfida's SNS SDK, loaded only when one is typed.
 *
 * Data leaving the page: the addresses and amounts involved go to the public Solana RPC, and a
 * typed .sns name goes to the same RPC through the SNS SDK.
 */
import type * as Web3 from '@solana/web3.js';
import {
  BASE_FEE_LAMPORTS,
  MIN_NEW_ACCOUNT_LAMPORTS,
  ataAddress,
  createAtaIdempotentInstruction,
  fromSmallestUnit,
  isSolanaAddress,
  judgeRecipient,
  parseMint,
  parseTokenAccount,
  solTransferInstruction,
  toSmallestUnit,
  transferCheckedInstruction,
  type AccountSnapshot,
} from './walletTools';

export const RPC_URL = 'https://solana-rpc.publicnode.com';

export async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`The Solana RPC answered ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- lazy libraries

let web3Promise: Promise<typeof Web3> | null = null;
/** @solana/web3.js, loaded the first time Send or a .sns lookup needs it (it is large). */
export function loadWeb3(): Promise<typeof Web3> {
  web3Promise ??= (async () => {
    const { Buffer } = await import('buffer');
    (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
    return import('@solana/web3.js');
  })();
  return web3Promise;
}

/** Resolves a `.sns` name to its owner address, or throws a plain-language error. */
export async function resolveName(name: string): Promise<string> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.sol')) {
    throw new Error(`"${name}" can't be looked up: Solana Name Service names now end in .sns, and .sol names are not resolved. Ask the recipient for their .sns name or their address.`);
  }
  if (!lower.endsWith('.sns')) {
    throw new Error(`"${name}" is not a Solana address or a .sns name.`);
  }
  const web3 = await loadWeb3();
  const { resolve } = await import('@bonfida/spl-name-service/domain');
  try {
    const owner = await resolve(new web3.Connection(RPC_URL), name);
    return owner.toBase58();
  } catch {
    throw new Error(`"${name}" did not resolve to an address. Check the spelling, or ask the recipient for their address.`);
  }
}

// ---------------------------------------------------------------- reads

interface RawAccount {
  lamports: bigint;
  owner: string;
  executable: boolean;
  data: Uint8Array;
}

function fromBase64(b64: string): Uint8Array {
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

export async function fetchAccount(address: string): Promise<RawAccount | null> {
  const r = await rpcCall<{ value: { lamports: number; owner: string; executable: boolean; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!r.value) return null;
  return { lamports: BigInt(r.value.lamports), owner: r.value.owner, executable: r.value.executable, data: fromBase64(r.value.data[0]) };
}

const snapshotOf = (a: RawAccount | null): AccountSnapshot => (a ? { exists: true, executable: a.executable, owner: a.owner } : { exists: false, executable: false, owner: null });

// ---------------------------------------------------------------- planning

export interface SendRequest {
  from: string;
  /** The recipient's wallet address (a .sns name must already be resolved to this). */
  to: string;
  /** null for native SOL. */
  mint: string | null;
  symbol: string;
  amountText: string;
}

export interface SendPlan {
  from: string;
  to: string;
  symbol: string;
  mint: string | null;
  decimals: number;
  amountRaw: bigint;
  amountText: string;
  tokenProgram: string | null;
  destAta: string | null;
  createsDestAta: boolean;
  /** Token-2022 mint with extensions: it may withhold a transfer fee of its own. */
  mayCharge: boolean;
  feeLamports: bigint;
  /** Extra SOL the sender pays to open the recipient's token account (an estimate). */
  rentLamports: bigint;
  recipient: AccountSnapshot;
  blockers: string[];
  needsAck: boolean;
  /** Unsigned, with a recent blockhash; null when there are blockers. */
  transaction: Web3.Transaction | null;
}

/** Everything that can be checked before asking the wallet to sign. Throws only on network failure. */
export async function planSend(req: SendRequest): Promise<SendPlan> {
  const web3 = await loadWeb3();
  const blockers: string[] = [];
  if (!isSolanaAddress(req.from)) throw new Error('No connected wallet address.');
  if (!isSolanaAddress(req.to)) throw new Error('The recipient is not a valid Solana address.');

  const isSol = req.mint === null;
  const [recipientAcc, senderAcc] = await Promise.all([fetchAccount(req.to), fetchAccount(req.from)]);
  const recipient = snapshotOf(recipientAcc);
  const verdict = judgeRecipient(recipient);
  blockers.push(...verdict.blockers);
  const senderLamports = senderAcc?.lamports ?? 0n;

  let decimals = 9;
  let tokenProgram: string | null = null;
  let destAta: string | null = null;
  let createsDestAta = false;
  let mayCharge = false;
  let rentLamports = 0n;
  let sourceAta: string | null = null;

  if (!isSol) {
    const mintAcc = await fetchAccount(req.mint!);
    const mint = mintAcc ? parseMint(mintAcc.owner, mintAcc.data) : null;
    if (!mintAcc || !mint) throw new Error(`${req.symbol} could not be read as a token on Solana.`);
    decimals = mint.decimals;
    tokenProgram = mintAcc.owner;
    mayCharge = mint.hasExtensions;
    sourceAta = ataAddress(web3, req.from, req.mint!, tokenProgram);
    destAta = ataAddress(web3, req.to, req.mint!, tokenProgram);
    const [sourceAcc, destAcc] = await Promise.all([fetchAccount(sourceAta), fetchAccount(destAta)]);
    const source = sourceAcc ? parseTokenAccount(sourceAcc.data) : null;
    createsDestAta = destAcc === null;
    if (destAcc) {
      const dest = parseTokenAccount(destAcc.data);
      if (dest?.frozen) blockers.push(`The recipient's ${req.symbol} account is frozen, so it can't receive.`);
    } else {
      rentLamports = BigInt(await rpcCall<number>('getMinimumBalanceForRentExemption', [165]));
    }
    const amountRawForCheck = toSmallestUnit(req.amountText, decimals);
    if (amountRawForCheck === null) blockers.push(`${req.amountText} is not a valid ${req.symbol} amount (at most ${decimals} decimal places).`);
    else if (!source) blockers.push(`This wallet has no ${req.symbol} to send.`);
    else if (source.frozen) blockers.push(`Your ${req.symbol} account is frozen.`);
    else if (BigInt(amountRawForCheck) > source.amount) blockers.push(`You hold ${fromSmallestUnit(source.amount, decimals)} ${req.symbol}, which is less than ${req.amountText}.`);
    if (senderLamports < BASE_FEE_LAMPORTS + rentLamports) blockers.push('Not enough SOL to pay the network fee' + (rentLamports > 0n ? ' and open the recipient\'s token account.' : '.'));
  }

  const raw = toSmallestUnit(req.amountText, decimals);
  const amountRaw = raw === null ? 0n : BigInt(raw);
  if (raw === null && isSol) blockers.push(`${req.amountText} is not a valid SOL amount (at most 9 decimal places).`);
  if (raw !== null && amountRaw === 0n) blockers.push('The amount must be more than zero.');

  if (isSol && raw !== null) {
    if (amountRaw + BASE_FEE_LAMPORTS > senderLamports) blockers.push(`You hold ${fromSmallestUnit(senderLamports, 9)} SOL, which can't cover ${req.amountText} plus the network fee.`);
    if (!recipientAcc && amountRaw < MIN_NEW_ACCOUNT_LAMPORTS) blockers.push(`This address has never been used, and a new account needs at least ${fromSmallestUnit(MIN_NEW_ACCOUNT_LAMPORTS, 9)} SOL to exist. Send at least that much.`);
  }

  let transaction: Web3.Transaction | null = null;
  if (blockers.length === 0) {
    const { blockhash, lastValidBlockHeight } = (await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const tx = new web3.Transaction({ feePayer: new web3.PublicKey(req.from), blockhash, lastValidBlockHeight });
    if (isSol) {
      tx.add(solTransferInstruction(web3, req.from, req.to, amountRaw));
    } else {
      if (createsDestAta) tx.add(createAtaIdempotentInstruction(web3, req.from, destAta!, req.to, req.mint!, tokenProgram!));
      tx.add(transferCheckedInstruction(web3, tokenProgram!, sourceAta!, req.mint!, destAta!, req.from, amountRaw, decimals));
    }
    transaction = tx;
  }

  return {
    from: req.from, to: req.to, symbol: req.symbol, mint: req.mint, decimals, amountRaw, amountText: req.amountText,
    tokenProgram, destAta, createsDestAta, mayCharge, feeLamports: BASE_FEE_LAMPORTS, rentLamports,
    recipient, blockers, needsAck: verdict.needsAck, transaction,
  };
}

export interface Simulation {
  ok: boolean;
  error: string | null;
}

/** Runs the transaction on the RPC without a signature. No funds move. */
export async function simulatePlan(plan: SendPlan): Promise<Simulation> {
  if (!plan.transaction) return { ok: false, error: 'Nothing to simulate.' };
  const bytes = plan.transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  const r = await rpcCall<{ value: { err: unknown; logs: string[] | null } }>('simulateTransaction', [toBase64(bytes), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
  if (r.value.err === null) return { ok: true, error: null };
  const lastLog = (r.value.logs ?? []).filter((l) => /failed|error|insufficient/i.test(l)).pop();
  return { ok: false, error: lastLog ?? JSON.stringify(r.value.err) };
}

// ---------------------------------------------------------------- signing

interface SigningContext {
  signTransaction?: (tx: Web3.Transaction) => Promise<Web3.Transaction>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Asks the connected wallet to sign, checks the wallet returned the same transaction we built, then
 * submits it. Returns the signature.
 */
export async function signAndSubmit(plan: SendPlan): Promise<string> {
  if (!plan.transaction) throw new Error('Nothing to sign.');
  const ctx = window.AretiaWallet?.getWalletContextState() as SigningContext | undefined;
  if (!ctx?.signTransaction) throw new Error('The connected wallet cannot sign from this page.');
  const signed = await ctx.signTransaction(plan.transaction);
  if (!bytesEqual(signed.serializeMessage(), plan.transaction.serializeMessage())) {
    throw new Error('The wallet returned a different transaction from the one shown. Nothing was sent.');
  }
  const wire = signed.serialize();
  return rpcCall<string>('sendTransaction', [toBase64(wire), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }]);
}

export type Confirmation = 'confirmed' | 'failed' | 'pending';

/** Polls until the transaction is confirmed or the time runs out (it may still land afterwards). */
export async function waitForConfirmation(signature: string, timeoutMs = 60_000): Promise<Confirmation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rpcCall<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const s = r.value[0];
    if (s) {
      if (s.err !== null) return 'failed';
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return 'confirmed';
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return 'pending';
}

