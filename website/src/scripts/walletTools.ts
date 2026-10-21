/**
 * Pure logic for the web wallet's Shield tab (no DOM, no network), so it can be tested on its own.
 * Mirrors the Aretia Wallet extension's rule: `shieldFindings` is the same Solana recipient check
 * (packages/chains/solana/src/shield.ts), minus anything that needs a signing wallet.
 */

import type * as Web3 from '@solana/web3.js';

// ------------------------------------------------------------------ addresses

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True for a base58 string that decodes to exactly 32 bytes, i.e. a Solana public key. */
export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  const bytes: number[] = [];
  for (const ch of value) {
    let carry = BASE58.indexOf(ch);
    if (carry < 0) return false;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading '1' is one leading zero byte.
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return bytes.length === 32;
}

/** The 32 bytes of a base58 Solana address, or null when it is not one. */
export function base58Bytes(value: string): Uint8Array | null {
  if (!isSolanaAddress(value)) return null;
  const bytes: number[] = [];
  for (const ch of value) {
    let carry = BASE58.indexOf(ch);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);

// ------------------------------------------------------------------ Shield

/** The System Program id (32 zero bytes in base58), owner of every plain wallet account. */
export const SYSTEM_PROGRAM_ID = '1'.repeat(32);

export interface AccountSnapshot {
  /** False when `getAccountInfo` returned null: the address has never been funded or touched. */
  exists: boolean;
  executable: boolean;
  owner: string | null;
}

export interface Finding {
  severity: 'warning' | 'info';
  message: string;
}

export function shieldFindings(account: AccountSnapshot, ownAddress: string | null, checked: string): Finding[] {
  const findings: Finding[] = [];
  if (ownAddress !== null && ownAddress === checked) {
    findings.push({ severity: 'info', message: 'This is the address of the wallet you have connected.' });
  }
  if (!account.exists) {
    findings.push({
      severity: 'warning',
      message:
        'This address has no prior on-chain activity. Double-check it before sending, especially if you typed or pasted it.',
    });
    return findings;
  }
  if (account.executable || (account.owner !== null && account.owner !== SYSTEM_PROGRAM_ID)) {
    findings.push({
      severity: 'info',
      message: 'This is a program or token account, not a personal wallet. Sending to it may not reach a person.',
    });
  }
  return findings;
}

/** The well-known Solana tokens, by their real mints (never matched by name alone). */
export const KNOWN_TOKENS: ReadonlyArray<{ symbol: string; mint: string; decimals: number }> = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  { symbol: 'ACT', mint: '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG', decimals: 9 },
];

/**
 * "0.001" -> "1000000" for a 9-decimal token, by string arithmetic (no floating point).
 * Returns null when the text is not a plain decimal number or has more decimal places than the token.
 */
export function toSmallestUnit(amount: string, decimals: number): string | null {
  const m = amount.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  const digits = (m[1]! + fraction.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  return digits;
}

// ------------------------------------------------------------------ Send (pure parts)


export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** Lamports needed to keep a brand-new 0-byte account alive (rent exemption). */
export const MIN_NEW_ACCOUNT_LAMPORTS = 890_880n;
/** Base network fee for a one-signature transaction. */
export const BASE_FEE_LAMPORTS = 5_000n;

/** "1000000" -> "0.001" for a 9-decimal token: the inverse of `toSmallestUnit`. */
export function fromSmallestUnit(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export interface MintInfo {
  decimals: number;
  /** Token-2022 mints with extensions (such as a transfer fee) are longer than the 82-byte base layout. */
  hasExtensions: boolean;
}

/** Reads the decimals from a mint account's data; null if it is too short to be a mint. */
export function parseMint(owner: string, data: Uint8Array): MintInfo | null {
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) return null;
  if (data.length < 82 || data[45] !== 1) return null; // byte 45 is is_initialized
  return { decimals: data[44]!, hasExtensions: owner === TOKEN_2022_PROGRAM_ID && data.length > 82 };
}

export interface TokenAccountInfo {
  amount: bigint;
  frozen: boolean;
}

/** Reads balance and frozen state from a token account's data; null if too short or uninitialised. */
export function parseTokenAccount(data: Uint8Array): TokenAccountInfo | null {
  if (data.length < 165) return null;
  const state = data[108]!;
  if (state === 0) return null;
  return { amount: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true), frozen: state === 2 };
}

