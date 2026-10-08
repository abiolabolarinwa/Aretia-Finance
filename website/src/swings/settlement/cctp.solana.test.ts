import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CCTP_CONTRACTS, CCTP_USDC, CctpSettlementProvider } from './cctp.js';
import { cctpSolanaAddresses, evmAddressBytes32, MESSAGE_TRANSMITTER_V2, SOLANA_CCTP_PROGRAMS, SOLANA_USDC, TOKEN_MESSENGER_MINTER_V2, usedNonceAddress } from './cctpSolana.js';
import { ataAddress, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { encodeFunction } from '../engine/abiGeneric.js';
import type { SettlementIntent } from './types.js';

const NOW = 5_000_000;
const SOL_USER = web3.Keypair.generate().publicKey.toBase58();
const EVM_USER = '0x' + 'ab'.repeat(20);
const FEE_RECIPIENT = web3.Keypair.generate().publicKey.toBase58();
const NONCE = '0x' + 'd'.repeat(64);
const hex = (b: Uint8Array): string => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');

const intentSolToBase = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({ sourceChain: 'solana', sourceAsset: { chain: 'solana', address: SOLANA_USDC }, sourceAmount: 100_000_000n, destinationChain: 'base', destinationAsset: { chain: 'base', address: CCTP_USDC.base! }, sender: SOL_USER, recipient: EVM_USER, ...over });
const intentBaseToSol = (over: Partial<SettlementIntent> = {}): SettlementIntent => ({ sourceChain: 'base', sourceAsset: { chain: 'base', address: CCTP_USDC.base! }, sourceAmount: 100_000_000n, destinationChain: 'solana', destinationAsset: { chain: 'solana', address: SOLANA_USDC }, sender: EVM_USER, recipient: SOL_USER, ...over });

/** A message as Circle would attest it for a burn on an EVM chain paying `account` on Solana. */
function craftMessage(o: { account: string; amount: bigint; recipientProgram?: string; destinationDomain?: number; nonce?: string }): string {
  const msg = new Uint8Array(148 + 228);
  const dv = new DataView(msg.buffer);
  dv.setUint32(0, 1, false);
  dv.setUint32(4, 6, false); // source: Base
  dv.setUint32(8, o.destinationDomain ?? 5, false);
  msg.set(Buffer.from((o.nonce ?? NONCE).slice(2), 'hex'), 12);
  msg.set(new web3.PublicKey(o.recipientProgram ?? TOKEN_MESSENGER_MINTER_V2).toBytes(), 76);
  const body = 148;
  dv.setUint32(body, 1, false);
  msg.set(evmAddressBytes32(CCTP_USDC.base!), body + 4); // burn token (Base USDC)
  msg.set(new web3.PublicKey(o.account).toBytes(), body + 36);
  for (let i = 0; i < 8; i++) msg[body + 68 + 31 - i] = Number((o.amount >> BigInt(8 * i)) & 0xffn);
  return hex(msg);
}

function world(w: { attested?: boolean; message?: string; solUsedNonce?: boolean; evmNonceUsed?: boolean; limit?: bigint; irisDown?: boolean } = {}) {
  const addr = cctpSolanaAddresses(web3);
  const localToken = new Uint8Array(130);
  new DataView(localToken.buffer).setBigUint64(72, w.limit ?? 5_000_000_000n, true);
  const messenger = new Uint8Array(177);
  messenger.set(new web3.PublicKey(FEE_RECIPIENT).toBytes(), 109);
  const b64 = (b: Uint8Array): [string, string] => [Buffer.from(b).toString('base64'), 'base64'];
  const accounts = new Map<string, Uint8Array>([[addr.localToken, localToken], [addr.tokenMessenger, messenger]]);
  if (w.solUsedNonce) accounts.set(usedNonceAddress(web3, Uint8Array.from(Buffer.from(NONCE.slice(2), 'hex'))), new Uint8Array(9));
  const rpcCalls: string[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    rpcCalls.push(method);
    if (method === 'getLatestBlockhash') return { value: { blockhash: web3.Keypair.generate().publicKey.toBase58() } };
    if (method === 'getAccountInfo') {
      const d = accounts.get(String(params[0]));
      return { value: d ? { data: b64(d) } : null };
    }
    throw new Error('unexpected rpc ' + method);
  }) as never;
  const read = (): ((m: string, p: unknown[]) => Promise<unknown>) => async (_m, params) => {
    const data = String((params[0] as { data: string }).data);
    const sel = (sig: string, args: unknown[]): string => encodeFunction(sig, args).slice(0, 10);
    if (data.startsWith(sel('burnLimitsPerMessage(address)', [CCTP_USDC.ethereum]))) return word(1_000_000_000_000n);
    if (data.startsWith(sel('allowance(address,address)', [EVM_USER, CCTP_CONTRACTS.tokenMessenger]))) return word(0n);
    if (data.startsWith(sel('usedNonces(bytes32)', ['0x' + '0'.repeat(64)]))) return word(w.evmNonceUsed ? 1n : 0n);
    throw new Error('unexpected read');
  };
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status });
  const fetchImpl = (async (url: string) => {
    if (w.irisDown) throw new Error('offline');
    const u = String(url);
    if (u.includes('/fees/')) return json([{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]);
    if (u.includes('/allowance')) return json({ allowance: 1_000_000 });
    if (u.includes('/messages/')) return w.attested ? json({ messages: [{ status: 'complete', message: w.message ?? '0xabcd', attestation: '0x1234', eventNonce: NONCE }] }) : json({ messages: [{ status: 'pending_confirmations', message: '0x', attestation: 'PENDING', eventNonce: NONCE }] });
    return json({}, 404);
  }) as unknown as typeof fetch;
  const provider = (mode: 'fast' | 'standard' = 'standard', withSolana = true) => new CctpSettlementProvider({ mode, read: read as never, fetchImpl, now: () => NOW, ...(withSolana ? { solana: { rpc, web3: async () => web3 } } : {}) });
  return { provider, rpcCalls, accounts };
}

