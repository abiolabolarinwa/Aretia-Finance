/**
 * Limit orders on the web wallet: the steps, with every outside dependency passed in so each path can be tested without a network
 * or a wallet. walletOrders.ts connects it to the page.
 *
 *   loadMarket    read the token, its curve, the program's smallest order and what the wallet holds
 *   prepare*      work out the numbers, build the transaction, check it and try it without sending
 *   place/cancel  check again, have the wallet sign, send, wait, and read the result back from the network
 * Each action is one transaction: either it happened or nothing moved. Nothing here can move money the owner did not approve.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress, isSolanaAddress } from './walletTools';
import { accountAmount, parseMintAccount, type AccountReader } from './walletLaunchChain';
import { LaunchError, friendlyError, type Confirmation } from './walletLaunchFlow';
import { curveProblems, parseCurveAccount, type CurveState } from './walletCurveCore';
import {
  ORDER_ACCOUNT_SIZE,
  limitPriceLamports,
  orderDisclosures,
  orderTerms,
  parseAssetAccount,
  parseOrderAccount,
  previewOrder,
  validateOrder,
  type OrderAccount,
  type OrderForm,
  type OrderIssue,
  type OrderPreview,
  type OrderTerms,
} from './walletOrdersCore';
import {
  WRAPPED_SOL_MINT,
  cancelOrderInstruction,
  createOrderInstruction,
  curveAddressOf,
  inspectOrderTransaction,
  orderAddress,
  ordersAssetAddress,
  ordersConfigAddress,
  unwrapSolInstruction,
  wrapSolInstructions,
} from './walletOrdersTx';

const SAFETY_MARGIN_LAMPORTS = 50_000n;
/** What a new order costs in rent and network fees beyond the escrow: the order account, two token accounts and the signature. */
const PLACE_OVERHEAD_FALLBACK_LAMPORTS = 8_000_000n;

export interface OrdersSimulation {
  ok: boolean;
  error: string | null;
}

export interface OrdersFlowDeps {
  web3: typeof Web3;
  /** The order program, from a constant for the cluster, never from the page. */
  program: string;
  /** The web wallet's curve program. */
  curveProgram: string;
  balanceOf(address: string): Promise<bigint>;
  latestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  fetchAccount: AccountReader;
  /** The program's accounts that belong to one owner: the owner's open orders, as raw account data with their addresses. */
  ordersOf(owner: string): Promise<{ address: string; data: Uint8Array }[]>;
  simulate(tx: Web3.Transaction): Promise<OrdersSimulation>;
  signAndSubmit(tx: Web3.Transaction): Promise<string>;
  confirm(signature: string): Promise<Confirmation>;
  /** A number this owner has never used before; it becomes part of the order's address. */
  newNonce(): bigint;
  sleep?(ms: number): Promise<void>;
}

export type OrdersProgress = 'checking' | 'signing' | 'confirming' | 'verifying' | 'done';

export interface Market {
  mint: string;
  decimals: number;
  curve: CurveState;
  /** The program's smallest order for SOL, in lamports. */
  minLamports: bigint;
  /** Plain SOL in the wallet. */
  sol: bigint;
  /** SOL already wrapped (a buy uses this first). */
  wrapped: bigint;
  tokens: bigint;
}

export interface PlaceReview {
  kind: 'place';
  owner: string;
  mint: string;
  terms: OrderTerms;
  preview: OrderPreview;
  disclosures: { severity: 'info' | 'caution'; text: string }[];
  nonce: bigint;
  order: string;
  /** Plain SOL this transaction takes from the wallet beyond the escrow itself: rent and network fees. */
  network: bigint;
  curve: CurveState;
  instructions: Web3.TransactionInstruction[];
  blockers: string[];
}

export interface CancelReview {
  kind: 'cancel';
  owner: string;
  order: string;
  account: OrderAccount;
  /** The fee the program will keep, estimated from what is still unfilled. */
  fee: bigint;
  instructions: Web3.TransactionInstruction[];
  blockers: string[];
}

export interface OrderRow {
  address: string;
  account: OrderAccount;
  decimals: number | null;
  /** The price the order is waiting for, in lamports per whole token. */
  limit: bigint | null;
}

export interface OrdersOutcome {
  signature: string;
  order: string;
  differences: string[];
}

