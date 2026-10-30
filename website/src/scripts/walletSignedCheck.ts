/**
 * Checks that the transaction a wallet hands back is the one the page showed, allowing for what some wallets add on their own.
 *
 * Why this exists: Phantom (and wallets built like it) put "Lighthouse" guard instructions into a transaction before signing it:
 * extra assertions that make the transaction fail, never succeed, if the accounts end up in a state the wallet does not expect. That
 * changes the message's bytes, so the old byte-for-byte comparison refused every swap signed in Phantom with "The wallet returned a
 * different transaction from the one shown". The comparison below ignores instructions of those guard programs and nothing else:
 * the payer, the blockhash, and every other instruction (program, accounts, data) must be exactly what was shown. A guard can only
 * make a transaction fail; it cannot move money, which is why they are allowed and anything else is not.
 *
 * Wallets also set the transaction's priority fee with the ComputeBudget program (a unit limit and a unit price). Those two
 * instructions move no tokens, so they are ignored on both sides, but the fee they imply on the returned transaction must not
 * exceed MAX_PRIORITY_FEE_LAMPORTS, so a wallet cannot quietly make the user pay a large fee.
 */
import type * as Web3 from '@solana/web3.js';

/** Programs a wallet may add assertion-only instructions from. Lighthouse is the one Phantom uses. */
export const WALLET_GUARD_PROGRAMS: readonly string[] = ['L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'];

/** The ComputeBudget program: SetComputeUnitLimit (2) and SetComputeUnitPrice (3) only; its other instructions are not ignored. */
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/** The most priority fee a wallet may add, in lamports (0.005 SOL). */
export const MAX_PRIORITY_FEE_LAMPORTS = 5_000_000;
/** Without a unit limit instruction a transaction may use up to this many units. */
const MAX_UNITS = 1_400_000;

type Tx = Web3.Transaction | Web3.VersionedTransaction;

interface Plain {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
}
interface Flat {
  payer: string;
  blockhash: string;
  instructions: Plain[];
}

const plain = (i: Web3.TransactionInstruction): Plain => ({
  programId: i.programId.toBase58(),
  keys: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: i.data,
});

function flatten(web3: typeof Web3, tx: Tx, tables: readonly Web3.AddressLookupTableAccount[]): Flat {
  if ('version' in tx) {
    const d = web3.TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [...tables] });
    return { payer: d.payerKey.toBase58(), blockhash: d.recentBlockhash, instructions: d.instructions.map(plain) };
  }
  if (!tx.feePayer || !tx.recentBlockhash) throw new Error('The transaction has no payer or blockhash.');
  return { payer: tx.feePayer.toBase58(), blockhash: tx.recentBlockhash, instructions: tx.instructions.map(plain) };
}

const isBudgetInstruction = (ix: Plain): boolean => ix.programId === COMPUTE_BUDGET && ix.keys.length === 0 && (ix.data[0] === 2 || ix.data[0] === 3);

/** The priority fee the instructions imply, in lamports: unit price (micro-lamports per unit) times the unit limit. */
function priorityFeeLamports(instructions: readonly Plain[]): number {
  let limit = MAX_UNITS;
  let price = 0n;
  for (const ix of instructions) {
    if (!isBudgetInstruction(ix)) continue;
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (ix.data[0] === 2 && ix.data.length >= 5) limit = view.getUint32(1, true);
    if (ix.data[0] === 3 && ix.data.length >= 9) price = view.getBigUint64(1, true);
  }
  return Number((price * BigInt(limit) + 999_999n) / 1_000_000n);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const messageBytes = (tx: Tx): Uint8Array => ('version' in tx ? tx.message.serialize() : tx.serializeMessage());

export type SignedCheck = { ok: true; guards: number } | { ok: false; reason: string };

/**
 * `planned` is what the page built and showed; `signed` is what the wallet returned. `tables` are the address lookup tables the planned
 * transaction uses (none for a legacy transaction or one that does not use them).
 */
export function checkSignedTransaction(web3: typeof Web3, planned: Tx, signed: Tx, tables: readonly Web3.AddressLookupTableAccount[] = [], guardPrograms: readonly string[] = WALLET_GUARD_PROGRAMS): SignedCheck {
  // The usual case: nothing was changed.
  if (sameBytes(messageBytes(planned), messageBytes(signed))) return { ok: true, guards: 0 };
  let a: Flat;
  let b: Flat;
  try {
    a = flatten(web3, planned, tables);
    b = flatten(web3, signed, tables);
  } catch {
    return { ok: false, reason: 'the wallet changed the transaction in a way that could not be read' };
  }
  if (a.payer !== b.payer) return { ok: false, reason: 'the wallet changed who pays' };
  if (a.blockhash !== b.blockhash) return { ok: false, reason: 'the wallet changed the transaction\'s blockhash' };
  const fee = priorityFeeLamports(b.instructions);
  if (fee > MAX_PRIORITY_FEE_LAMPORTS) return { ok: false, reason: `the wallet set a priority fee of about ${(fee / 1e9).toFixed(4)} SOL, which is too high` };
  a.instructions = a.instructions.filter((ix) => !isBudgetInstruction(ix));
  b.instructions = b.instructions.filter((ix) => !isBudgetInstruction(ix));
  const kept: Plain[] = [];
  let guards = 0;
  const unknown = new Set<string>();
  for (const ix of b.instructions) {
    if (guardPrograms.includes(ix.programId)) guards++;
    else kept.push(ix);
  }
  if (kept.length !== a.instructions.length) {
    for (const ix of kept) if (!a.instructions.some((p) => p.programId === ix.programId)) unknown.add(ix.programId);
    return { ok: false, reason: unknown.size > 0 ? `the wallet added an instruction from ${[...unknown].map((p) => `${p.slice(0, 6)}…`).join(', ')}` : 'the wallet added or removed an instruction' };
  }
  // A signed message marks an account as a signer on every instruction once it signs any of them (a new token's address signs the
  // instruction that creates it), while the page's own list has the flag per instruction. So a signer anywhere in the plan may
  // show as a signer everywhere; an account that was a signer and no longer is, or a new signer, is still refused.
  const plannedSigners = new Set<string>([a.payer]);
  for (const ix of a.instructions) for (const k of ix.keys) if (k.isSigner) plannedSigners.add(k.pubkey);
  for (let i = 0; i < kept.length; i++) {
    const want = a.instructions[i]!;
    const got = kept[i]!;
    if (want.programId !== got.programId) return { ok: false, reason: `instruction ${i + 1} now runs ${got.programId.slice(0, 6)}… instead of ${want.programId.slice(0, 6)}…` };
    if (!sameBytes(want.data, got.data)) return { ok: false, reason: `instruction ${i + 1} (${want.programId.slice(0, 6)}…) carries different data` };
    if (want.keys.length !== got.keys.length) return { ok: false, reason: `instruction ${i + 1} (${want.programId.slice(0, 6)}…) names different accounts` };
    for (let k = 0; k < want.keys.length; k++) {
      const w = want.keys[k]!;
      const g = got.keys[k]!;
      // A guard may make an account writable in the message as a whole, so "more writable" is fine; "less" or another account is not.
      if (w.pubkey !== g.pubkey || (w.isSigner && !g.isSigner) || (!w.isSigner && g.isSigner && !plannedSigners.has(g.pubkey)) || (w.isWritable && !g.isWritable)) return { ok: false, reason: `instruction ${i + 1} (${want.programId.slice(0, 6)}…) names different accounts` };
    }
  }
  return { ok: true, guards };
}