describe('Solana to EVM', () => {
  it('is offered when the Solana tools are supplied, with no approval step, and refused with a reason when they are not', async () => {
    const x = world();
    const q = await x.provider().getQuote(intentSolToBase());
    expect(q.route.steps.map((s) => s.id)).toEqual(['burn', 'attest', 'mint']);
    expect(q.requirements.join(' ')).not.toMatch(/approval/);
    const without = await x.provider('standard', false).supports(intentSolToBase());
    expect(without).toEqual({ supported: false, reason: expect.stringMatching(/Solana side.*not available in this context/) });
  });

  it('reads the burn limit from the program\'s own account and refuses an amount above it', async () => {
    const x = world({ limit: 50_000_000n });
    await expect(x.provider().getQuote(intentSolToBase())).rejects.toThrow(/largest single/);
    const quote = await world({ limit: 5_000_000_000n }).provider().getQuote(intentSolToBase());
    expect(quote.limits.max).toBe(5_000_000_000n);
  });

  it('builds one burn transaction: paid by the sender, calling only the USDC program, already signed by the throwaway key, naming the recipient', async () => {
    const p = world().provider();
    const q = await p.getQuote(intentSolToBase());
    const [tx] = await p.buildSettlement(q);
    expect(tx!.stepId).toBe('burn');
    const unsigned = tx!.unsigned as { kind: 'solana'; transaction: web3.Transaction };
    expect(unsigned.kind).toBe('solana');
    const t = unsigned.transaction;
    expect(t.feePayer!.toBase58()).toBe(SOL_USER);
    expect(t.instructions.map((i) => i.programId.toBase58())).toEqual(['ComputeBudget111111111111111111111111111111', TOKEN_MESSENGER_MINTER_V2]);
    expect(t.signatures.filter((s) => s.signature !== null)).toHaveLength(1); // only the throwaway key; the wallet signs the rest
    const data = Buffer.from(t.instructions[1]!.data);
    expect(data.subarray(8 + 8 + 4, 8 + 8 + 4 + 32).toString('hex')).toBe(Buffer.from(evmAddressBytes32(EVM_USER)).toString('hex'));
    expect(SOLANA_CCTP_PROGRAMS).toContain(t.instructions[1]!.programId.toBase58());
  });

  it('declares only the CCTP programs for Solana, and nothing for Solana when the tools are absent', () => {
    expect(world().provider().allowedDestinations('solana')).toEqual(SOLANA_CCTP_PROGRAMS);
    expect(world().provider('standard', false).allowedDestinations('solana')).toEqual([]);
  });

  it('follows a Solana burn by its signature, and is not complete until the EVM side has used the message', async () => {
    const sig = '5'.repeat(88);
    const p0 = world({ attested: false }).provider();
    const q = await p0.getQuote(intentSolToBase());
    const id = p0.executionIdFor('solana', sig);
    expect((await p0.trackSettlement(id, q)).code).toBe('source-confirmed');
    const p1 = world({ attested: true }).provider();
    expect((await p1.trackSettlement(id, q)).code).toBe('ready-to-complete');
    const p2 = world({ attested: true, evmNonceUsed: true }).provider();
    expect((await p2.trackSettlement(id, q)).code).toBe('completed');
    expect((await p1.trackSettlement(p1.executionIdFor('solana', '0x' + '1'.repeat(64)), q)).code).toBe('unknown'); // an EVM-looking id is not a Solana signature
  });
});

