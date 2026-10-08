/**
 * The Solana side of Circle's CCTP V2: building the two transactions Aretia needs, with every address and byte layout
 * taken from Circle's published program source (circlefin/solana-cctp-contracts, programs/v2) and checked against the
 * deployed programs on mainnet by `cctp.live.ts` (the account derivations are matched to real on-chain accounts, and
 * the burn is simulated against the real program).
 *
 *   depositForBurn   Solana to anywhere: burns the owner's USDC (the owner signs, plus a one-time throwaway key that
 *                    only names where the message event is stored)
 *   receiveMessage   anywhere to Solana: mints the attested USDC into the recipient's token account (creating it first
 *                    if it does not exist), claimable by anyone but always paid to the recipient named in the burn
 *
 * Nothing here signs or sends. Functions take the `@solana/web3.js` module as an argument, as the other Solana builders
 * do, so the library loads only when needed.
 */
import type * as Web3 from '@solana/web3.js';
import { SwingsError } from '../core/types.js';
import { ataAddress, createAtaIdempotentInstruction, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';

export const TOKEN_MESSENGER_MINTER_V2 = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
export const MESSAGE_TRANSMITTER_V2 = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

/** The only programs a CCTP transaction on Solana may call at the top level. The settlement provider declares these. */
export const SOLANA_CCTP_PROGRAMS: readonly string[] = [TOKEN_MESSENGER_MINTER_V2, MESSAGE_TRANSMITTER_V2, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM];

/** Anchor instruction discriminators: the first 8 bytes of sha256("global:<name>"), from the program source's names. */
const DISC_DEPOSIT_FOR_BURN = Uint8Array.from([0xd7, 0x3c, 0x3d, 0x2e, 0x72, 0x37, 0x80, 0xb0]);
const DISC_RECEIVE_MESSAGE = Uint8Array.from([0x26, 0x90, 0x7f, 0xe1, 0x1f, 0xe1, 0xee, 0x19]);

// Message layout (CCTP V2): version(4) sourceDomain(4) destinationDomain(4) nonce(32) sender(32) recipient(32)
// destinationCaller(32) minFinalityThreshold(4) finalityThresholdExecuted(4) body...
const NONCE_AT = 12;
const SENDER_AT = 44;
const RECIPIENT_AT = 76;
const DOMAIN_AT = 4;
const DEST_DOMAIN_AT = 8;
const BODY_AT = 148;
// Burn message body (V2): version(4) burnToken(32) mintRecipient(32) amount(32) messageSender(32) maxFee(32) feeExecuted(32) expirationBlock(32) hook...
const BURN_TOKEN_AT = 4;
const MINT_RECIPIENT_AT = 36;
const AMOUNT_AT = 68;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const u32le = (n: number): Uint8Array => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
function u64le(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 64n) throw new SwingsError('invalid', 'An amount does not fit in 64 bits.');
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
}
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new SwingsError('invalid', 'That is not valid hexadecimal data.');
  return Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
};
const toHex = (b: Uint8Array): string => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** An EVM address as the 32-byte value CCTP uses (left-padded with zeros). */
export function evmAddressBytes32(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new SwingsError('invalid', 'That is not a valid EVM address.');
  return concat(new Uint8Array(12), hexToBytes(address));
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** True for a base58 string that decodes to exactly 32 bytes: a Solana address. */
export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  const bytes: number[] = [];
  for (const ch of value) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return false;
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
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return bytes.length === 32;
}

// ------------------------------------------------------------------ addresses

export interface CctpSolanaAddresses {
  messageTransmitter: string;
  tokenMessenger: string;
  tokenMinter: string;
  senderAuthority: string;
  localToken: string;
  custody: string;
  tmmEventAuthority: string;
  mtEventAuthority: string;
}

