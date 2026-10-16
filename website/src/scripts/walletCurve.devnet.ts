/**
 * A real end-to-end run of the curve flow against the program deployed on DEVNET: it makes a token, opens a curve, buys, sells,
 * sells the curve out, and moves it into a Meteora pool, all through the same walletCurveCore / walletCurveTx / walletCurveFlow
 * code the Launch page uses, with the only difference that a local keypair signs instead of a browser wallet.
 *
 * It spends devnet SOL and is never part of `npm test`. Run it with
 *   CURVE_DEVNET_KEYPAIR=<path to a funded devnet keypair json> npm run test:curve-devnet
 * The keypair file is read here and never printed. Mainnet is refused: the RPC address is fixed to devnet in this file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CURVE_PROGRAM_ID_DEVNET, DEFAULT_CURVE_FORM, validateCurve } from './walletCurveCore';
import { CurveFlow, type CurveFlowDeps } from './walletCurveFlow';
import { curveAddress, tokenVaultAddress } from './walletCurveTx';
import { TOKEN_2022_PROGRAM_ID, ataAddress, createAtaIdempotentInstruction } from './walletTools';

const RPC = 'https://api.devnet.solana.com';
const keyPath = process.env.CURVE_DEVNET_KEYPAIR;

const connection = new web3.Connection(RPC, 'confirmed');

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

function deps(payer: web3.Keypair): CurveFlowDeps {
  return {
    web3,
    program: CURVE_PROGRAM_ID_DEVNET,
    balanceOf: async (a) => BigInt(await connection.getBalance(new web3.PublicKey(a))),
    latestBlockhash: async () => connection.getLatestBlockhash('confirmed'),
    fetchAccount: async (a) => {
      const info = await connection.getAccountInfo(new web3.PublicKey(a), 'confirmed');
      return info ? { owner: info.owner.toBase58(), data: Uint8Array.from(info.data), lamports: BigInt(info.lamports), executable: info.executable } : null;
    },
    simulate: async (tx, watch) => {
      const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const r = await rpc<{ value: { err: unknown; logs: string[] | null; accounts: ({ lamports: number } | null)[] | null } }>('simulateTransaction', [
        Buffer.from(bytes).toString('base64'),
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [watch] } },
      ]);
      if (r.value.err === null) {
        const after = r.value.accounts?.[0]?.lamports;
        return { ok: true, error: null, lamportsAfter: typeof after === 'number' ? BigInt(after) : null };
      }
      const last = (r.value.logs ?? []).filter((l) => /failed|error|insufficient/i.test(l)).pop();
      return { ok: false, error: last ?? JSON.stringify(r.value.err), lamportsAfter: null };
    },
    signAndSubmit: async (tx, extra) => {
      tx.partialSign(payer, ...(extra as web3.Keypair[]));
      return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
    },
    confirm: async (signature) => {
      for (let i = 0; i < 60; i++) {
        const r = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const s = r.value[0];
        if (s?.err) return 'failed';
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return 'confirmed';
        await new Promise((res) => setTimeout(res, 1000));
      }
      return 'pending';
    },
    nowSecs: () => Math.floor(Date.now() / 1000),
  };
}

async function makeMint(payer: web3.Keypair, supplyRaw: bigint, decimals: number): Promise<string> {
  const mint = web3.Keypair.generate();
  const space = 166 + 4 + 64;
  const rent = await connection.getMinimumBalanceForRentExemption(space);
  const tokenProgram = new web3.PublicKey(TOKEN_2022_PROGRAM_ID);
  const ata = ataAddress(web3, payer.publicKey.toBase58(), mint.publicKey.toBase58(), TOKEN_2022_PROGRAM_ID);
  const mintTo = Buffer.alloc(9);
  mintTo[0] = 7;
  mintTo.writeBigUInt64LE(supplyRaw, 1);
  const initMeta = Buffer.concat([Buffer.from([39, 0]), Buffer.alloc(32), mint.publicKey.toBuffer()]);
  const initMint = Buffer.concat([Buffer.from([20, decimals]), payer.publicKey.toBuffer(), Buffer.from([0])]);
  const tx = new web3.Transaction().add(
    web3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space, programId: tokenProgram }),
    new web3.TransactionInstruction({ programId: tokenProgram, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: initMeta }),
    new web3.TransactionInstruction({ programId: tokenProgram, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: initMint }),
    createAtaIdempotentInstruction(web3, payer.publicKey.toBase58(), ata, payer.publicKey.toBase58(), mint.publicKey.toBase58(), TOKEN_2022_PROGRAM_ID),
    new web3.TransactionInstruction({
      programId: tokenProgram,
      keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }, { pubkey: new web3.PublicKey(ata), isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      data: mintTo,
    }),
    // SetAuthority(MintTokens) -> None: the supply is fixed, as on the Launch page.
    new web3.TransactionInstruction({ programId: tokenProgram, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([6, 0, 0]) }),
  );
  await web3.sendAndConfirmTransaction(connection, tx, [payer, mint], { commitment: 'confirmed' });
  return mint.publicKey.toBase58();
}

describe.skipIf(!keyPath)('the curve flow against the devnet program', () => {
  it('creates a curve, trades on it, sells it out and moves it into a locked Meteora pool', { timeout: 600_000 }, async () => {
    const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath!, 'utf8')) as number[]));
    const me = payer.publicKey.toBase58();
    const log: Record<string, unknown> = { program: CURVE_PROGRAM_ID_DEVNET, wallet: me, startBalance: String(await connection.getBalance(payer.publicKey)) };
    const flow = new CurveFlow(deps(payer));

    // 1. A fixed-supply Token-2022 token, as the Launch page makes.
    const mint = await makeMint(payer, 1_000_000_000_000_000n, 6);
    log.mint = mint;

    // 2. Open the curve: 1,000,000,000 tokens, target 0.1 SOL (the program's smallest).
    const token = (await flow.loadToken(me, mint))!;
    const v = validateCurve({ ...DEFAULT_CURVE_FORM, mint, tokenAmount: '1,000,000,000', target: '0.1' }, me, token);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    const createReview = await flow.prepareCreate(v.config, token);
    expect(createReview.blockers).toEqual([]);
    const created = await flow.create(createReview);
    log.createSignature = created.signature;
    log.curve = created.curve;
    expect(created.differences).toEqual([]);
    expect(created.curve).toBe(curveAddress(web3, CURVE_PROGRAM_ID_DEVNET, mint));
    expect(await connection.getBalance(new web3.PublicKey(created.curve))).toBeGreaterThan(0);
    expect(tokenVaultAddress(web3, created.curve, mint)).toBeTruthy();

    // 3. Buy, then sell back half.
    let curve = (await flow.loadCurve(mint))!;
    expect(curve.status).toBe('trading');
    const buyReview = await flow.prepareBuy(me, curve, 30_000_000n);
    expect(buyReview.blockers).toEqual([]);
    const bought = await flow.buy(buyReview);
    log.buySignature = bought.signature;
    expect(bought.differences).toEqual([]);
    expect(bought.tokensAfter! - buyReview.tokensBefore).toBeGreaterThanOrEqual(buyReview.minOut);
    expect(bought.tokensAfter! - buyReview.tokensBefore).toBe(buyReview.quote!.tokensOut);

    curve = (await flow.loadCurve(mint))!;
    const feeBefore = BigInt(await connection.getBalance(new web3.PublicKey('2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2')));
    const sellReview = await flow.prepareSell(me, curve, buyReview.quote!.tokensOut / 2n);
    expect(sellReview.blockers).toEqual([]);
    const sold = await flow.sell(sellReview);
    log.sellSignature = sold.signature;
    expect(sold.differences).toEqual([]);
    const feeAfter = BigInt(await connection.getBalance(new web3.PublicKey('2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2')));
    expect(feeAfter - feeBefore).toBe(sellReview.quote!.fee);

    // 4. Sell the curve out with an offer larger than what is left: only what is left is charged.
    curve = (await flow.loadCurve(mint))!;
    const rest = await flow.prepareBuy(me, curve, 500_000_000n);
    expect(rest.blockers).toEqual([]);
    expect(rest.quote!.soldOut).toBe(true);
    expect(rest.quote!.gross).toBeLessThan(500_000_000n);
    const finished = await flow.buy(rest);
    log.sellOutSignature = finished.signature;
    expect(finished.differences).toEqual([]);
    curve = (await flow.loadCurve(mint))!;
    expect(curve.status).toBe('soldOut');
    expect(curve.realTok).toBe(0n);

    // 5. Move it into a pool.
    const m = await flow.prepareMigrate(me, curve);
    log.migrateBlockers = m.blockers;
    log.migrateNetwork = String(m.network);
    expect(m.blockers).toEqual([]);
    const moved = await flow.migrate(m);
    log.migrateSignature = moved.signature;
    log.pool = moved.pool;
    expect(moved.differences).toEqual([]);
    curve = (await flow.loadCurve(mint))!;
    expect(curve.status).toBe('migrated');
    expect(curve.pool).toBe(m.pool);

    log.endBalance = String(await connection.getBalance(payer.publicKey));
    writeFileSync(process.env.CURVE_DEVNET_LOG ?? 'curve-devnet-run.json', JSON.stringify(log, null, 2));
  });
});