describe('EVM to Solana', () => {
  it('names the recipient\'s USDC token account in the burn, not their wallet', async () => {
    const p = world().provider();
    const q = await p.getQuote(intentBaseToSol());
    const burn = (await p.buildSettlement(q)).find((t) => t.stepId === 'burn')!;
    const data = (burn.unsigned as { tx: { data: string } }).tx.data;
    const ata = new web3.PublicKey(ataAddress(web3, SOL_USER, SOLANA_USDC, TOKEN_PROGRAM_ID));
    expect(data.toLowerCase()).toContain(Buffer.from(ata.toBytes()).toString('hex'));
    expect(data.toLowerCase()).not.toContain(Buffer.from(new web3.PublicKey(SOL_USER).toBytes()).toString('hex'));
  });

  it('builds the Solana claim from Circle\'s attested message: payer is the recipient, programs are the declared ones, accounts include the recipient\'s own USDC account', async () => {
    const ata = ataAddress(web3, SOL_USER, SOLANA_USDC, TOKEN_PROGRAM_ID);
    const x = world({ attested: true, message: craftMessage({ account: ata, amount: 100_000_000n }) });
    const p = x.provider();
    const q = await p.getQuote(intentBaseToSol());
    const id = p.executionIdFor('base', '0x' + '1'.repeat(64));
    const tx = (await p.buildDestination(q, id))!;
    expect(tx.chain).toBe('solana');
    const t = (tx.unsigned as { transaction: web3.Transaction }).transaction;
    expect(t.feePayer!.toBase58()).toBe(SOL_USER);
    const programs = t.instructions.map((i) => i.programId.toBase58());
    expect(programs.every((pid) => SOLANA_CCTP_PROGRAMS.includes(pid))).toBe(true);
    expect(programs).toContain(MESSAGE_TRANSMITTER_V2);
    const claim = t.instructions.find((i) => i.programId.toBase58() === MESSAGE_TRANSMITTER_V2)!;
    expect(claim.keys.map((k) => k.pubkey.toBase58())).toContain(ata);
    expect(claim.keys.map((k) => k.pubkey.toBase58())).toContain(ataAddress(web3, FEE_RECIPIENT, SOLANA_USDC, TOKEN_PROGRAM_ID));
  });

  it('refuses a message that pays another account, a different amount, another domain or another program, and sends nothing twice', async () => {
    const other = web3.Keypair.generate().publicKey.toBase58();
    const ata = ataAddress(web3, SOL_USER, SOLANA_USDC, TOKEN_PROGRAM_ID);
    const build = async (message: string, extra: Parameters<typeof world>[0] = {}) => {
      const p = world({ attested: true, message, ...extra }).provider();
      const q = await p.getQuote(intentBaseToSol());
      return p.buildDestination(q, p.executionIdFor('base', '0x' + '1'.repeat(64)));
    };
    await expect(build(craftMessage({ account: ataAddress(web3, other, SOLANA_USDC, TOKEN_PROGRAM_ID), amount: 100_000_000n }))).rejects.toThrow(/different account/);
    await expect(build(craftMessage({ account: ata, amount: 99_000_000n }))).rejects.toThrow(/different amount/);
    await expect(build(craftMessage({ account: ata, amount: 100_000_000n, destinationDomain: 6 }))).rejects.toThrow(/not for Solana/);
    await expect(build(craftMessage({ account: ata, amount: 100_000_000n, recipientProgram: other }))).rejects.toThrow(/not addressed to the USDC program/);
    expect(await build(craftMessage({ account: ata, amount: 100_000_000n }), { solUsedNonce: true })).toBeNull(); // already claimed: nothing to send
  });

  it('is complete only when the nonce account exists on Solana', async () => {
    const ata = ataAddress(web3, SOL_USER, SOLANA_USDC, TOKEN_PROGRAM_ID);
    const message = craftMessage({ account: ata, amount: 100_000_000n });
    const pending = world({ attested: true, message }).provider();
    const q = await pending.getQuote(intentBaseToSol());
    const id = pending.executionIdFor('base', '0x' + '1'.repeat(64));
    expect((await pending.trackSettlement(id, q)).code).toBe('ready-to-complete');
    expect((await world({ attested: true, message, solUsedNonce: true }).provider().trackSettlement(id, q)).code).toBe('completed');
  });
});