/** Every fixed account the two programs use for USDC. Derived, then proven against mainnet by the live test. */
export function cctpSolanaAddresses(web3: typeof Web3, mint: string = SOLANA_USDC): CctpSolanaAddresses {
  const tmm = new web3.PublicKey(TOKEN_MESSENGER_MINTER_V2);
  const mt = new web3.PublicKey(MESSAGE_TRANSMITTER_V2);
  const m = new web3.PublicKey(mint).toBytes();
  const d = (seeds: Uint8Array[], program: Web3.PublicKey): string => web3.PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  return {
    messageTransmitter: d([enc('message_transmitter')], mt),
    tokenMessenger: d([enc('token_messenger')], tmm),
    tokenMinter: d([enc('token_minter')], tmm),
    senderAuthority: d([enc('sender_authority')], tmm),
    localToken: d([enc('local_token'), m], tmm),
    custody: d([enc('custody'), m], tmm),
    tmmEventAuthority: d([enc('__event_authority')], tmm),
    mtEventAuthority: d([enc('__event_authority')], mt),
  };
}

export const remoteTokenMessengerAddress = (web3: typeof Web3, domain: number): string => web3.PublicKey.findProgramAddressSync([enc('remote_token_messenger'), enc(String(domain))], new web3.PublicKey(TOKEN_MESSENGER_MINTER_V2))[0].toBase58();
export const denylistAddress = (web3: typeof Web3, owner: string): string => web3.PublicKey.findProgramAddressSync([enc('denylist_account'), new web3.PublicKey(owner).toBytes()], new web3.PublicKey(TOKEN_MESSENGER_MINTER_V2))[0].toBase58();
export const tokenPairAddress = (web3: typeof Web3, remoteDomain: number, remoteToken32: Uint8Array): string => web3.PublicKey.findProgramAddressSync([enc('token_pair'), enc(String(remoteDomain)), remoteToken32], new web3.PublicKey(TOKEN_MESSENGER_MINTER_V2))[0].toBase58();
export const usedNonceAddress = (web3: typeof Web3, nonce32: Uint8Array): string => web3.PublicKey.findProgramAddressSync([enc('used_nonce'), nonce32], new web3.PublicKey(MESSAGE_TRANSMITTER_V2))[0].toBase58();
export const mtAuthorityAddress = (web3: typeof Web3): string => web3.PublicKey.findProgramAddressSync([enc('message_transmitter_authority'), new web3.PublicKey(TOKEN_MESSENGER_MINTER_V2).toBytes()], new web3.PublicKey(MESSAGE_TRANSMITTER_V2))[0].toBase58();

// ------------------------------------------------------------------ reading program state

/** Account data layouts (Anchor accounts: an 8-byte discriminator first). */
export const readBurnLimit = (localTokenData: Uint8Array): bigint => new DataView(localTokenData.buffer, localTokenData.byteOffset, localTokenData.byteLength).getBigUint64(8 + 32 + 32, true);
export const readFeeRecipient = (web3: typeof Web3, tokenMessengerData: Uint8Array): string => new web3.PublicKey(tokenMessengerData.subarray(109, 141)).toBase58();
export const readLocalTokenMint = (web3: typeof Web3, localTokenData: Uint8Array): string => new web3.PublicKey(localTokenData.subarray(8 + 32, 8 + 64)).toBase58();

// ------------------------------------------------------------------ deposit for burn

export interface BurnArgs {
  owner: string;
  amount: bigint;
  destinationDomain: number;
  /** The recipient on the destination chain, as the 32 bytes CCTP uses. For a Solana destination this is the recipient's USDC token account. */
  mintRecipient: Uint8Array;
  maxFee: bigint;
  minFinalityThreshold: number;
  recentBlockhash: string;
  /** A fresh key pair, used once, whose public key will hold the message event. Never a user key. */
  messageEventKey: Web3.Keypair;
  computeUnits?: number;
}

/**
 * The unsigned burn transaction, already signed by the throwaway message-event key. The owner's wallet still has to sign
 * (as fee payer, owner and event rent payer). The recipient is fixed inside the instruction; the wallet shows the burn.
 */