/** The associated token account address for an owner, mint and token program. */
export function ataAddress(web3: typeof Web3, owner: string, mint: string, tokenProgram: string): string {
  const [address] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(owner).toBytes(), new web3.PublicKey(tokenProgram).toBytes(), new web3.PublicKey(mint).toBytes()],
    new web3.PublicKey(ATA_PROGRAM_ID),
  );
  return address.toBase58();
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** A plain SOL transfer. */
export function solTransferInstruction(web3: typeof Web3, from: string, to: string, lamports: bigint): Web3.TransactionInstruction {
  return web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(from), toPubkey: new web3.PublicKey(to), lamports });
}

/** Create the recipient's associated token account if it does not exist yet (safe to include if it does). */
export function createAtaIdempotentInstruction(web3: typeof Web3, payer: string, ata: string, owner: string, mint: string, tokenProgram: string): Web3.TransactionInstruction {
  const key = (address: string, isSigner: boolean, isWritable: boolean) => ({ pubkey: new web3.PublicKey(address), isSigner, isWritable });
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(ATA_PROGRAM_ID),
    keys: [
      key(payer, true, true),
      key(ata, false, true),
      key(owner, false, false),
      key(mint, false, false),
      key('11111111111111111111111111111111', false, false),
      key(tokenProgram, false, false),
    ],
    data: new Uint8Array([1]) as unknown as Buffer,
  });
}

/** SPL Token / Token-2022 `TransferChecked`: the program re-checks the mint and decimals, and applies any transfer fee itself. */
export function transferCheckedInstruction(web3: typeof Web3, tokenProgram: string, source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number): Web3.TransactionInstruction {
  const key = (address: string, isSigner: boolean, isWritable: boolean) => ({ pubkey: new web3.PublicKey(address), isSigner, isWritable });
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64le(amount), 1);
  data[9] = decimals;
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(tokenProgram),
    keys: [key(source, false, true), key(mint, false, false), key(destination, false, true), key(owner, true, false)],
    data: data as unknown as Buffer,
  });
}

export interface RecipientVerdict {
  /** Reasons the transfer must not go ahead. */
  blockers: string[];
  /** The recipient is owned by an unusual program: the user must acknowledge before signing. */
  needsAck: boolean;
}

/**
 * Whether it is safe to send to this account. A program or a token account cannot be an owner of a
 * token account the way a wallet can, so tokens sent to it would be stuck for good.
 */
export function judgeRecipient(account: AccountSnapshot): RecipientVerdict {
  const blockers: string[] = [];
  let needsAck = false;
  if (account.exists) {
    if (account.executable) blockers.push('This address is a program, not a wallet. Funds sent to it would be stuck.');
    else if (account.owner === TOKEN_PROGRAM_ID || account.owner === TOKEN_2022_PROGRAM_ID) {
      blockers.push('This address is a token account, not a wallet. Send to the wallet that owns it instead.');
    } else if (account.owner !== null && account.owner !== SYSTEM_PROGRAM_ID) {
      needsAck = true;
    }
  }
  return { blockers, needsAck };
}

// ------------------------------------------------------------------ Swap (pure parts)

/** SOL a swap may legitimately use besides the amount: base fee, capped priority fee and up to two new token accounts. */
export const SWAP_SOL_OVERHEAD_LAMPORTS = 4_500_000n;
/** Extra SOL allowed when the swap also opens Aretia's fee account (rent for a token account, with room to spare). */
export const SWAP_FEE_ACCOUNT_RENT_LAMPORTS = 2_200_000n;
/** Aretia's fee on every swap: 1% of what the user sells, taken from the token being sold. */
export const SWAP_FEE_BPS = 100n;
/** Where swap fees go: the management-fee wallet (see MANAGEMENT_FEE.md). */
export const SWAP_FEE_WALLET = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';

/** Splits what the user sells into Aretia's fee (rounded down) and the amount that actually gets swapped. */
export function splitSwapFee(amount: bigint, feeBps: bigint = SWAP_FEE_BPS): { fee: bigint; net: bigint } {
  const fee = (amount * feeBps) / 10_000n;
  return { fee, net: amount - fee };
}

/** Slippage presets the swap screen offers, in basis points. */
export const SLIPPAGE_PRESETS_BPS = [50, 100, 300] as const;

/** Jupiter's own default is 0.5%; thin tokens such as ACT get 1% because their price moves more between quote and execution. */
export function defaultSlippageBps(involvesThinToken: boolean): number {
  return involvesThinToken ? 100 : 50;
}

