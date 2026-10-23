/**
 * A real run of the limit-orders flow on DEVNET against a deployed copy of the order program: it makes a token, opens its curve,
 * places a limit buy, reads it back, cancels it and checks the 0.58% cancel fee. Same code the Launch page's card uses; a local
 * keypair signs instead of a browser wallet. It spends devnet SOL and is never part of `npm test`.
 *   CURVE_DEVNET_KEYPAIR=<funded devnet keypair json> ORDERS_DEVNET_PROGRAM=<devnet order program id> npm run test:curve-devnet -- src/scripts/walletOrders.devnet.ts
 * The RPC is fixed to devnet in this file. Nothing here touches mainnet.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CURVE_PROGRAM_ID_DEVNET, DEFAULT_CURVE_FORM, validateCurve } from './walletCurveCore';
import { CurveFlow, type CurveFlowDeps } from './walletCurveFlow';
import { OrdersFlow, type OrdersFlowDeps } from './walletOrdersFlow';
import { QUOTE_SOL } from './walletOrdersCore';
import { TOKEN_2022_PROGRAM_ID, ataAddress, createAtaIdempotentInstruction } from './walletTools';

const RPC = 'https://api.devnet.solana.com';
const keyPath = process.env.CURVE_DEVNET_KEYPAIR;
const ordersProgram = process.env.ORDERS_DEVNET_PROGRAM;

const connection = new web3.Connection(RPC, 'confirmed');

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) {
      // The public devnet RPC rate-limits; wait and try again a few times.
      if (/rate limit/i.test(j.error.message) && attempt < 8) {
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(j.error.message);
    }
    return j.result as T;
  }
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


describe.skipIf(!keyPath || !ordersProgram)('limit orders against the devnet order program', () => {
  it('places a limit buy on a fresh curve, reads it back and cancels it for the fee', { timeout: 600_000 }, async () => {
    const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath!, 'utf8')) as number[]));
    const me = payer.publicKey.toBase58();
    const log: Record<string, unknown> = { ordersProgram, curveProgram: CURVE_PROGRAM_ID_DEVNET, wallet: me };
    const cdeps = deps(payer);
    const flow = new CurveFlow(cdeps);

    const mint = await makeMint(payer, 1_000_000_000_000_000n, 6);
    log.mint = mint;
    const token = (await flow.loadToken(me, mint))!;
    const v = validateCurve({ ...DEFAULT_CURVE_FORM, mint, tokenAmount: '1,000,000,000', target: '0.1' }, me, token);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    const createReview = await flow.prepareCreate(v.config, token);
    expect(createReview.blockers).toEqual([]);
    const created = await flow.create(createReview);
    expect(created.differences).toEqual([]);
    log.curve = created.curve;

    const odeps: OrdersFlowDeps = {
      web3,
      program: ordersProgram!,
      curveProgram: CURVE_PROGRAM_ID_DEVNET,
      balanceOf: cdeps.balanceOf,
      latestBlockhash: cdeps.latestBlockhash,
      fetchAccount: cdeps.fetchAccount,
      ordersOf: async (owner) => {
        const r = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>('getProgramAccounts', [
          ordersProgram,
          { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: 235 }, { memcmp: { offset: 8, bytes: owner } }] },
        ]);
        return r.map((x) => ({ address: x.pubkey, data: Uint8Array.from(Buffer.from(x.account.data[0], 'base64')) }));
      },
      simulate: async (tx) => {
        const s = await cdeps.simulate(tx, me);
        if (!s.ok) {
          const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
          const r = await rpc<{ value: { logs: string[] | null } }>('simulateTransaction', [Buffer.from(bytes).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
          console.log((r.value.logs ?? []).join(' | '));
        }
        return { ok: s.ok, error: s.error };
      },
      signAndSubmit: (tx) => cdeps.signAndSubmit(tx, []),
      confirm: cdeps.confirm,
      newNonce: () => BigInt(Date.now()),
    };
    const orders = new OrdersFlow(odeps);

    const market = await orders.loadMarket(me, mint, QUOTE_SOL);
    if ('problem' in market) throw new Error(market.problem);
    log.market = { venue: market.venue, minQuote: String(market.minQuote) };

    // A limit buy: spend 0.3 SOL, ask for at least 1 token per 0.0001 SOL spent... far better than the curve gives, so it rests.
    const terms = { side: 'buy' as const, amountIn: 300_000_000n, minOut: 3_000_000_000_000_000n, priceQuote: 1n };
    const place = await orders.preparePlace(me, market, terms);
    log.placeBlockers = place.blockers;
    expect(place.blockers).toEqual([]);
    const placed = await orders.place(place);
    log.placeSignature = placed.signature;
    log.order = placed.order;
    expect(placed.differences).toEqual([]);

    const rows = await orders.listOrders(me);
    expect(rows.some((r) => r.address === placed.order)).toBe(true);
    const row = rows.find((r) => r.address === placed.order)!;
    const wsolBefore = await orders.wrappedBalance(me);
    const cancel = await orders.prepareCancel(me, row);
    log.cancelBlockers = cancel.blockers;
    expect(cancel.blockers).toEqual([]);
    const cancelled = await orders.cancel(cancel);
    log.cancelSignature = cancelled.signature;
    log.cancelFee = String(cancel.fee);
    expect(cancelled.differences).toEqual([]);
    const wsolAfter = await orders.wrappedBalance(me);
    log.refunded = String(wsolAfter - wsolBefore);
    // 0.58% of 0.3 SOL = 1,740,000 lamports kept; the rest comes back.
    expect(cancel.fee).toBe(1_740_000n);
    expect(wsolAfter - wsolBefore).toBe(300_000_000n - 1_740_000n);

    writeFileSync(process.env.CURVE_DEVNET_LOG ?? 'orders-devnet-run.json', JSON.stringify(log, null, 2));
  });
});
