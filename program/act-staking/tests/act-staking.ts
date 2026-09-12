// act-staking -- local-validator test skeleton
// ---------------------------------------------------------------------
// Uses a freshly-created test mint with the SAME extension shape as real
// ACT (Token-2022 + TransferFeeConfig), NOT the real ACT mint -- this
// exercises program logic in isolation, on `anchor test`'s own throwaway
// local validator. It says nothing about mainnet ACT until this program
// is separately deployed and exercised against devnet, per
// STAKING_DESIGN.md's phased rollout.
//
// This file has not been run -- written alongside the program, both
// pending the toolchain fix described in STAKING_DESIGN.md. Treat it as
// a starting skeleton, not a verified test suite.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";
import type { ActStaking } from "../target/types/act_staking";

describe("act-staking", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ActStaking as Program<ActStaking>;
  const authority = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let userWallet: Keypair;
  let userTokenAccount: PublicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    program.programId
  );

  const DURATION_DAYS = [30, 90, 180, 365];
  const DURATION_MULTIPLIER = [100, 130, 175, 260]; // hundredths
  const TIERS = [0, 1_000_000, 5_000_000, 20_000_000, 75_000_000].map((n) =>
    new anchor.BN(n)
  );

  before(async () => {
    // NOTE: a plain SPL Token mint via createMint() does not carry the
    // TransferFeeConfig extension real ACT has. Before trusting these
    // results as representative, this should be swapped for a
    // Token-2022 mint initialized with TransferFeeConfig, so fee
    // withholding is actually exercised in the balance-delta path in
    // `stake`/`unstake`. Left as a plain mint here only to get the
    // account-layout and instruction-plumbing tests running first.
    mint = await createMint(
      provider.connection,
      (authority.payer as Keypair) ?? Keypair.generate(),
      authority.publicKey,
      null,
      9,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    userWallet = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      userWallet.publicKey,
      2_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    userTokenAccount = await createAccount(
      provider.connection,
      userWallet,
      mint,
      userWallet.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      (authority.payer as Keypair) ?? Keypair.generate(),
      mint,
      userTokenAccount,
      authority.publicKey,
      1_000_000_000 // 1B base units, adjust for decimals as needed
    );
  });

  it("initializes config", async () => {
    await program.methods
      .initializeConfig(TIERS, DURATION_DAYS, DURATION_MULTIPLIER)
      .accounts({
        authority: authority.publicKey,
        config: configPda,
        vaultAuthority: vaultAuthorityPda,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const config = await program.account.stakeConfig.fetch(configPda);
    assert.equal(config.paused, false);
    assert.equal(config.totalStaked.toNumber(), 0);
  });

  it("stakes and computes a tier", async () => {
    const [userStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), userWallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .stake(new anchor.BN(2_000_000), 30)
      .accounts({
        owner: userWallet.publicKey,
        config: configPda,
        userStake: userStakePda,
        mint,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([userWallet])
      .rpc();

    const userStake = await program.account.userStake.fetch(userStakePda);
    // 2,000,000 staked at 30-day (1.00x) -> CAS 2,000,000 -> tier 2
    // (>= 1,000,000 tier-1 threshold and >= ... check against TIERS above)
    assert.isAbove(userStake.tier, 0);
  });

  it("rejects unstake before lock maturity", async () => {
    const [userStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), userWallet.publicKey.toBuffer()],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [], // placeholder -- real vault is an ATA, derive via getAssociatedTokenAddress
      program.programId
    );

    try {
      await program.methods
        .unstake()
        .accounts({
          owner: userWallet.publicKey,
          config: configPda,
          userStake: userStakePda,
          vaultAuthority: vaultAuthorityPda,
          mint,
          vault: vaultPda,
          userTokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userWallet])
        .rpc();
      assert.fail("expected StillLocked error");
    } catch (err) {
      assert.include(String(err), "StillLocked");
    }
  });
});
