/**
 * The checks that run between "the user approved a quote" and "the wallet is asked to sign". They fail closed: any
 * mismatch is a problem, and a problem means nothing is signed.
 *
 * Network switching is never silent. `ensureNetwork` changes the wallet's network only after a confirmation callback
 * (a real prompt in the UI) returns true, and then re-reads the wallet to confirm the switch really happened.
 */
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import type { UnsignedTransaction, WalletAdapter, WalletSession } from './types.js';

export interface ExecutionExpectation {
  /** The account the quote was made for. */
  address: string;
  /** The chain the transaction is for. */
  chain: ChainId;
  /**
   * Addresses the transaction may call (EVM: the `to`; Solana: the program ids it may use). When given, anything else is
   * refused. Pass the router, the approval spender and similar, taken from Aretia's own registry, never from the quote.
   */
  allowedDestinations?: readonly string[];
  /** The session revision seen when the quote was made. If the wallet changed since, the quote is stale. */
  revision?: number;
  /**
   * Solana only: the ONE token transfer (TransferChecked) the transaction may make, every field fixed (program, source, mint,
   * destination, owner, amount, decimals), from Aretia's own constants. Used for Aretia's Move USDC fee. Any other token transfer,
   * or a second one, is still refused.
   */
  permittedTokenTransfer?: { program: string; source: string; mint: string; destination: string; owner: string; amount: bigint; decimals: number } | null;
}

const same = (a: string, b: string, evm: boolean): boolean => (evm ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Everything wrong with this session for this expectation. Empty means it matches. Pure. */
export function sessionProblems(session: WalletSession, expect: ExecutionExpectation): string[] {
  const problems: string[] = [];
  const info = CHAINS[expect.chain];
  const evm = info.kind === 'evm';
  if (session.state !== 'connected' || !session.address) return ['The wallet is not connected.'];
  if (session.chainType !== info.kind) problems.push(`This wallet is a ${session.chainType} wallet, but the swap is on ${info.name}.`);
  if (!same(session.address, expect.address, evm)) problems.push('The wallet account is not the one this quote was made for.');
  if (evm) {
    if (session.networkId === null) problems.push('The wallet did not report its network.');
    else if (session.networkId !== info.evmChainId) problems.push(`The wallet is on a different network from ${info.name}.`);
    if (session.chain !== expect.chain) problems.push(`The wallet is not on ${info.name}.`);
  }
  if (expect.revision !== undefined && session.revision !== expect.revision) problems.push('The wallet changed after this quote was made. Get a new quote.');
  return problems;
}

/** What is wrong with this transaction for this expectation. Empty means it matches. Pure. */
export function transactionProblems(tx: UnsignedTransaction, session: WalletSession, expect: ExecutionExpectation): string[] {
  const problems: string[] = [];
  const info = CHAINS[expect.chain];
  if (tx.kind === 'evm') {
    if (info.kind !== 'evm') return ['This is an EVM transaction but the swap is not on an EVM network.'];
    if (tx.chainId !== info.evmChainId) problems.push('The transaction is for a different network.');
    if (session.address && tx.tx.from.toLowerCase() !== session.address.toLowerCase()) problems.push('The transaction is from a different account than the wallet.');
    if (expect.allowedDestinations && !expect.allowedDestinations.some((d) => d.toLowerCase() === tx.tx.to.toLowerCase())) problems.push('The transaction calls an address Aretia does not recognise.');
    return problems;
  }
  if (info.kind !== 'solana') return ['This is a Solana transaction but the swap is not on Solana.'];
  const t = tx.transaction;
  const keys = 'version' in t ? t.message.staticAccountKeys.map((k) => k.toBase58()) : t.compileMessage().accountKeys.map((k) => k.toBase58());
  const feePayer = keys[0];
  if (session.address && feePayer !== session.address) problems.push('The transaction is paid for by a different account than the wallet.');
  if (expect.allowedDestinations) {
    const programIds = 'version' in t ? t.message.compiledInstructions.map((i) => keys[i.programIdIndex]!) : t.instructions.map((i) => i.programId.toBase58());
    const unknown = programIds.filter((p) => !expect.allowedDestinations!.includes(p));
    if (unknown.length > 0) problems.push('The transaction calls a program Aretia does not recognise.');
    // An approved program id is not enough: the System and Token programs can also move coins or hand over control. The settlement flows
    // never need those instructions (the burn itself runs inside the bridge program), so they are refused by what they do, not by who runs them.
    const instructions = 'version' in t ? t.message.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex]!, data: i.data, keys: i.accountKeyIndexes.map((k) => keys[k]!) })) : t.instructions.map((i) => ({ program: i.programId.toBase58(), data: i.data, keys: i.keys.map((k) => k.pubkey.toBase58()) }));
    problems.push(...solanaInstructionProblems(instructions, expect.permittedTokenTransfer ?? null));
  }
  return problems;
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
/** System instructions that send coins or change who owns an account: Assign, Transfer, WithdrawNonceAccount, AuthorizeNonceAccount, AssignWithSeed, TransferWithSeed. */
const SYSTEM_REFUSED = new Map<number, string>([[1, 'assigns an account to another program'], [2, 'sends SOL to another account'], [5, 'withdraws from a nonce account'], [7, 'hands over a nonce account'], [10, 'assigns an account to another program'], [11, 'sends SOL to another account']]);
/** Token instructions that move, burn, approve, close or hand over control: Transfer, Approve, SetAuthority, Burn, CloseAccount, TransferChecked, ApproveChecked, BurnChecked. */
const TOKEN_REFUSED = new Map<number, string>([[3, 'transfers tokens'], [4, 'lets another account spend your tokens'], [6, 'hands over control of an account'], [8, 'burns tokens directly'], [9, 'closes an account'], [12, 'transfers tokens'], [13, 'lets another account spend your tokens'], [15, 'burns tokens directly']]);