const ERRORS: [RegExp, string][] = [
  [/LimitNotMet|0x1790/i, 'the price is not good enough'],
  [/BelowMinimum/i, 'the order is smaller than the minimum'],
  [/NotALaunchToken/i, 'this is not an Aretia Launch token'],
  [/AssetNotEnabled/i, 'SOL orders are not switched on'],
  [/Paused/i, 'orders are paused'],
  [/insufficient funds|0x1\b/i, 'the wallet does not hold enough'],
];
const explain = (error: string | null): string => {
  const text = error ?? 'unknown reason';
  for (const [re, words] of ERRORS) if (re.test(text)) return words;
  return text.slice(0, 200);
};

export class OrdersFlow {
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly d: OrdersFlowDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---------------------------------------------------------------- reading

  async loadMarket(owner: string, mint: string): Promise<Market | { problem: string }> {
    const { web3, program, curveProgram } = this.d;
    if (!isSolanaAddress(mint)) return { problem: 'That is not a token address.' };
    const m = await this.d.fetchAccount(mint);
    const facts = m ? parseMintAccount(web3, m.owner, m.data) : null;
    if (!facts)
      return {
        problem: 'That address is not a token this page can read (Aretia Launch tokens are Token-2022).',
      };
    const curveAcc = await this.d.fetchAccount(curveAddressOf(web3, curveProgram, mint));
    const curve = curveAcc ? parseCurveAccount(web3, curveAcc.owner, curveProgram, curveAcc.data) : null;
    if (!curve || curve.mint !== mint)
      return {
        problem: 'This token has no Aretia bonding curve, so it cannot have limit orders.',
      };
    const problems = curveProblems(curve);
    if (problems.length) return { problem: `The curve does not look healthy: ${problems[0]}` };
    if (curve.status !== 'trading')
      return {
        problem: 'This token’s curve is not trading (it has sold out or moved to a pool), so orders cannot fill.',
      };
    const asset = await this.d.fetchAccount(ordersAssetAddress(web3, program, WRAPPED_SOL_MINT));
    const info = asset && asset.owner === program ? parseAssetAccount((b) => new web3.PublicKey(b).toBase58(), asset.data) : null;
    if (!info || !info.enabled) return { problem: 'Limit orders in SOL are not switched on.' };
    const tokens = accountAmount((await this.d.fetchAccount(ataAddress(web3, owner, mint, TOKEN_2022_PROGRAM_ID)))?.data ?? null) ?? 0n;
    const wrapped = accountAmount((await this.d.fetchAccount(ataAddress(web3, owner, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID)))?.data ?? null) ?? 0n;
    return {
      mint,
      decimals: facts.decimals,
      curve,
      minLamports: info.minAmount,
      sol: await this.d.balanceOf(owner),
      wrapped,
      tokens,
    };
  }

