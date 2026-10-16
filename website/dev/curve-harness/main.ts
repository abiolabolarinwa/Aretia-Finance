// Local harness: the real curve card, the devnet program, two throwaway keys kept in this browser's localStorage.
import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
import * as web3 from '@solana/web3.js';
import { initCurve } from '../../src/scripts/walletCurve';
import { CURVE_PROGRAM_ID_DEVNET } from '../../src/scripts/walletCurveCore';
import { TOKEN_2022_PROGRAM_ID, ataAddress, createAtaIdempotentInstruction } from '../../src/scripts/walletTools';

const RPC = 'https://api.devnet.solana.com';
const connection = new web3.Connection(RPC, 'confirmed');

function loadKey(name: string): web3.Keypair {
  const saved = localStorage.getItem(`curve-harness-${name}`);
  if (saved) return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved) as number[]));
  const k = web3.Keypair.generate();
  localStorage.setItem(`curve-harness-${name}`, JSON.stringify([...k.secretKey]));
  return k;
}
const wallets = { creator: loadKey('creator'), buyer: loadKey('buyer') };
let active: 'creator' | 'buyer' = 'creator';
const me = () => wallets[active];

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

const card = initCurve(
  { getAddress: () => me().publicKey.toBase58(), refreshWallet: () => void drawBar() },
  {
    program: CURVE_PROGRAM_ID_DEVNET,
    deps: {
      web3,
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
        tx.partialSign(me(), ...(extra as web3.Keypair[]));
        return connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
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
    },
  },
);

async function makeToken(): Promise<string> {
  const payer = me();
  const mint = web3.Keypair.generate();
  const space = 166 + 4 + 64;
  const rent = await connection.getMinimumBalanceForRentExemption(space);
  const tp = new web3.PublicKey(TOKEN_2022_PROGRAM_ID);
  const ata = ataAddress(web3, payer.publicKey.toBase58(), mint.publicKey.toBase58(), TOKEN_2022_PROGRAM_ID);
  const mintTo = Buffer.alloc(9);
  mintTo[0] = 7;
  mintTo.writeBigUInt64LE(1_000_000_000_000_000n, 1);
  const k = (pubkey: web3.PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const tx = new web3.Transaction().add(
    web3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space, programId: tp }),
    new web3.TransactionInstruction({ programId: tp, keys: [k(mint.publicKey, false, true)], data: Buffer.concat([Buffer.from([39, 0]), Buffer.alloc(32), mint.publicKey.toBuffer()]) }),
    new web3.TransactionInstruction({ programId: tp, keys: [k(mint.publicKey, false, true)], data: Buffer.concat([Buffer.from([20, 6]), payer.publicKey.toBuffer(), Buffer.from([0])]) }),
    createAtaIdempotentInstruction(web3, payer.publicKey.toBase58(), ata, payer.publicKey.toBase58(), mint.publicKey.toBase58(), TOKEN_2022_PROGRAM_ID),
    new web3.TransactionInstruction({ programId: tp, keys: [k(mint.publicKey, false, true), k(new web3.PublicKey(ata), false, true), k(payer.publicKey, true, false)], data: mintTo }),
    new web3.TransactionInstruction({ programId: tp, keys: [k(mint.publicKey, false, true), k(payer.publicKey, true, false)], data: Buffer.from([6, 0, 0]) }),
  );
  await web3.sendAndConfirmTransaction(connection, tx, [payer, mint], { commitment: 'confirmed' });
  return mint.publicKey.toBase58();
}

async function drawBar(): Promise<void> {
  const bar = document.getElementById('bar')!;
  const minted = document.getElementById('minted')?.textContent ?? '';
  bar.textContent = '';
  const add = (el: HTMLElement) => bar.append(el);
  for (const name of ['creator', 'buyer'] as const) {
    const b = document.createElement('button');
    b.className = `wapp__btn ${active === name ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`;
    b.textContent = name;
    b.onclick = () => {
      active = name;
      card.onWalletChange();
      void drawBar();
    };
    add(b);
  }
  const addr = document.createElement('code');
  addr.id = 'addr';
  addr.textContent = me().publicKey.toBase58();
  add(addr);
  const bal = document.createElement('span');
  bal.id = 'bal';
  bal.textContent = `${Number(await connection.getBalance(me().publicKey)) / 1e9} SOL`;
  add(bal);
  const mk = document.createElement('button');
  mk.className = 'wapp__btn wapp__btn--ghost';
  mk.id = 'mk';
  mk.textContent = 'Make a test token';
  mk.onclick = async () => {
    mk.disabled = true;
    try {
      const mint = await makeToken();
      card.offer(mint);
      const out = document.createElement('code');
      out.id = 'minted';
      out.textContent = mint;
      add(out);
    } catch (e) {
      alert(String(e));
    } finally {
      mk.disabled = false;
    }
  };
  add(mk);
  if (minted) {
    const out = document.createElement('code');
    out.id = 'minted';
    out.textContent = minted;
    add(out);
  }
}

card.onShow();
void drawBar();
(globalThis as unknown as { harness: unknown }).harness = { wallets: () => ({ creator: wallets.creator.publicKey.toBase58(), buyer: wallets.buyer.publicKey.toBase58() }) };
