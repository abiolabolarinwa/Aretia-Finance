// Aretia Finance -- act-presale client
// ---------------------------------------------------------------------
// Same approach as the act-staking client: hand-rolled instruction
// builders matching programs/act-presale/programs/act-presale/src/lib.rs
// exactly, reusing the discriminator/PDA/balance-delta patterns already
// proven correct against real devnet transactions in this program's own
// scripts (program/act-presale/scripts/). Does not depend on the IDL at
// ../idl/act_presale.json at runtime.
//
// Devnet-verified only. Not yet deployed to mainnet -- see
// PRESALE_DESIGN.md at the repo root before using this against anything
// but devnet.

import {
  PublicKey,
  SystemProgram,
  Connection,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

/** Devnet program ID -- see PRESALE_DESIGN.md for mainnet deployment status. */
export const ACT_PRESALE_PROGRAM_ID = new PublicKey(
  "5hmgnujNib14NDkEgRsLpY3H8SBDCsLryiymNKY6fWku"
);

export const PRESALE_STATUS_ACTIVE = 0;
export const PRESALE_STATUS_FINALIZED = 1;
export const PRESALE_STATUS_REFUNDING = 2;

export interface PresaleConfig {
  authority: PublicKey;
  actMint: PublicKey;
  acceptedMints: [PublicKey, PublicKey];
  acceptedVaults: [PublicKey, PublicKey];
  treasuryPaymentAccounts: [PublicKey, PublicKey];
  actVault: PublicKey;
  treasuryActAccount: PublicKey;
  treasurySolAccount: PublicKey;
  priceMicroPaymentPerAct: bigint;
  startTs: bigint;
  endTs: bigint;
  tgeTs: bigint;
  tgeBps: number;
  vestingDurationSeconds: bigint;
  hardCapPayment: bigint;
  softCapPayment: bigint;
  minBuyPayment: bigint;
  maxBuyPayment: bigint;
  totalRaisedPayment: bigint;
  totalActSoldNet: bigint;
  totalActClaimedNet: bigint;
  actReserveNet: bigint;
  status: number;
  paused: boolean;
  bump: number;
  vaultAuthorityBump: number;
}

export interface BuyerAccount {
  owner: PublicKey;
  paymentContributed: [bigint, bigint];
  actAllocatedNet: bigint;
  actClaimedNet: bigint;
  refunded: [boolean, boolean];
  solLamportsContributed: bigint;
  solUsdValueContributed: bigint;
  solRefunded: boolean;
  bump: number;
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function i64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

export class ActPresaleClient {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey = ACT_PRESALE_PROGRAM_ID
  ) {}

  // ---- PDAs ----

  configPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("presale_config")], this.programId);
  }

  vaultAuthorityPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], this.programId);
  }

  buyerAccountPda(buyer: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("presale_buyer"), buyer.toBuffer()],
      this.programId
    );
  }

  // ---- Account decoding ----
  // Field order/widths must match PresaleConfig/BuyerAccount in lib.rs exactly.

  static decodePresaleConfig(data: Buffer): PresaleConfig {
    let o = 8;
    const readPk = () => {
      const pk = new PublicKey(data.subarray(o, o + 32));
      o += 32;
      return pk;
    };
    const readU64 = () => {
      const v = data.readBigUInt64LE(o);
      o += 8;
      return v;
    };
    const readI64 = () => {
      const v = data.readBigInt64LE(o);
      o += 8;
      return v;
    };
    const authority = readPk();
    const actMint = readPk();
    const acceptedMints: [PublicKey, PublicKey] = [readPk(), readPk()];
    const acceptedVaults: [PublicKey, PublicKey] = [readPk(), readPk()];
    const treasuryPaymentAccounts: [PublicKey, PublicKey] = [readPk(), readPk()];
    const actVault = readPk();
    const treasuryActAccount = readPk();
    const treasurySolAccount = readPk();
    const priceMicroPaymentPerAct = readU64();
    const startTs = readI64();
    const endTs = readI64();
    const tgeTs = readI64();
    const tgeBps = data.readUInt16LE(o);
    o += 2;
    const vestingDurationSeconds = readI64();
    const hardCapPayment = readU64();
    const softCapPayment = readU64();
    const minBuyPayment = readU64();
    const maxBuyPayment = readU64();
    const totalRaisedPayment = readU64();
    const totalActSoldNet = readU64();
    const totalActClaimedNet = readU64();
    const actReserveNet = readU64();
    const status = data.readUInt8(o);
    o += 1;
    const paused = data.readUInt8(o) !== 0;
    o += 1;
    const bump = data.readUInt8(o);
    o += 1;
    const vaultAuthorityBump = data.readUInt8(o);
    return {
      authority,
      actMint,
      acceptedMints,
      acceptedVaults,
      treasuryPaymentAccounts,
      actVault,
      treasuryActAccount,
      treasurySolAccount,
      priceMicroPaymentPerAct,
      startTs,
      endTs,
      tgeTs,
      tgeBps,
      vestingDurationSeconds,
      hardCapPayment,
      softCapPayment,
      minBuyPayment,
      maxBuyPayment,
      totalRaisedPayment,
      totalActSoldNet,
      totalActClaimedNet,
      actReserveNet,
      status,
      paused,
      bump,
      vaultAuthorityBump,
    };
  }

  static decodeBuyerAccount(data: Buffer): BuyerAccount {
    let o = 8;
    const owner = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    const paymentContributed: [bigint, bigint] = [data.readBigUInt64LE(o), data.readBigUInt64LE(o + 8)];
    o += 16;
    const actAllocatedNet = data.readBigUInt64LE(o);
    o += 8;
    const actClaimedNet = data.readBigUInt64LE(o);
    o += 8;
    const refunded: [boolean, boolean] = [data.readUInt8(o) !== 0, data.readUInt8(o + 1) !== 0];
    o += 2;
    const solLamportsContributed = data.readBigUInt64LE(o);
    o += 8;
    const solUsdValueContributed = data.readBigUInt64LE(o);
    o += 8;
    const solRefunded = data.readUInt8(o) !== 0;
    o += 1;
    const bump = data.readUInt8(o);
    return {
      owner,
      paymentContributed,
      actAllocatedNet,
      actClaimedNet,
      refunded,
      solLamportsContributed,
      solUsdValueContributed,
      solRefunded,
      bump,
    };
  }

  async fetchConfig(): Promise<PresaleConfig | null> {
    const [pda] = this.configPda();
    const info = await this.connection.getAccountInfo(pda);
    return info ? ActPresaleClient.decodePresaleConfig(info.data) : null;
  }

  async fetchBuyerAccount(buyer: PublicKey): Promise<BuyerAccount | null> {
    const [pda] = this.buyerAccountPda(buyer);
    const info = await this.connection.getAccountInfo(pda);
    return info ? ActPresaleClient.decodeBuyerAccount(info.data) : null;
  }

  // ---- Instruction builders ----
  // Each takes the exact accounts the on-chain program expects, in order.
  // See sdk/idl/act_presale.json or lib.rs for the full account list per
  // instruction if you need to double-check before wiring up a caller.

  ixBuy(
    buyer: PublicKey,
    paymentMint: PublicKey,
    paymentVault: PublicKey,
    buyerPaymentAccount: PublicKey,
    paymentTokenProgram: PublicKey,
    paymentAmount: bigint | number
  ): TransactionInstruction {
    const [config] = this.configPda();
    const [buyerAccount] = this.buyerAccountPda(buyer);
    const data = Buffer.concat([discriminator("buy"), u64le(paymentAmount)]);
    const keys = [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: buyerAccount, isSigner: false, isWritable: true },
      { pubkey: paymentMint, isSigner: false, isWritable: false },
      { pubkey: paymentVault, isSigner: false, isWritable: true },
      { pubkey: buyerPaymentAccount, isSigner: false, isWritable: true },
      { pubkey: paymentTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixBuyWithSol(buyer: PublicKey, priceUpdate: PublicKey, lamports: bigint | number): TransactionInstruction {
    const [config] = this.configPda();
    const [buyerAccount] = this.buyerAccountPda(buyer);
    const [vaultAuthority] = this.vaultAuthorityPda();
    const data = Buffer.concat([discriminator("buy_with_sol"), u64le(lamports)]);
    const keys = [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: buyerAccount, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: priceUpdate, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixRefundSol(buyer: PublicKey): TransactionInstruction {
    const [config] = this.configPda();
    const [buyerAccount] = this.buyerAccountPda(buyer);
    const [vaultAuthority] = this.vaultAuthorityPda();
    const data = discriminator("refund_sol");
    const keys = [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: buyerAccount, isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: false, isWritable: false }, // `owner` check account -- same key as buyer
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixRefund(
    buyer: PublicKey,
    paymentMint: PublicKey,
    paymentVault: PublicKey,
    buyerPaymentAccount: PublicKey,
    paymentTokenProgram: PublicKey
  ): TransactionInstruction {
    const [config] = this.configPda();
    const [buyerAccount] = this.buyerAccountPda(buyer);
    const [vaultAuthority] = this.vaultAuthorityPda();
    const data = discriminator("refund");
    const keys = [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: buyerAccount, isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: paymentMint, isSigner: false, isWritable: false },
      { pubkey: paymentVault, isSigner: false, isWritable: true },
      { pubkey: buyerPaymentAccount, isSigner: false, isWritable: true },
      { pubkey: paymentTokenProgram, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixClaim(
    buyer: PublicKey,
    actMint: PublicKey,
    actVault: PublicKey,
    buyerActAccount: PublicKey,
    tokenProgram: PublicKey
  ): TransactionInstruction {
    const [config] = this.configPda();
    const [buyerAccount] = this.buyerAccountPda(buyer);
    const [vaultAuthority] = this.vaultAuthorityPda();
    const data = discriminator("claim");
    const keys = [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: buyerAccount, isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: actMint, isSigner: false, isWritable: false },
      { pubkey: actVault, isSigner: false, isWritable: true },
      { pubkey: buyerActAccount, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixSetPaused(authority: PublicKey, paused: boolean): TransactionInstruction {
    const [config] = this.configPda();
    const data = Buffer.concat([discriminator("set_paused"), Buffer.from([paused ? 1 : 0])]);
    const keys = [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixSetConfigAuthority(authority: PublicKey, newAuthority: PublicKey): TransactionInstruction {
    const [config] = this.configPda();
    const data = Buffer.concat([discriminator("set_config_authority"), newAuthority.toBuffer()]);
    const keys = [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  /**
   * Authority-only instructions (initialize_presale, initialize_payment_currency,
   * fund_act_reserve, finalize, sweep_unsold_act) are deliberately not wrapped
   * here with convenience builders -- they're one-time or low-frequency admin
   * operations run directly against the Squads treasury multisig (see
   * PRESALE_DESIGN.md), not something a third-party integration typically
   * needs to construct. Build them the same way this program's own
   * scripts/exercise-devnet-*.mjs do if you need them: discriminator +
   * borsh-encoded args, same convention as every instruction above.
   */
}

// Re-exported helpers for callers who need the raw building blocks
// (e.g. constructing initialize_presale/finalize/etc. themselves).
export { discriminator as computeDiscriminator, u64le, u32le, u16le, i64le };