/**
 * How much of the price move is caused by the trade's own size: compares the rate of the full trade
 * with the rate of a trade 1/100th the size from the same pool. Returns a fraction (0.2 = 20%), or
 * null when it cannot be worked out. Used instead of Jupiter's figure, which is meaningless for a
 * token it has no reference price for (it reports 100% for ACT).
 */
export function sizeImpact(fullIn: bigint, fullOut: bigint, smallIn: bigint, smallOut: bigint): number | null {
  if (fullIn <= 0n || smallIn <= 0n || smallOut <= 0n || fullOut < 0n) return null;
  // rate = out / in; impact = 1 - rateFull / rateSmall = 1 - (fullOut * smallIn) / (smallOut * fullIn)
  const scaled = (fullOut * smallIn * 1_000_000n) / (smallOut * fullIn);
  const impact = 1 - Number(scaled) / 1_000_000;
  return Number.isFinite(impact) ? Math.max(0, impact) : null;
}

export interface SwapSimulation {
  /** Lamports in the wallet before and after the simulated transaction. */
  solPre: bigint;
  solPost: bigint;
  /** Balance of the token being sold / bought (raw units); null for SOL on that side. */
  inPre: bigint | null;
  inPost: bigint | null;
  outPre: bigint | null;
  outPost: bigint | null;
  /** Every other token the wallet holds that the simulation could watch. */
  others: { symbol: string; pre: bigint; post: bigint }[];
  /** The simulation's own error, if it failed. */
  error: string | null;
}

export interface SwapVerdict {
  problems: string[];
  /** What the wallet gives up of the token being sold, from the simulation (raw units). */
  paid: bigint | null;
  /** What it receives of the token being bought, from the simulation (raw units); null for SOL, where fees blur it. */
  received: bigint | null;
  /** SOL used beyond the swap amount: fees and any account opening. */
  solOverhead: bigint;
}

/**
 * Pump.fun's AMM program (PumpSwap) and what its error numbers mean, from its published interface (idl/pump_amm.json in
 * pump-fun/pump-public-docs). These are faults in the accounts a swap sends, not in the person's balance, so they are said that way.
 */
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_AMM_ERRORS: Record<number, string> = {
  6044: 'not enough extra accounts were sent',
  6049: 'cashback is disabled for this pool',
  6053: 'the buyback fee recipient was not accepted',
  6059: 'a cashback trade is missing the accounts it needs',
  6060: 'the cashback accumulator account was not accepted',
  6061: 'the cashback token account was missing or not accepted',
  6062: 'the pool record account was missing or not accepted',
  6079: 'this pool pays cashback and needs the other trade form',
};

/** The program's own error text in plain words where it is known; otherwise the text as it came. */
export function explainProgramError(error: string): string {
  const m = /Program (\w+) failed: custom program error: 0x([0-9a-fA-F]+)/.exec(error);
  if (!m || m[1] !== PUMP_AMM_PROGRAM) return error;
  const code = parseInt(m[2]!, 16);
  const what = PUMP_AMM_ERRORS[code];
  return what
    ? `Pump.fun's trading program turned this swap down because ${what} (its error ${code}). The problem is in how Aretia talks to this pool, not in your balance. Nothing was sent.`
    : `Pump.fun's trading program turned this swap down (its error ${code}). Nothing was sent.`;
}

/**
 * Judges a simulated swap by what it would do to the wallet, not by what the API says it will do.
 * The transaction comes from a third party, so these checks are what stand between a bad or
 * tampered response and a signature.
 */
