/**
 * Live, read-only checks of the Solana CCTP builders against the real programs on mainnet. Nothing is signed or sent: the
 * burn is SIMULATED from the account of a real USDC holder (signature checking off), which makes the real program run
 * every account and layout check Aretia's bytes must satisfy.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { ataAddress, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { buildDepositForBurn, buildReceiveMessage, cctpSolanaAddresses, evmAddressBytes32, MESSAGE_TRANSMITTER_V2, readBurnLimit, readFeeRecipient, readLocalTokenMint, remoteTokenMessengerAddress, SOLANA_USDC, tokenPairAddress, TOKEN_MESSENGER_MINTER_V2 } from './cctpSolana.js';
import type { SolRpc } from '../solana/raydiumCpmm.js';

const URLS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const rpc: SolRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  let last: unknown;
  for (const url of URLS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(body.error.message);
      return body.result as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
};
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58decode(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = ALPHABET.indexOf(ch);
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
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return bytes.reverse();
}
const b64 = (b64s: string): Uint8Array => Uint8Array.from(Buffer.from(b64s, 'base64'));
async function account(address: string): Promise<{ owner: string; data: Uint8Array } | null> {
  const r = await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64' }]);
  return r.value ? { owner: r.value.owner, data: b64(r.value.data[0]) } : null;
}

describe('Solana CCTP, live', () => {
  it('the derived accounts are the real accounts, owned by the real programs', async () => {
    const a = cctpSolanaAddresses(web3);
    expect((await account(a.messageTransmitter))!.owner).toBe(MESSAGE_TRANSMITTER_V2);
    for (const k of [a.tokenMessenger, a.tokenMinter, a.localToken]) expect((await account(k))!.owner, k).toBe(TOKEN_MESSENGER_MINTER_V2);
    expect((await account(a.custody))!.owner).toBe(TOKEN_PROGRAM_ID);
    for (const d of [0, 2, 3, 6, 7]) expect((await account(remoteTokenMessengerAddress(web3, d)))!.owner, `domain ${d}`).toBe(TOKEN_MESSENGER_MINTER_V2);
  }, 60_000);

  it('reads the burn limit, the fee recipient and the mint out of the real accounts with the layouts the builders assume', async () => {
    const a = cctpSolanaAddresses(web3);
    const lt = (await account(a.localToken))!.data;
    expect(readLocalTokenMint(web3, lt)).toBe(SOLANA_USDC);
    expect(readBurnLimit(lt)).toBeGreaterThan(1_000_000_000n); // thousands of USDC at least
    const fee = readFeeRecipient(web3, (await account(a.tokenMessenger))!.data);
    expect(new web3.PublicKey(fee).toBase58()).toBe(fee);
    // The fee recipient's USDC account really exists, which is what the claim needs.
    expect(await account(ataAddress(web3, fee, SOLANA_USDC, TOKEN_PROGRAM_ID))).not.toBeNull();
  }, 60_000);

  it('the token pair for Ethereum USDC is the real account', async () => {
    const ethUsdc = evmAddressBytes32('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect((await account(tokenPairAddress(web3, 0, ethUsdc)))!.owner).toBe(TOKEN_MESSENGER_MINTER_V2);
  }, 60_000);

  it('the burn runs on the real program when simulated from a real USDC holder (a wrong account or layout would fail here)', async () => {
    // Well-known exchange wallets that hold USDC in their ordinary token accounts. The first one that does is used.
    const candidates = ['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'];
    let owner: string | null = null;
    for (const c of candidates) {
      const bal = await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [ataAddress(web3, c, SOLANA_USDC, TOKEN_PROGRAM_ID)]).catch(() => null);
      if (bal && BigInt(bal.value.amount) > 10_000_000n) {
        owner = c;
        break;
      }
    }
    expect(owner, 'a USDC holder with an associated token account').not.toBeNull();
    const { blockhash } = (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const tx = buildDepositForBurn(web3, { owner: owner!, amount: 1_000_000n, destinationDomain: 6, mintRecipient: evmAddressBytes32('0x' + 'ab'.repeat(20)), maxFee: 1000n, minFinalityThreshold: 1000, recentBlockhash: blockhash, messageEventKey: web3.Keypair.generate() });
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const sim = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    const logs = (sim.value.logs ?? []).join('\n');
    // The program must get as far as burning and sending the message; it must not fail on accounts or arguments.
    expect(logs, logs).toMatch(/Instruction: DepositForBurn/);
    expect(sim.value.err, logs).toBeNull();
    expect(sim.value.unitsConsumed ?? 0).toBeGreaterThan(20_000);
    expect(sim.value.unitsConsumed ?? 0).toBeLessThan(250_000);
  }, 120_000);

  it('the claim, rebuilt from the message of a real past claim, has exactly the same accounts, in the same order, as the real transaction', async () => {
    const sigs = await rpc<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [MESSAGE_TRANSMITTER_V2, { limit: 40 }]);
    const fee = readFeeRecipient(web3, (await account(cctpSolanaAddresses(web3).tokenMessenger))!.data);
    let compared = 0;
    for (const s of sigs.filter((x) => !x.err)) {
      const tx = await rpc<{ meta?: { loadedAddresses?: { writable: string[]; readonly: string[] } }; transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!tx) continue;
      // Many real claims use address lookup tables, so the full key list is the static keys plus the loaded ones.
      const m = { ...tx.transaction.message, accountKeys: [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])] };
      const ix = m.instructions.find((i) => m.accountKeys[i.programIdIndex] === MESSAGE_TRANSMITTER_V2 && Buffer.from(bs58decode(i.data)).subarray(0, 8).toString('hex') === '26907fe11fe1ee19');
      if (!ix) continue;
      const raw = Buffer.from(bs58decode(ix.data));
      const mlen = raw.readUInt32LE(8);
      const message = '0x' + raw.subarray(12, 12 + mlen).toString('hex');
      const alen = raw.readUInt32LE(12 + mlen);
      const attestation = '0x' + raw.subarray(16 + mlen, 16 + mlen + alen).toString('hex');
      // Only transfers into Solana USDC through the Token Messenger Minter, which is what Aretia builds.
      let built: ReturnType<typeof buildReceiveMessage>;
      try {
        // The message names a token account; its owner is the wallet the claim is for.
        const acct = await rpc<{ value: { data: { parsed?: { info?: { owner?: string } } } } | null }>('getAccountInfo', [m.accountKeys[ix.accounts[15]!]!, { encoding: 'jsonParsed' }]);
        const recipientOwner = acct.value?.data.parsed?.info?.owner;
        if (!recipientOwner) continue;
        built = buildReceiveMessage(web3, { payer: m.accountKeys[ix.accounts[0]!]!, recipientOwner, message, attestation, localDomain: 5, feeRecipient: fee, recentBlockhash: '11111111111111111111111111111111' });
      } catch {
        continue;
      }
      const mine = built.transaction.instructions.find((i) => i.programId.toBase58() === MESSAGE_TRANSMITTER_V2)!;
      expect(mine.keys.map((k) => k.pubkey.toBase58())).toEqual(ix.accounts.map((i) => m.accountKeys[i]));
      expect(Buffer.from(mine.data).toString('hex')).toBe(raw.toString('hex'));
      compared++;
      if (compared >= 2) break;
    }
    expect(compared, 'at least one real USDC claim into Solana to compare with').toBeGreaterThan(0);
  }, 180_000);

  it('refuses to build a burn or a claim from bad input', () => {
    const key = web3.Keypair.generate();
    const base = { owner: web3.Keypair.generate().publicKey.toBase58(), destinationDomain: 6, mintRecipient: evmAddressBytes32('0x' + 'ab'.repeat(20)), minFinalityThreshold: 1000, recentBlockhash: '11111111111111111111111111111111', messageEventKey: key };
    expect(() => buildDepositForBurn(web3, { ...base, amount: 10n, maxFee: 10n })).toThrow(/fee must be less/);
    expect(() => buildDepositForBurn(web3, { ...base, amount: 10n, maxFee: 1n, mintRecipient: new Uint8Array(32) })).toThrow(/recipient is not valid/);
    expect(() => buildReceiveMessage(web3, { payer: base.owner, recipientOwner: base.owner, message: '0x00', attestation: '0x00', localDomain: 5, feeRecipient: base.owner, recentBlockhash: base.recentBlockhash })).toThrow(/too short/);
  });
});