  /** The owner's open orders. Anything that is not exactly a well-formed order of this program is left out. */
  async listOrders(owner: string): Promise<OrderRow[]> {
    const { web3 } = this.d;
    const key = (b: Uint8Array) => new web3.PublicKey(b).toBase58();
    const rows: OrderRow[] = [];
    const decimalsOf = new Map<string, number | null>();
    for (const { address, data } of await this.d.ordersOf(owner)) {
      if (data.length !== ORDER_ACCOUNT_SIZE) continue;
      const account = parseOrderAccount(key, data);
      if (!account || account.owner !== owner) continue;
      if (!decimalsOf.has(account.launchMint)) {
        const m = await this.d.fetchAccount(account.launchMint);
        decimalsOf.set(account.launchMint, m ? (parseMintAccount(web3, m.owner, m.data)?.decimals ?? null) : null);
      }
      const decimals = decimalsOf.get(account.launchMint) ?? null;
      rows.push({
        address,
        account,
        decimals,
        limit: decimals === null ? null : limitPriceLamports(account, decimals),
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------- placing

  prepareForm(form: OrderForm, market: Market): { issues: OrderIssue[]; terms: OrderTerms | null } {
    // A buy can use SOL already wrapped plus plain SOL (less a little kept back for fees); a sell uses tokens.
    const available = form.side === 'buy' ? market.wrapped + (market.sol > PLACE_OVERHEAD_FALLBACK_LAMPORTS ? market.sol - PLACE_OVERHEAD_FALLBACK_LAMPORTS : 0n) : market.tokens;
    const issues = validateOrder(form, isSolanaAddress, {
      decimals: market.decimals,
      minLamports: market.minLamports,
      available,
    });
    return {
      issues,
      terms: issues.length ? null : orderTerms(form, market.decimals),
    };
  }

  async preparePlace(owner: string, market: Market, terms: OrderTerms): Promise<PlaceReview> {
    const { web3, program, curveProgram } = this.d;
    const blockers: string[] = [];
    const nonce = this.d.newNonce();
    const order = orderAddress(web3, program, owner, nonce);
    const ixs: Web3.TransactionInstruction[] = [];
    if (terms.side === 'buy') {
      const shortfall = terms.amountIn > market.wrapped ? terms.amountIn - market.wrapped : 0n;
      ixs.push(...wrapSolInstructions(web3, owner, shortfall));
    }
    ixs.push(
      createOrderInstruction(web3, {
        programId: program,
        owner,
        launchMint: market.mint,
        launchTokenProgram: TOKEN_2022_PROGRAM_ID,
        curve: curveAddressOf(web3, curveProgram, market.mint),
        side: terms.side,
        nonce,
        amountIn: terms.amountIn,
        minOut: terms.minOut,
      }),
    );
    const plainSolNeeded = (terms.side === 'buy' && terms.amountIn > market.wrapped ? terms.amountIn - market.wrapped : 0n) + PLACE_OVERHEAD_FALLBACK_LAMPORTS;
    if (market.sol < plainSolNeeded + SAFETY_MARGIN_LAMPORTS) blockers.push('Your wallet does not hold enough SOL to cover this and the fees shown, with a small margin.');
    if (terms.side === 'sell' && terms.amountIn > market.tokens) blockers.push('More than your wallet holds of this token.');
    const tx = this.assemble(ixs, owner, await this.blockhash());
    const trial = await this.d.simulate(tx);
    if (!trial.ok) blockers.push(`The network would refuse this in a trial run: ${explain(trial.error)}.`);
    return {
      kind: 'place',
      owner,
      mint: market.mint,
      terms,
      preview: previewOrder(terms, market.decimals),
      disclosures: orderDisclosures(terms.side),
      nonce,
      order,
      network: PLACE_OVERHEAD_FALLBACK_LAMPORTS,
      curve: market.curve,
      instructions: ixs,
      blockers,
    };
  }

  async place(review: PlaceReview, progress: (p: OrdersProgress) => void = () => undefined): Promise<OrdersOutcome> {
    const { web3, program } = this.d;
    const signature = await this.send(review, review.owner, progress, (tx) =>
      inspectOrderTransaction(web3, tx, {
        programId: program,
        owner: review.owner,
        instructions: review.instructions,
      }),
    );
    progress('verifying');
    const row = await this.readBack(async () => {
      const acc = await this.d.fetchAccount(review.order);
      return acc && acc.owner === program ? parseOrderAccount((b) => new web3.PublicKey(b).toBase58(), acc.data) : null;
    });
    const differences: string[] = [];
    if (!row) differences.push('The new order could not be read back from the network.');
    else {
      const t = review.terms;
      if (row.owner !== review.owner) differences.push('The order names a different owner.');
      if (row.launchMint !== review.mint) differences.push('The order is for a different token.');
      if (row.side !== t.side) differences.push('The order is on the wrong side.');
      if (row.inTotal !== t.amountIn || row.inRemaining !== t.amountIn) differences.push('The order holds a different amount than you approved.');
      if (row.minOutRemaining !== t.minOut) differences.push('The order’s price is not the one you approved.');
    }
    progress('done');
    return { signature, order: review.order, differences };
  }

  // ---------------------------------------------------------------- cancelling and unwrapping

  async prepareCancel(owner: string, row: OrderRow): Promise<CancelReview> {
    const { web3, program, curveProgram } = this.d;
    const blockers: string[] = [];
    const cfg = await this.d.fetchAccount(ordersConfigAddress(web3, program));
    if (!cfg || cfg.owner !== program || cfg.data.length < 8 + 64) {
      return {
        kind: 'cancel',
        owner,
        order: row.address,
        account: row.account,
        fee: 0n,
        instructions: [],
        blockers: ['The program’s settings could not be read, so the cancel cannot be built safely.'],
      };
    }
    const feeRecipient = new web3.PublicKey(cfg.data.subarray(8 + 32, 8 + 64)).toBase58();
    if (row.account.status !== 1) blockers.push('This order is being filled right now. Try again in a moment.');
    const ix = cancelOrderInstruction(web3, {
      programId: program,
      owner,
      launchMint: row.account.launchMint,
      launchTokenProgram: row.account.launchTokenProgram,
      curve: curveAddressOf(web3, curveProgram, row.account.launchMint),
      order: row.address,
      feeRecipient,
    });
    const fee = (row.account.inRemaining * BigInt(row.account.cancelFeeBps) + 9_999n) / 10_000n;
    const tx = this.assemble([ix], owner, await this.blockhash());
    const trial = await this.d.simulate(tx);
    if (!trial.ok) blockers.push(`The network would refuse this in a trial run: ${explain(trial.error)}.`);
    return {
      kind: 'cancel',
      owner,
      order: row.address,
      account: row.account,
      fee,
      instructions: [ix],
      blockers,
    };
  }

  async cancel(review: CancelReview, progress: (p: OrdersProgress) => void = () => undefined): Promise<OrdersOutcome> {
    const { web3, program } = this.d;
    const signature = await this.send(review, review.owner, progress, (tx) =>
      inspectOrderTransaction(web3, tx, {
        programId: program,
        owner: review.owner,
        instructions: review.instructions,
      }),
    );
    progress('verifying');
    const differences: string[] = [];
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      gone = (await this.d.fetchAccount(review.order)) === null;
      if (!gone) await this.sleep(1000);
    }
    if (!gone) differences.push('The order is still there after the cancel confirmed.');
    progress('done');
    return { signature, order: review.order, differences };
  }

  /** Wrapped SOL the wallet holds (what a cancelled buy or a filled sell leaves), in lamports. */
  async wrappedBalance(owner: string): Promise<bigint> {
    const acc = await this.d.fetchAccount(ataAddress(this.d.web3, owner, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID));
    return accountAmount(acc?.data ?? null) ?? 0n;
  }

  async unwrap(owner: string, progress: (p: OrdersProgress) => void = () => undefined): Promise<OrdersOutcome> {
    const { web3, program } = this.d;
    const ixs = [unwrapSolInstruction(web3, owner)];
    const review = { blockers: [] as string[], instructions: ixs };
    const signature = await this.send(review, owner, progress, (tx) =>
      inspectOrderTransaction(web3, tx, {
        programId: program,
        owner,
        instructions: ixs,
      }),
    );
    progress('verifying');
    const differences: string[] = [];
    if ((await this.wrappedBalance(owner)) !== 0n) differences.push('The wrapped SOL account still holds SOL.');
    progress('done');
    return { signature, order: '', differences };
  }

  // ---------------------------------------------------------------- shared

  private assemble(ixs: Web3.TransactionInstruction[], payer: string, b: { blockhash: string; lastValidBlockHeight: number }): Web3.Transaction {
    const tx = new this.d.web3.Transaction({
      feePayer: new this.d.web3.PublicKey(payer),
      blockhash: b.blockhash,
      lastValidBlockHeight: b.lastValidBlockHeight,
    });
    tx.add(...ixs);
    return tx;
  }

  private blockhash() {
    return this.d.latestBlockhash();
  }

  private async send(
    review: { blockers: string[]; instructions: Web3.TransactionInstruction[] },
    payer: string,
    progress: (p: OrdersProgress) => void,
    inspect: (tx: Web3.Transaction) => string[],
  ): Promise<string> {
    if (review.blockers.length > 0) throw new LaunchError(review.blockers.join(' '), true);
    progress('checking');
    const tx = this.assemble(review.instructions, payer, await this.blockhash());
    const blockers = inspect(tx);
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const sim = await this.d.simulate(tx);
    if (!sim.ok) throw new LaunchError(`The network would refuse this transaction, so it was not sent: ${explain(sim.error)}.`, true);

    progress('signing');
    let signature: string;
    try {
      signature = await this.d.signAndSubmit(tx);
    } catch (e) {
      const message = friendlyError(e);
      throw new LaunchError(message, /closed the wallet|different transaction/.test(message));
    }
    progress('confirming');
    const state = await this.d.confirm(signature);
    if (state === 'failed') throw new LaunchError('The transaction failed on the network. Nothing from it took effect.');
    if (state === 'pending') throw new LaunchError(`The transaction was sent but has not confirmed yet. Check ${signature} on an explorer before trying again.`);
    return signature;
  }

  /** Reads a few times: a node can briefly lag behind the confirmation. */
  private async readBack<T>(read: () => Promise<T | null>): Promise<T | null> {
    for (let i = 0; i < 6; i++) {
      const v = await read();
      if (v) return v;
      await this.sleep(1000);
    }
    return null;
  }
}