export function judgeSwapSimulation(args: {
  inputIsSol: boolean;
  outputIsSol: boolean;
  amountIn: bigint;
  minOut: bigint;
  sim: SwapSimulation;
  overheadLamports?: bigint;
}): SwapVerdict {
  const { sim, amountIn } = args;
  const overheadCap = args.overheadLamports ?? SWAP_SOL_OVERHEAD_LAMPORTS;
  const problems: string[] = [];
  if (sim.error !== null) problems.push(`The network would reject this swap: ${explainProgramError(sim.error)}`);

  const solSpent = sim.solPre - sim.solPost; // negative if SOL was received
  let paid: bigint | null = null;
  let received: bigint | null = null;
  let solOverhead: bigint;

  if (args.inputIsSol) {
    solOverhead = solSpent - amountIn;
    if (solOverhead > overheadCap) problems.push('The simulation shows this swap using more SOL than you entered plus normal fees. It was blocked.');
    paid = amountIn;
  } else {
    if (sim.inPre === null || sim.inPost === null) {
      problems.push("Could not read the token you are selling, so the swap could not be checked.");
    } else {
      paid = sim.inPre - sim.inPost;
      if (paid > amountIn) problems.push('The simulation shows this swap taking more than the amount you entered. It was blocked.');
    }
    solOverhead = solSpent;
    if (solOverhead > overheadCap) problems.push('The simulation shows this swap using more SOL than normal fees and new token accounts need. It was blocked.');
  }

  if (args.outputIsSol) {
    // The SOL gained is net of fees, so only a floor can be checked.
    const gained = sim.solPost - sim.solPre;
    if (sim.error === null && gained + overheadCap < args.minOut) problems.push('The simulation shows you receiving less SOL than your minimum. The swap would fail.');
  } else if (sim.outPost !== null) {
    received = sim.outPost - (sim.outPre ?? 0n);
    if (sim.error === null && received < args.minOut) problems.push('The simulation shows you receiving less than your minimum, so the swap would fail. Raise the slippage or try a smaller amount.');
  } else if (sim.error === null) {
    problems.push('Could not see the token you are buying after the swap, so it could not be checked.');
  }

  // A failed simulation returns no balances, so there is nothing to compare: skip rather than read "no data" as "zero".
  for (const o of sim.error === null ? sim.others : []) {
    if (o.post < o.pre) problems.push(`The simulation shows this swap also reducing your ${o.symbol} balance. It was blocked.`);
  }
  return { problems, paid, received, solOverhead };
}

// ------------------------------------------------------------------ Swap instruction allow-list

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
/** Jupiter's v6 aggregator program, the only program allowed to carry the swap itself. */
export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** One instruction as Jupiter's swap-instructions API returns it, with its data already decoded from base64. */
export interface PlainInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
}

const u32At = (d: Uint8Array, at: number): number | null => (d.length >= at + 4 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true) : null);
const u64At = (d: Uint8Array, at: number): bigint | null => (d.length >= at + 8 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true) : null);

/**
 * Checks every instruction a third party (Jupiter) put in a swap against an allow-list of programs and instruction kinds, and
 * returns what it refuses. Balance checks alone cannot see an instruction that changes control without moving a balance (an
 * approval, a new authority, the wallet reassigned to another program), so anything not plainly part of a swap is refused:
 *
 *  - ComputeBudget: unit limit and price, heap size, loaded-data limit; the priority fee they imply is capped.
 *  - System: `transfer` (only into the wallet's own wSOL account, to wrap SOL) and `createAccount` (only for a token account).
 *    `assign`, `allocate`, the seeded variants and every nonce instruction are refused.
 *  - Associated Token Account: `create` and `createIdempotent`.
 *  - SPL Token and Token-2022: `syncNative`; `closeAccount` paying the wallet; `initializeAccount3` of a wSOL account the wallet
 *    owns; `transfer`/`transferChecked` only into the wallet's own wSOL account. Approvals, authority changes and the rest are refused.
 *  - Jupiter v6, for the swap instruction only (and the swap instruction must be Jupiter's).
 *
 * Aretia's own fee instructions are built by this code and are not passed in.
 */
