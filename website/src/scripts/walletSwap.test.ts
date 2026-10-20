import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as web3 from '@solana/web3.js';
import { ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, JUPITER_V6_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, vetSwapInstructions, type PlainInstruction } from './walletTools';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const user = web3.Keypair.generate().publicKey;
const attacker = web3.Keypair.generate().publicKey;
const pk = (s: string) => new web3.PublicKey(s);
const ata = (owner: web3.PublicKey, mint: string, program = TOKEN_PROGRAM_ID) => web3.PublicKey.findProgramAddressSync([owner.toBytes(), pk(program).toBytes(), pk(mint).toBytes()], pk(ATA_PROGRAM_ID))[0];
const wsol = ata(user, SOL);
const plain = (i: web3.TransactionInstruction): PlainInstruction => ({ programId: i.programId.toBase58(), accounts: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Uint8Array.from(i.data) });
const ix = (programId: string, data: number[] | Uint8Array, keys: web3.PublicKey[] = [], writable = true) => new web3.TransactionInstruction({ programId: pk(programId), keys: keys.map((k, n) => ({ pubkey: k, isSigner: k.equals(user), isWritable: writable && n === 0 })), data: Buffer.from(data) });
const jupSwap = ix(JUPITER_V6_PROGRAM_ID, [0xe5, 0x17, 0xcb, 0x97, 1, 2, 3], [user, wsol, ata(user, USDC)]);
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return [...b]; };
const approve = ix(TOKEN_PROGRAM_ID, [4, ...u64(2n ** 64n - 1n)], [ata(user, BONK), attacker, user]);
const assign = web3.SystemProgram.assign({ accountPubkey: user, programId: attacker });
const ctx = { user: user.toBase58(), wsolAccount: wsol.toBase58(), maxPriorityLamports: 500_000 };
const vet = (support: web3.TransactionInstruction[], swap = jupSwap) => vetSwapInstructions([...support.map((i) => ({ role: 'support' as const, ix: plain(i) })), { role: 'swap' as const, ix: plain(swap) }], ctx);

describe('H-2: the Jupiter instruction allow-list', () => {
  it('accepts what a real Jupiter v6 SOL to USDC swap sends', () => {
    const legit = [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
      ix(ATA_PROGRAM_ID, [1], [user, wsol, user, pk(SOL)]),
      web3.SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: 1_000_000_000 }),
      ix(TOKEN_PROGRAM_ID, [17], [wsol]),
      ix(ATA_PROGRAM_ID, [1], [user, ata(user, USDC), user, pk(USDC)]),
      ix(TOKEN_PROGRAM_ID, [9], [wsol, user, user]),
      ix(TOKEN_PROGRAM_ID, [18, ...user.toBytes()], [wsol, pk(SOL)]),
    ];
    expect(vet(legit)).toEqual([]);
  });

  it('refuses the audit proof of concept: an SPL Approve to an attacker and SystemProgram.assign of the wallet', () => {
    const problems = vet([approve, assign]).join(' ');
    expect(problems).toMatch(/token approval/);
    expect(problems).toMatch(/reassigns an account/);
  });

  it('refuses ApproveChecked, SetAuthority and the same on Token-2022', () => {
    expect(vet([ix(TOKEN_2022_PROGRAM_ID, [13, ...u64(1n), 6], [ata(user, BONK, TOKEN_2022_PROGRAM_ID), pk(BONK), attacker, user])]).join(' ')).toMatch(/token approval/);
    expect(vet([ix(TOKEN_PROGRAM_ID, [6, 2, 1, ...attacker.toBytes()], [ata(user, BONK), user])]).join(' ')).toMatch(/authority/);
  });

  it('refuses System assignWithSeed, allocate, nonce instructions and SOL sent anywhere but the wallet\'s own wSOL account', () => {
    expect(vet([web3.SystemProgram.assign({ accountPubkey: user, basePubkey: user, seed: 'x', programId: attacker })]).join(' ')).toMatch(/reassigns/);
    expect(vet([web3.SystemProgram.allocate({ accountPubkey: user, space: 10 })]).join(' ')).toMatch(/allocates/);
    expect(vet([web3.SystemProgram.nonceAuthorize({ noncePubkey: attacker, authorizedPubkey: user, newAuthorizedPubkey: attacker })]).join(' ')).toMatch(/nonce/);
    expect(vet([web3.SystemProgram.transfer({ fromPubkey: user, toPubkey: attacker, lamports: 1 })]).join(' ')).toMatch(/SOL transfer/);
    expect(vet([web3.SystemProgram.createAccount({ fromPubkey: user, newAccountPubkey: attacker, lamports: 1, space: 0, programId: attacker })]).join(' ')).toMatch(/new account/);
  });

  it('refuses token transfers out, closures paying someone else, and a wSOL account for another owner', () => {
    expect(vet([ix(TOKEN_PROGRAM_ID, [3, ...u64(5n)], [ata(user, BONK), ata(attacker, BONK), user])]).join(' ')).toMatch(/token transfer/);
    expect(vet([ix(TOKEN_PROGRAM_ID, [9], [wsol, attacker, user])]).join(' ')).toMatch(/closure/);
    expect(vet([ix(TOKEN_PROGRAM_ID, [18, ...attacker.toBytes()], [wsol, pk(SOL)])]).join(' ')).toMatch(/not your own wrapped-SOL/);
  });

  it('refuses unknown programs, a swap that is not Jupiter v6, a second Jupiter instruction, and an excessive priority fee', () => {
    expect(vet([ix(attacker.toBase58(), [1])]).join(' ')).toMatch(/does not recognise/);
    expect(vet([], ix(attacker.toBase58(), [1], [user])).join(' ')).toMatch(/not from the Jupiter v6 program/);
    expect(vet([jupSwap]).join(' ')).toMatch(/second Jupiter/);
    expect(vet([web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 })]).join(' ')).toMatch(/priority fee/);
    expect(vet([ix(COMPUTE_BUDGET_PROGRAM_ID, [9])]).join(' ')).toMatch(/compute-budget/);
  });
});

