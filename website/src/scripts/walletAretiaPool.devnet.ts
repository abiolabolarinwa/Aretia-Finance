/**
 * A real end-to-end run of the Aretia Pool flow against the program deployed on DEVNET: it makes a token, opens a pool with launch
 * protection, buys, sells, adds and removes liquidity, claims fees, sends fees to another wallet, and locks, all through the same
 * walletAretiaPool* code the Launch card uses, with the only difference that a local keypair signs instead of a browser wallet.
 *
 * It spends devnet SOL and is never part of `npm test`. Run it with
 *   ARETIA_POOL_DEVNET_KEYPAIR=<path to a funded devnet keypair json> npx vitest run --config vitest.devnet.config.ts src/scripts/walletAretiaPool.devnet.ts
 * The keypair file is read here and never printed. Mainnet is refused: the RPC address is fixed to devnet in this file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { ARETIA_POOL_PROGRAM_ID_DEVNET, DEFAULT_ARETIA_POOL_FORM, validateAretiaPool } from './walletAretiaPoolCore';
import { AretiaPoolFlow, type AretiaPoolFlowDeps } from './walletAretiaPoolFlow';
import { wsolAccount } from './walletAretiaPoolTx';
import { TOKEN_2022_PROGRAM_ID, ataAddress, createAtaIdempotentInstruction } from './walletTools';

const RPC = 'https://api.devnet.solana.com';
const keyPath = process.env.ARETIA_POOL_DEVNET_KEYPAIR;

const connection = new web3.Connection(RPC, 'confirmed');

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

function deps(payer: web3.Keypair): AretiaPoolFlowDeps {
  return {
    web3,
    program: ARETIA_POOL_PROGRAM_ID_DEVNET,
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

describe.skipIf(!keyPath)('the Aretia Pool flow against the devnet program', () => {
  it('opens a pool, trades, adds and removes liquidity, claims, redirects fees and locks', { timeout: 600_000 }, async () => {
    const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath!, 'utf8')) as number[]));
    const me = payer.publicKey.toBase58();
    const log: Record<string, unknown> = { program: ARETIA_POOL_PROGRAM_ID_DEVNET, wallet: me, startBalance: String(await connection.getBalance(payer.publicKey)) };
    const flow = new AretiaPoolFlow(deps(payer));

    const mint = await makeMint(payer, 1_000_000_000_000_000n, 6);
    log.mint = mint;
    const token = (await flow.loadToken(me, mint))!;
    const v = validateAretiaPool({ ...DEFAULT_ARETIA_POOL_FORM, mint, tokenAmount: '600,000,000', price: '0.0000000001', tradingFeeBps: '100', lockLiquidity: false, priceRange: 'medium' }, me, token);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    expect(v.params.sniperBps).toBe(1000);

    // 1. Open it.
    const review = await flow.prepare(v.config, v.params, token);
    expect(review.blockers).toEqual([]);
    const created = await flow.create(review);
    log.createSignature = created.signature;
    log.pool = created.pool;
    log.openingCost = { aretiaFee: String(review.cost.aretiaFee), network: String(review.cost.network) };
    expect(created.differences).toEqual([]);
    let view = (await flow.loadPool(mint, me))!;
    expect(view.pool).toMatchObject({ x: v.params.x0, vx: v.params.x0 / 3n, y: 0n, l: v.params.l0, feeBps: 100, feeStartBps: 1000, decaySecs: 300 });

    // 2. Buy at the launch fee (10%, since the pool just opened), then sell half back.
    const buyQ = flow.quote(view.pool, true, 20_000_000n, 100)!;
    expect(buyQ.fee).toBeGreaterThan(1_500_000n); // well above the 1% base fee
    log.buySignature = await flow.trade(me, mint, buyQ);
    view = (await flow.loadPool(mint, me))!;
    const held = BigInt((await connection.getTokenAccountBalance(new web3.PublicKey(ataAddress(web3, me, mint, TOKEN_2022_PROGRAM_ID)))).value.amount);
    const sellQ = flow.quote(view.pool, false, 1_000_000_000_000n, 100)!;
    log.sellSignature = await flow.trade(me, mint, sellQ);
    expect(held).toBeGreaterThan(0n);

    // 3. Add then remove liquidity.
    view = (await flow.loadPool(mint, me))!;
    const addQ = flow.quoteAdd(view.pool, 10_000_000n, 100)!;
    log.addSignature = await flow.addLiquidity(me, mint, addQ);
    view = (await flow.loadPool(mint, me))!;
    expect(view.position!.shares).toBe(v.params.l0 + 10_000_000n);
    const remQ = flow.quoteRemove(view.pool, 10_000_000n, 100)!;
    log.removeSignature = await flow.removeLiquidity(me, mint, remQ);

    // 4. Claim to myself, send fees to another wallet, claim there, then lock.
    view = (await flow.loadPool(mint, me))!;
    expect(view.claimable).toBeGreaterThan(0n);
    log.claimSignature = await flow.claim(me, mint);
    const other = web3.Keypair.generate().publicKey.toBase58();
    log.setRecipientSignature = await flow.setRecipient(me, mint, other);
    // A little more trading so there is something to claim.
    view = (await flow.loadPool(mint, me))!;
    await flow.trade(me, mint, flow.quote(view.pool, true, 100_000_000n, 100)!);
    view = (await flow.loadPool(mint, me))!;
    expect(view.position!.recipient).toBe(other);
    const owed = view.claimable;
    expect(owed).toBeGreaterThan(0n);
    log.claimToOtherSignature = await flow.claim(me, mint, other);
    // Paid in wrapped SOL, to the other wallet's own wrapped-SOL account.
    expect(BigInt((await connection.getTokenAccountBalance(new web3.PublicKey(wsolAccount(web3, other)))).value.amount)).toBe(owed);
    log.lockSignature = await flow.lock(me, mint, view.position!.shares);
    view = (await flow.loadPool(mint, me))!;
    expect(view.position!.locked).toBe(view.position!.shares);

    // 5. Sell the (locked) position to another wallet: everything goes with it, the old owner can do nothing, the new one can claim.
    await flow.trade(me, mint, flow.quote((await flow.loadPool(mint, me))!.pool, true, 60_000_000n, 100)!);
    const buyer2 = web3.Keypair.generate();
    await web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: buyer2.publicKey, lamports: 20_000_000 })), [payer], { commitment: 'confirmed' });
    log.transferSignature = await flow.transferPosition(me, mint, buyer2.publicKey.toBase58());
    const sold = (await flow.loadPool(mint, me))!.position!;
    expect(sold).toMatchObject({ owner: buyer2.publicKey.toBase58(), recipient: buyer2.publicKey.toBase58(), id: me });
    expect(sold.locked).toBe(sold.shares);
    await expect(flow.claim(me, mint)).rejects.toThrow();
    const flow2 = new AretiaPoolFlow(deps(buyer2));
    const owed2 = (await flow2.loadPool(mint, buyer2.publicKey.toBase58(), me))!.claimable;
    expect(owed2).toBeGreaterThan(0n);
    const b2 = BigInt(await connection.getBalance(buyer2.publicKey));
    log.newOwnerClaimSignature = await flow2.claim(buyer2.publicKey.toBase58(), mint, buyer2.publicKey.toBase58(), undefined, me);
    expect(BigInt(await connection.getBalance(buyer2.publicKey)) - b2).toBeGreaterThan(owed2 - 20_000n); // the claim, less the transaction fee

    log.endBalance = String(await connection.getBalance(payer.publicKey));
    writeFileSync(process.env.ARETIA_POOL_DEVNET_LOG ?? 'aretia-pool-devnet-run.json', JSON.stringify(log, null, 2));
  });
});