export function vetSwapInstructions(list: { role: 'swap' | 'support'; ix: PlainInstruction }[], ctx: { user: string; wsolAccount: string; maxPriorityLamports: number }): string[] {
  const problems = new Set<string>();
  const refuse = (what: string): void => void problems.add(`The swap from Jupiter includes ${what}, which Aretia does not allow in a swap. It was blocked.`);
  const user = base58Bytes(ctx.user);
  const key = (ix: PlainInstruction, i: number): string | null => ix.accounts[i]?.pubkey ?? null;
  let unitLimit: number | null = null;
  let microLamportsPerUnit: bigint | null = null;
  const swaps = list.filter((x) => x.role === 'swap');
  if (swaps.length !== 1 || swaps[0]!.ix.programId !== JUPITER_V6_PROGRAM_ID) refuse('a swap instruction that is not from the Jupiter v6 program');

  for (const { role, ix } of list) {
    const d = ix.data;
    if (role === 'swap') continue;
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID: {
        const tag = d[0];
        if (tag === 2 && d.length === 5) unitLimit = u32At(d, 1);
        else if (tag === 3 && d.length === 9) microLamportsPerUnit = u64At(d, 1);
        else if (!((tag === 1 || tag === 4) && d.length === 5)) refuse('an unknown compute-budget instruction');
        break;
      }
      case SYSTEM_PROGRAM_ID: {
        const tag = u32At(d, 0);
        if (tag === 2 && d.length === 12) {
          if (key(ix, 1) !== ctx.wsolAccount) refuse('a SOL transfer to an account other than your own wrapped-SOL account');
        } else if (tag === 0 && d.length === 52) {
          const owner = d.subarray(20, 52);
          if (!sameBytes(owner, base58Bytes(TOKEN_PROGRAM_ID)) && !sameBytes(owner, base58Bytes(TOKEN_2022_PROGRAM_ID))) refuse('a new account handed to a program other than the token programs');
        } else {
          refuse(tag === 1 || tag === 10 ? 'an instruction that reassigns an account to another program' : tag === 8 || tag === 9 ? 'an instruction that allocates account space' : tag !== null && tag >= 4 && tag <= 7 ? 'a durable-nonce instruction' : 'an unexpected System Program instruction');
        }
        break;
      }
      case ATA_PROGRAM_ID:
        if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) refuse('an unexpected associated-token-account instruction');
        break;
      case TOKEN_PROGRAM_ID:
      case TOKEN_2022_PROGRAM_ID: {
        const tag = d[0];
        if (tag === 17 && d.length === 1) break; // SyncNative
        if (tag === 9 && d.length === 1) {
          if (key(ix, 1) !== ctx.user) refuse('a token-account closure that pays someone other than you');
          break;
        }
        if (tag === 18 && d.length === 33) {
          if (key(ix, 1) !== WSOL_MINT || !sameBytes(d.subarray(1, 33), user)) refuse('a new token account that is not your own wrapped-SOL account');
          break;
        }
        if ((tag === 3 && d.length === 9) || (tag === 12 && d.length === 10)) {
          const dest = tag === 3 ? key(ix, 1) : key(ix, 2);
          if (dest !== ctx.wsolAccount || (tag === 12 && key(ix, 1) !== WSOL_MINT)) refuse('a token transfer to an account other than your own wrapped-SOL account');
          break;
        }
        refuse(tag === 4 || tag === 13 ? 'a token approval (it would let someone else spend your tokens)' : tag === 6 ? 'a change of token-account authority' : 'an unexpected token instruction');
        break;
      }
      default:
        refuse(ix.programId === JUPITER_V6_PROGRAM_ID ? 'a second Jupiter instruction outside the swap' : `an instruction for a program Aretia does not recognise (${ix.programId.slice(0, 8)}…)`);
    }
  }
  // The priority fee goes to the network, but it is still the person's SOL: no more than was asked of Jupiter.
  if (microLamportsPerUnit !== null) {
    const limit = BigInt(unitLimit ?? 1_400_000);
    if ((microLamportsPerUnit * limit) / 1_000_000n > BigInt(ctx.maxPriorityLamports)) refuse('a priority fee above the limit Aretia asked for');
  }
  return [...problems];
}

/** The parts of a token account's data that say who controls it: owner, delegate, close authority. */
export function tokenAccountControl(data: Uint8Array): { owner: Uint8Array; delegate: Uint8Array; closeAuthority: Uint8Array; mint: Uint8Array } | null {
  if (data.length < 165) return null;
  return { mint: data.subarray(0, 32), owner: data.subarray(32, 64), delegate: data.subarray(72, 108), closeAuthority: data.subarray(129, 165) };
}

/**
 * Compares a token account before and after a simulated swap: its owner, delegate and close authority must not change. Returns
 * what changed, or null. An account that the swap closes is fine (its rent comes back to the wallet; closing a token account needs a zero balance, or wSOL).
 */
export function tokenControlChange(pre: Uint8Array, post: Uint8Array | null): string | null {
  if (post === null) return null;
  const a = tokenAccountControl(pre);
  const b = tokenAccountControl(post);
  if (!a || !b) return 'its layout';
  if (!sameBytes(a.owner, b.owner)) return 'its owner';
  if (!sameBytes(a.delegate, b.delegate)) return 'who may spend from it';
  if (!sameBytes(a.closeAuthority, b.closeAuthority)) return 'who may close it';
  return null;
}

/** True when the token account's owner field is this wallet. */
export function tokenAccountOwnedBy(data: Uint8Array, owner: string): boolean {
  const c = tokenAccountControl(data);
  return c !== null && sameBytes(c.owner, base58Bytes(owner));
}

/** True when the token account holds wrapped SOL. */
export function isWsolAccount(data: Uint8Array): boolean {
  const c = tokenAccountControl(data);
  return c !== null && sameBytes(c.mint, base58Bytes(WSOL_MINT));
}
