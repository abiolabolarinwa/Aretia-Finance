// Aretia Finance -- act-staking client
// ---------------------------------------------------------------------
// Hand-rolled, not generated from the IDL at runtime: this wraps exactly
// the same discriminator/PDA/instruction-building logic already proven
// correct against real devnet transactions throughout this program's own
// test scripts (see ../../../program/act-staking/scripts/ and
// tests/full-suite.mjs), just packaged as a reusable client instead of a
// one-off script. The IDL at ../idl/act_staking.json is a separate,
// independently useful artifact (for explorers/tooling that consume
// Anchor IDLs) -- this client does not depend on it at runtime, so a
// subtle IDL-authoring mistake can't silently break instruction-building
// here.
//
// No Anchor CLI was available when this program was built, so there is
// no generated `target/types/act_staking` to import types from either;
// the TypeScript types below are hand-written from
// program/act-staking/programs/act-staking/src/lib.rs and should be
// checked against that source, not trusted blindly.

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
  Signer,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "node:crypto";

/** Real, live mainnet program ID (also used on devnet -- see Anchor.toml). */
export const ACT_STAKING_PROGRAM_ID = new PublicKey(
  "DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH"
);

export interface StakeConfig {
  authority: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  totalStaked: bigint;
  tiers: [bigint, bigint, bigint, bigint, bigint];
  durationDays: [number, number, number, number];
  durationMultiplier: [number, number, number, number];
  paused: boolean;
  bump: number;
  vaultAuthorityBump: number;
}

export interface UserStake {
  owner: PublicKey;
  amount: bigint;
  lockDays: number;
  stakedAt: bigint;
  unlockAt: bigint;
  tier: number;
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
function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

export class ActStakingClient {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey = ACT_STAKING_PROGRAM_ID
  ) {}

  // ---- PDAs ----

  configPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("config")], this.programId);
  }

  vaultAuthorityPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], this.programId);
  }

  userStakePda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), owner.toBuffer()],
      this.programId
    );
  }

  vaultAta(mint: PublicKey): PublicKey {
    const [vaultAuthority] = this.vaultAuthorityPda();
    return getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  // ---- Account decoding ----
  // Field order and byte widths must match StakeConfig/UserStake in
  // programs/act-staking/programs/act-staking/src/lib.rs exactly.

  static decodeStakeConfig(data: Buffer): StakeConfig {
    let o = 8; // anchor account discriminator
    const authority = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    const mint = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    const vault = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    const totalStaked = data.readBigUInt64LE(o);
    o += 8;
    const tiers: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      tiers.push(data.readBigUInt64LE(o));
      o += 8;
    }
    const durationDays: number[] = [];
    for (let i = 0; i < 4; i++) {
      durationDays.push(data.readUInt16LE(o));
      o += 2;
    }
    const durationMultiplier: number[] = [];
    for (let i = 0; i < 4; i++) {
      durationMultiplier.push(data.readUInt16LE(o));
      o += 2;
    }
    const paused = data.readUInt8(o) !== 0;
    o += 1;
    const bump = data.readUInt8(o);
    o += 1;
    const vaultAuthorityBump = data.readUInt8(o);
    return {
      authority,
      mint,
      vault,
      totalStaked,
      tiers: tiers as StakeConfig["tiers"],
      durationDays: durationDays as StakeConfig["durationDays"],
      durationMultiplier: durationMultiplier as StakeConfig["durationMultiplier"],
      paused,
      bump,
      vaultAuthorityBump,
    };
  }

  static decodeUserStake(data: Buffer): UserStake {
    let o = 8;
    const owner = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    const amount = data.readBigUInt64LE(o);
    o += 8;
    const lockDays = data.readUInt16LE(o);
    o += 2;
    const stakedAt = data.readBigInt64LE(o);
    o += 8;
    const unlockAt = data.readBigInt64LE(o);
    o += 8;
    const tier = data.readUInt8(o);
    o += 1;
    const bump = data.readUInt8(o);
    return { owner, amount, lockDays, stakedAt, unlockAt, tier, bump };
  }

  async fetchStakeConfig(): Promise<StakeConfig | null> {
    const [pda] = this.configPda();
    const info = await this.connection.getAccountInfo(pda);
    return info ? ActStakingClient.decodeStakeConfig(info.data) : null;
  }

  async fetchUserStake(owner: PublicKey): Promise<UserStake | null> {
    const [pda] = this.userStakePda(owner);
    const info = await this.connection.getAccountInfo(pda);
    return info ? ActStakingClient.decodeUserStake(info.data) : null;
  }

  // ---- Instruction builders ----

  ixInitializeConfig(
    authority: PublicKey,
    mint: PublicKey,
    tiers: (bigint | number)[],
    durationDays: number[],
    durationMultiplier: number[]
  ): TransactionInstruction {
    const [config] = this.configPda();
    const [vaultAuthority] = this.vaultAuthorityPda();
    const vault = this.vaultAta(mint);
    const data = Buffer.concat([
      discriminator("initialize_config"),
      ...tiers.map((t) => u64le(t)),
      ...durationDays.map((d) => u16le(d)),
      ...durationMultiplier.map((m) => u16le(m)),
    ]);
    const keys = [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixUpdateTierConfig(
    authority: PublicKey,
    tiers: (bigint | number)[],
    durationDays: number[],
    durationMultiplier: number[]
  ): TransactionInstruction {
    const [config] = this.configPda();
    const data = Buffer.concat([
      discriminator("update_tier_config"),
      ...tiers.map((t) => u64le(t)),
      ...durationDays.map((d) => u16le(d)),
      ...durationMultiplier.map((m) => u16le(m)),
    ]);
    const keys = [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
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

  /** `amount` is gross (pre-fee) raw base units; `lockDays` must be one of the four configured options. */
  ixStake(
    owner: PublicKey,
    mint: PublicKey,
    ownerTokenAccount: PublicKey,
    amount: bigint | number,
    lockDays: number
  ): TransactionInstruction {
    const [config] = this.configPda();
    const [userStake] = this.userStakePda(owner);
    const vault = this.vaultAta(mint);
    const data = Buffer.concat([discriminator("stake"), u64le(amount), u16le(lockDays)]);
    const keys = [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: userStake, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ownerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  ixUnstake(owner: PublicKey, mint: PublicKey, ownerTokenAccount: PublicKey): TransactionInstruction {
    const [config] = this.configPda();
    const [userStake] = this.userStakePda(owner);
    const [vaultAuthority] = this.vaultAuthorityPda();
    const vault = this.vaultAta(mint);
    const data = discriminator("unstake");
    const keys = [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: userStake, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ownerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  // ---- Convenience: build + send ----

  async sendStake(
    payer: Signer,
    mint: PublicKey,
    ownerTokenAccount: PublicKey,
    amount: bigint | number,
    lockDays: number
  ): Promise<TransactionSignature> {
    const tx = new Transaction().add(this.ixStake(payer.publicKey, mint, ownerTokenAccount, amount, lockDays));
    const { sendAndConfirmTransaction } = await import("@solana/web3.js");
    return sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: "confirmed" });
  }

  async sendUnstake(payer: Signer, mint: PublicKey, ownerTokenAccount: PublicKey): Promise<TransactionSignature> {
    const tx = new Transaction().add(this.ixUnstake(payer.publicKey, mint, ownerTokenAccount));
    const { sendAndConfirmTransaction } = await import("@solana/web3.js");
    return sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: "confirmed" });
  }
}