export function buildDepositForBurn(web3: typeof Web3, a: BurnArgs): Web3.Transaction {
  if (a.amount <= 0n || a.maxFee >= a.amount) throw new SwingsError('invalid', 'The fee must be less than the amount.');
  if (a.mintRecipient.length !== 32 || a.mintRecipient.every((b) => b === 0)) throw new SwingsError('invalid', 'The recipient is not valid.');
  const addr = cctpSolanaAddresses(web3);
  const owner = new web3.PublicKey(a.owner);
  const ownerUsdc = ataAddress(web3, a.owner, SOLANA_USDC, TOKEN_PROGRAM_ID);
  const key = (pubkey: string, isSigner: boolean, isWritable: boolean): Web3.AccountMeta => ({ pubkey: new web3.PublicKey(pubkey), isSigner, isWritable });
  const data = concat(DISC_DEPOSIT_FOR_BURN, u64le(a.amount), u32le(a.destinationDomain), a.mintRecipient, new Uint8Array(32), u64le(a.maxFee), u32le(a.minFinalityThreshold));
  const ix = new web3.TransactionInstruction({
    programId: new web3.PublicKey(TOKEN_MESSENGER_MINTER_V2),
    keys: [
      key(a.owner, true, false), // owner
      key(a.owner, true, true), // event rent payer
      key(addr.senderAuthority, false, false),
      key(ownerUsdc, false, true), // burn token account
      key(denylistAddress(web3, a.owner), false, false),
      key(addr.messageTransmitter, false, true),
      key(addr.tokenMessenger, false, false),
      key(remoteTokenMessengerAddress(web3, a.destinationDomain), false, false),
      key(addr.tokenMinter, false, false),
      key(addr.localToken, false, true),
      key(SOLANA_USDC, false, true), // burn token mint
      key(a.messageEventKey.publicKey.toBase58(), true, true), // message sent event data
      key(MESSAGE_TRANSMITTER_V2, false, false),
      key(TOKEN_MESSENGER_MINTER_V2, false, false),
      key(TOKEN_PROGRAM_ID, false, false),
      key(SYSTEM_PROGRAM, false, false),
      key(addr.tmmEventAuthority, false, false), // event_cpi
      key(TOKEN_MESSENGER_MINTER_V2, false, false),
    ],
    data: Buffer.from(data),
  });
  const tx = new web3.Transaction({ feePayer: owner, recentBlockhash: a.recentBlockhash });
  tx.add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: a.computeUnits ?? 250_000 }));
  tx.add(ix);
  tx.partialSign(a.messageEventKey);
  return tx;
}

// ------------------------------------------------------------------ receive message

export interface ParsedBurnMessage {
  sourceDomain: number;
  destinationDomain: number;
  nonce: Uint8Array;
  /** The sending TokenMessenger on the source chain (32 bytes). */
  sender: Uint8Array;
  /** The program that receives on Solana (must be the Token Messenger Minter). */
  recipientProgram: string;
  burnToken: Uint8Array;
  /** On Solana the burn names the recipient's USDC TOKEN ACCOUNT, not their wallet. */
  mintRecipientAccount: string;
  amount: bigint;
}

/** Reads the fields Aretia relies on out of an attested CCTP message, refusing anything malformed. */
export function parseBurnMessage(web3: typeof Web3, message: Uint8Array): ParsedBurnMessage {
  if (message.length < BODY_AT + MINT_RECIPIENT_AT + 32 + 32) throw new SwingsError('invalid', 'The attested message is too short to be a USDC transfer.');
  const dv = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const body = message.subarray(BODY_AT);
  const amountBytes = body.subarray(AMOUNT_AT, AMOUNT_AT + 32);
  if (amountBytes.subarray(0, 24).some((b) => b !== 0)) throw new SwingsError('invalid', 'The amount in the message is too large.');
  return {
    sourceDomain: dv.getUint32(DOMAIN_AT, false),
    destinationDomain: dv.getUint32(DEST_DOMAIN_AT, false),
    nonce: message.slice(NONCE_AT, SENDER_AT),
    sender: message.slice(SENDER_AT, RECIPIENT_AT),
    recipientProgram: new web3.PublicKey(message.subarray(RECIPIENT_AT, RECIPIENT_AT + 32)).toBase58(),
    burnToken: body.slice(BURN_TOKEN_AT, BURN_TOKEN_AT + 32),
    mintRecipientAccount: new web3.PublicKey(body.subarray(MINT_RECIPIENT_AT, MINT_RECIPIENT_AT + 32)).toBase58(),
    amount: new DataView(body.buffer, body.byteOffset + AMOUNT_AT + 24, 8).getBigUint64(0, false),
  };
}

export interface ReceiveArgs {
  /** Pays the network fee and any rent, and signs. Normally the recipient themselves. */
  payer: string;
  /** The wallet that owns the USDC account the message pays into. The message must name exactly that wallet's standard USDC account. */
  recipientOwner: string;
  message: string;
  attestation: string;
  /** The Solana domain id this chain has in CCTP. */
  localDomain: number;
  feeRecipient: string;
  recentBlockhash: string;
  computeUnits?: number;
}