// ------------------------------------------------------------------ planSwap end to end, with the RPC faked

const tokenData = (owner: web3.PublicKey, mint: string, amount: bigint, delegate: web3.PublicKey | null = null) => {
  const b = new Uint8Array(165);
  b.set(pk(mint).toBytes(), 0);
  b.set(owner.toBytes(), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  if (delegate) {
    b[72] = 1;
    b.set(delegate.toBytes(), 76);
  }
  b[108] = 1;
  return [Buffer.from(b).toString('base64'), 'base64'];
};
type Acc = { lamports: number; owner: string; data: unknown } | null;
const state: { pre: Map<string, Acc>; post: Map<string, Acc> } = { pre: new Map(), post: new Map() };

vi.mock('./walletSend', () => ({
  loadWeb3: async () => web3,
  fetchAccount: async (a: string) => (a === USDC || a === BONK ? { lamports: 1n, owner: TOKEN_PROGRAM_ID, executable: false, data: new Uint8Array(82) } : { lamports: 10n ** 9n, owner: '11111111111111111111111111111111', executable: false, data: new Uint8Array() }),
  rpcCall: async (method: string, params: unknown[]) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: web3.Keypair.generate().publicKey.toBase58() } };
    if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map((a) => state.pre.get(a) ?? null) };
    if (method === 'simulateTransaction') {
      const addrs = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
      return { value: { err: null, logs: [], accounts: addrs.map((a) => (state.post.has(a) ? state.post.get(a)! : (state.pre.get(a) ?? null))) } };
    }
    throw new Error('unexpected ' + method);
  },
}));

describe('H-2: planSwap with injected or hostile Jupiter instructions', () => {
  const sys = '11111111111111111111111111111111';
  const usdcAta = ata(user, USDC).toBase58();
  const json = (i: web3.TransactionInstruction) => ({ programId: i.programId.toBase58(), accounts: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(i.data).toString('base64') });
  const serve = (body: Record<string, unknown>) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ addressLookupTableAddresses: [], ...body }), { status: 200 })) as typeof fetch;
  };
  const run = async () => {
    const { planSwap, SOL_MINT } = await import('./walletSwap');
    const quote = { raw: {} as never, inAmount: 1_000_000_000n, outAmount: 150_000_000n, minOut: 149_000_000n, slippageBps: 50, routes: [], fetchedAt: Date.now() };
    return planSwap({ user: user.toBase58(), from: { mint: SOL_MINT, symbol: 'SOL', name: '', decimals: 9, icon: null, verified: null }, to: { mint: USDC, symbol: 'USDC', name: '', decimals: 6, icon: null, verified: null }, amountRaw: 1_000_000_000n, slippageBps: 50, heldOthers: [{ mint: BONK, symbol: 'BONK' }], quote, feeBps: 0n });
  };
  // A Jupiter swap instruction that writes to the given accounts of the wallet's.
  const swapWriting = (accounts: web3.PublicKey[]) => new web3.TransactionInstruction({ programId: pk(JUPITER_V6_PROGRAM_ID), keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...accounts.map((a) => ({ pubkey: a, isSigner: false, isWritable: true }))], data: Buffer.from([0xe5, 0x17, 0xcb, 0x97]) });
  // A token account of the wallet's that is not an associated account.
  const loose = web3.Keypair.generate().publicKey;

  beforeEach(() => {
    state.pre = new Map<string, Acc>([
      [user.toBase58(), { lamports: 10_000_000_000, owner: sys, data: ['', 'base64'] }],
      [usdcAta, { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(user, USDC, 0n) }],
      [loose.toBase58(), { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(user, BONK, 5_000n) }],
    ]);
    state.post = new Map<string, Acc>([
      [user.toBase58(), { lamports: 10_000_000_000 - 1_000_000_000 - 2_100_000, owner: sys, data: ['', 'base64'] }],
      [usdcAta, { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(user, USDC, 150_000_000n) }],
    ]);
  });

  it('passes an honest route', async () => {
    serve({ swapInstruction: json(swapWriting([ata(user, USDC)])) });
    expect((await run()).blockers).toEqual([]);
  });

  it('blocks the audit proof of concept (Approve + Assign around a balance-correct swap)', async () => {
    serve({ setupInstructions: [json(approve)], swapInstruction: json(swapWriting([ata(user, USDC)])), otherInstructions: [json(assign)] });
    const blockers = (await run()).blockers.join(' ');
    expect(blockers).toMatch(/token approval/);
    expect(blockers).toMatch(/reassigns an account/);
  });

  it('watches a writable token account of the wallet that is not an associated account', async () => {
    serve({ swapInstruction: json(swapWriting([ata(user, USDC), loose])) });
    state.post.set(loose.toBase58(), { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(user, BONK, 0n) });
    expect((await run()).blockers.join(' ')).toMatch(/reducing your BONK/);
    state.post.set(loose.toBase58(), { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(user, BONK, 5_000n, attacker) });
    expect((await run()).blockers.join(' ')).toMatch(/who may spend from it/);
  });

  it('blocks a swap that leaves the wallet owned by another program', async () => {
    serve({ swapInstruction: json(swapWriting([ata(user, USDC)])) });
    state.post.set(user.toBase58(), { lamports: 10_000_000_000 - 1_000_000_000 - 2_100_000, owner: attacker.toBase58(), data: ['', 'base64'] });
    expect((await run()).blockers.join(' ')).toMatch(/handing your wallet account/);
  });
});
