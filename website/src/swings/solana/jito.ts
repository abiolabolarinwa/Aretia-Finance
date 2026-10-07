/**
 * Protected ("private") submission on Solana through Jito's block engine.
 *
 * Why: a swap sent to the public network can be seen before it lands, and a bot can trade around it (a sandwich).
 * Sent to Jito as a bundle-only transaction it skips that public stage. The cost is a small tip, paid inside the
 * same transaction the user signs, so it is part of what the review screen shows and nothing is taken later.
 *
 * Boundaries, stated plainly:
 *  - this reduces sandwiching, it does not eliminate it, and it is not a guarantee of landing;
 *  - the tip is a plain SOL transfer to one of Jito's published tip accounts, capped here;
 *  - the user's signed transaction passes through Aretia's server on its way to Jito (it holds no key and cannot
 *    change the transaction: any change would break the user's signature);
 *  - it is optional and off by default. If protected sending fails, the swap is NOT sent the public way instead:
 *    that would quietly defeat what the user asked for.
 */
import type * as Web3 from '@solana/web3.js';
import { SwingsError } from '../core/types.js';

/** Jito's tip accounts, as returned by its own `getTipAccounts` (checked live in solana.live.ts). */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/** Jito's stated floor for a bundle tip. */
export const MIN_TIP_LAMPORTS = 1_000;
/** The most Aretia will ever add as a tip: 0.001 SOL. A bad setting cannot become a large charge. */
export const MAX_TIP_LAMPORTS = 1_000_000;
export const DEFAULT_TIP_LAMPORTS = 10_000;
/** Where the signed transaction is sent. `bundleOnly` keeps it out of the public transaction path. */
export const JITO_SEND_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** A tip in range, or a clear error. Never clamps: a wrong amount is refused, not quietly changed. */
export function checkTip(lamports: number): number {
  if (!Number.isInteger(lamports) || lamports < MIN_TIP_LAMPORTS || lamports > MAX_TIP_LAMPORTS) {
    throw new SwingsError('invalid', `The tip must be a whole number of lamports from ${MIN_TIP_LAMPORTS} to ${MAX_TIP_LAMPORTS}.`);
  }
  return lamports;
}

export const pickTipAccount = (random: () => number = Math.random): string => JITO_TIP_ACCOUNTS[Math.min(JITO_TIP_ACCOUNTS.length - 1, Math.floor(random() * JITO_TIP_ACCOUNTS.length))]!;

export function tipInstruction(web3: typeof Web3, user: string, lamports: number, account: string): Web3.TransactionInstruction {
  if (!JITO_TIP_ACCOUNTS.includes(account)) throw new SwingsError('invalid', 'That is not a Jito tip account.');
  return web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(user), toPubkey: new web3.PublicKey(account), lamports: BigInt(checkTip(lamports)) });
}

/**
 * Finds the tip in a transaction: a System Program transfer to a Jito tip account. Returns null when there is none.
 * Used by the server before it forwards anything, and by tests.
 */
export function findTip(tx: Web3.VersionedTransaction): { from: string; account: string; lamports: bigint } | null {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  for (const ix of msg.compiledInstructions) {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM || ix.data.length !== 12) continue;
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (view.getUint32(0, true) !== 2) continue; // 2 = transfer
    const from = keys[ix.accountKeyIndexes[0] ?? -1];
    const to = keys[ix.accountKeyIndexes[1] ?? -1];
    if (from && to && JITO_TIP_ACCOUNTS.includes(to)) return { from, account: to, lamports: view.getBigUint64(4, true) };
  }
  return null;
}