/**
 * The unsigned claim transaction. Refuses a message that is not a USDC transfer to the Token Messenger Minter on this
 * chain, so a wrong message can never be turned into a transaction the wallet is asked to sign.
 */
export function buildReceiveMessage(web3: typeof Web3, a: ReceiveArgs): { transaction: Web3.Transaction; recipient: string; amount: bigint } {
  const msg = hexToBytes(a.message);
  const att = hexToBytes(a.attestation);
  const m = parseBurnMessage(web3, msg);
  if (m.destinationDomain !== a.localDomain) throw new SwingsError('invalid', 'This message is not for Solana.');
  if (m.recipientProgram !== TOKEN_MESSENGER_MINTER_V2) throw new SwingsError('invalid', 'This message is not addressed to the USDC program.');
  const addr = cctpSolanaAddresses(web3);
  const recipientUsdc = ataAddress(web3, a.recipientOwner, SOLANA_USDC, TOKEN_PROGRAM_ID);
  // The burn names a token account. Aretia claims only into the standard USDC account of the wallet it was asked about,
  // so USDC can never be minted into an account Aretia cannot account for.
  if (m.mintRecipientAccount !== recipientUsdc) throw new SwingsError('invalid', 'This message pays into a different account than the standard USDC account of the recipient wallet, so it will not be claimed here.');
  const feeRecipientUsdc = ataAddress(web3, a.feeRecipient, SOLANA_USDC, TOKEN_PROGRAM_ID);
  const key = (pubkey: string, isSigner: boolean, isWritable: boolean): Web3.AccountMeta => ({ pubkey: new web3.PublicKey(pubkey), isSigner, isWritable });
  const vecU8 = (b: Uint8Array): Uint8Array => concat(u32le(b.length), b);
  const data = concat(DISC_RECEIVE_MESSAGE, vecU8(msg), vecU8(att));
  const ix = new web3.TransactionInstruction({
    programId: new web3.PublicKey(MESSAGE_TRANSMITTER_V2),
    keys: [
      key(a.payer, true, true),
      key(a.payer, true, false), // caller (the message allows any caller)
      key(mtAuthorityAddress(web3), false, false),
      key(addr.messageTransmitter, false, false),
      key(usedNonceAddress(web3, m.nonce), false, true),
      key(TOKEN_MESSENGER_MINTER_V2, false, false), // receiver
      key(SYSTEM_PROGRAM, false, false),
      key(addr.mtEventAuthority, false, false), // event_cpi
      key(MESSAGE_TRANSMITTER_V2, false, false),
      // remaining accounts, in the order the Token Messenger Minter expects
      key(addr.tokenMessenger, false, false),
      key(remoteTokenMessengerAddress(web3, m.sourceDomain), false, false),
      key(addr.tokenMinter, false, false),
      key(addr.localToken, false, true),
      key(tokenPairAddress(web3, m.sourceDomain, m.burnToken), false, false),
      key(feeRecipientUsdc, false, true),
      key(recipientUsdc, false, true),
      key(addr.custody, false, true),
      key(TOKEN_PROGRAM_ID, false, false),
      key(addr.tmmEventAuthority, false, false),
      key(TOKEN_MESSENGER_MINTER_V2, false, false),
    ],
    data: Buffer.from(data),
  });
  const tx = new web3.Transaction({ feePayer: new web3.PublicKey(a.payer), recentBlockhash: a.recentBlockhash });
  tx.add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: a.computeUnits ?? 400_000 }));
  // The recipient's USDC account is created first if it is missing (a no-op if it exists), paid for by the payer.
  tx.add(createAtaIdempotentInstruction(web3, a.payer, recipientUsdc, a.recipientOwner, SOLANA_USDC, TOKEN_PROGRAM_ID));
  tx.add(ix);
  return { transaction: tx, recipient: a.recipientOwner, amount: m.amount };
}

/** Hex of a message's nonce (the 32 bytes the source chain's event also carries), for matching against Circle's service. */
export const nonceHex = (message: string): string => toHex(hexToBytes(message).subarray(NONCE_AT, SENDER_AT));