/** True when this instruction is exactly the permitted TransferChecked: program, accounts, amount and decimals all match. */
function isPermittedTransfer(ix: { program: string; data: Uint8Array; keys?: readonly string[] }, p: NonNullable<ExecutionExpectation['permittedTokenTransfer']>): boolean {
  const d = ix.data;
  if (ix.program !== p.program || d.length !== 10 || d[0] !== 12 || d[9] !== p.decimals) return false;
  const amount = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(1, true);
  const k = ix.keys ?? [];
  return amount === p.amount && k.length === 4 && k[0] === p.source && k[1] === p.mint && k[2] === p.destination && k[3] === p.owner;
}

/**
 * What is wrong with these Solana instructions, by what they do. Empty means none of the refused kinds is present. Pure. `permitted`,
 * when given, lets exactly one TransferChecked that matches it in every field through (Aretia's fee); a second one is refused.
 */
export function solanaInstructionProblems(instructions: readonly { program: string; data: Uint8Array; keys?: readonly string[] }[], permitted: ExecutionExpectation['permittedTokenTransfer'] = null): string[] {
  const out: string[] = [];
  let permittedUsed = false;
  for (const ix of instructions) {
    if (permitted && !permittedUsed && isPermittedTransfer(ix, permitted)) {
      permittedUsed = true;
      continue;
    }
    if (ix.program === SYSTEM_PROGRAM) {
      if (ix.data.length < 4) {
        out.push('The transaction has a System instruction that cannot be read.');
        continue;
      }
      const kind = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getUint32(0, true);
      const why = SYSTEM_REFUSED.get(kind);
      if (why) out.push(`The transaction ${why}, which this action never does.`);
    } else if (TOKEN_PROGRAMS.includes(ix.program)) {
      if (ix.data.length < 1) {
        out.push('The transaction has a Token instruction that cannot be read.');
        continue;
      }
      const why = TOKEN_REFUSED.get(ix.data[0]!);
      if (why) out.push(`The transaction ${why}, which this action never does.`);
    }
  }
  return [...new Set(out)];
}

/**
 * Re-reads the wallet and checks session and transaction. Resolves to the problems; empty means safe to sign.
 * Always asks the wallet afresh: a snapshot from earlier may be stale.
 */
export async function verifyBeforeExecute(wallet: WalletAdapter, expect: ExecutionExpectation, tx?: UnsignedTransaction): Promise<string[]> {
  const session = await wallet.refresh();
  const problems = sessionProblems(session, expect);
  if (problems.length > 0) return problems;
  return tx ? transactionProblems(tx, session, expect) : [];
}

export interface NetworkSwitchRequest {
  from: ChainId | null;
  to: ChainId;
}

/**
 * Puts the wallet on `chain`, only with the user's say-so. If the wallet is already there nothing happens. Otherwise the
 * `confirm` callback must resolve true (it should show a clear prompt naming both networks); then the wallet is asked to
 * switch, and the switch is verified by reading the wallet again.
 */
export async function ensureNetwork(wallet: WalletAdapter, chain: ChainId, confirm: (request: NetworkSwitchRequest) => Promise<boolean>): Promise<WalletSession> {
  const session = await wallet.refresh();
  if (session.state !== 'connected') throw new SwingsError('invalid', 'Connect a wallet first.');
  if (session.chain === chain) return session;
  if (CHAINS[chain].kind !== session.chainType) throw new SwingsError('invalid', `This wallet is a ${session.chainType} wallet and cannot be used on ${CHAINS[chain].name}.`);
  if (!session.capabilities.switchNetwork) throw new SwingsError('not-enabled', `Your wallet cannot be switched to ${CHAINS[chain].name} from here. Switch it in the wallet itself.`);
  if (!(await confirm({ from: session.chain, to: chain }))) throw new SwingsError('rejected', 'The network switch was not confirmed. Nothing was changed.');
  await wallet.switchNetwork(chain);
  const after = await wallet.refresh();
  if (after.chain !== chain) throw new SwingsError('invalid', 'The wallet did not switch networks.');
  return after;
}
