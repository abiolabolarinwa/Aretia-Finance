// act-staking -- full automated devnet test suite
// ---------------------------------------------------------------------
// Consolidates every ad-hoc devnet script in ../scripts/ into one
// repeatable, assertion-based (chai) mocha suite runnable with a single
// `npm test`. `anchor test`'s own local-validator route is blocked on
// this machine (documented native-Windows solana-test-validator
// genesis-unpacking failure -- see ../README.md), so this suite follows
// the pattern already proven for unstake's success path and the
// lock-shortening fix: it builds and deploys a THROWAWAY devnet copy of
// this exact program source with the `test-fast-clock` feature (a "day"
// is 2 real seconds), exercises every instruction against it with real
// assertions, then closes the throwaway program to reclaim its rent.
//
// This never touches the primary devnet deployment
// (DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH) or mainnet, and never
// uses real ACT -- only a throwaway Token-2022 test mint with the same
// TransferFeeConfig shape (350 bps), reused from act-presale's devnet
// test tokens.
//
// Run: npm test   (== mocha tests/full-suite.mjs --timeout 300000 --exit)

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = path.resolve(__dirname, ".."); // program/act-staking
const LIB_RS_PATH = path.join(PROGRAM_ROOT, "programs/act-staking/src/lib.rs");
const SO_PATH = path.join(PROGRAM_ROOT, "target/deploy/act_staking.so");

const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH = path.resolve(
  PROGRAM_ROOT,
  "../../devnet/deployer-keypair.json"
);
// act-presale's throwaway test-ACT mint (Token-2022, 350 bps transfer
// fee) -- same extension shape as real ACT, reused rather than minted
// fresh here. This suite's deployer keypair is also this mint's mint
// authority (confirmed via ../scripts/unstake-success-devnet-test.mjs).
const TEST_MINT = new PublicKey("DByy9CGFgXAEGeaufeA275y8tP9aiXWZkjRanNMd4pEr");

const THROWAWAY_KEYPAIR_PATH = path.join(
  process.env.TEMP || "/tmp",
  `act-staking-suite-program-${Date.now()}.json`
);

function loadKeypair(p) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function sh(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: PROGRAM_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).toString();
}
function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function boolByte(v) {
  return Buffer.from([v ? 1 : 0]);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeStakeConfig(buf) {
  let o = 8;
  const authority = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const mint = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const vault = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const totalStaked = buf.readBigUInt64LE(o);
  o += 8;
  const tiers = [];
  for (let i = 0; i < 5; i++) {
    tiers.push(buf.readBigUInt64LE(o));
    o += 8;
  }
  const durationDays = [];
  for (let i = 0; i < 4; i++) {
    durationDays.push(buf.readUInt16LE(o));
    o += 2;
  }
  const durationMultiplier = [];
  for (let i = 0; i < 4; i++) {
    durationMultiplier.push(buf.readUInt16LE(o));
    o += 2;
  }
  const paused = !!buf.readUInt8(o);
  o += 1;
  const bump = buf.readUInt8(o);
  o += 1;
  const vaultAuthorityBump = buf.readUInt8(o);
  o += 1;
  return { authority, mint, vault, totalStaked, tiers, durationDays, durationMultiplier, paused, bump, vaultAuthorityBump };
}
function decodeUserStake(buf) {
  let o = 8;
  const owner = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const amount = buf.readBigUInt64LE(o);
  o += 8;
  const lockDays = buf.readUInt16LE(o);
  o += 2;
  const stakedAt = buf.readBigInt64LE(o);
  o += 8;
  const unlockAt = buf.readBigInt64LE(o);
  o += 8;
  const tier = buf.readUInt8(o);
  o += 1;
  const bump = buf.readUInt8(o);
  o += 1;
  return { owner, amount, lockDays, stakedAt, unlockAt, tier, bump };
}

function errText(err) {
  // err.logs, when present, is an array -- and an EMPTY array is truthy
  // in JS, so `err.logs || err.message` silently discards a perfectly
  // good message (e.g. "Blockhash not found") whenever logs is `[]`
  // (which happens whenever the RPC rejects before the program ever
  // runs). Always include both, never let one hide the other.
  const parts = [];
  if (err && err.message) parts.push(String(err.message));
  if (err && Array.isArray(err.logs) && err.logs.length > 0) parts.push(JSON.stringify(err.logs));
  if (parts.length === 0) parts.push(String(err));
  return parts.join(" | ");
}

// Public devnet RPC (api.devnet.solana.com) is shared and rate-limited;
// under this suite's burst of sequential transactions it occasionally
// returns "Blockhash not found" for a blockhash that was valid moments
// earlier, or a plain 429. Neither reflects anything about the program
// under test, so these particular errors get a few retries with a fresh
// blockhash rather than failing the test.
async function withRetry(fn, label, retries = 8) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      // A small fixed pace ahead of every attempt, not just after a
      // failure -- public devnet RPC's rate limit is tripped by burst
      // rate, not total volume, and this suite fires many transactions
      // in quick succession across freshly-funded stakers.
      if (i === 0) await sleep(350);
      return await fn();
    } catch (err) {
      lastErr = err;
      const text = errText(err);
      const transient =
        text.includes("Blockhash not found") ||
        text.includes("block height exceeded") ||
        text.includes("429") ||
        text.includes("Too many requests");
      if (!transient) throw err;
      if (process.env.VERBOSE_TEST_LOGS) {
        console.log(`  [retry ${i + 1}/${retries}] ${label} hit a transient RPC error, retrying...`);
      }
      await sleep(Math.min(2000 * (i + 1), 10_000));
    }
  }
  throw lastErr;
}

describe("act-staking (devnet, throwaway fast-clock deployment)", function () {
  this.timeout(300_000);

  const connection = new Connection(RPC_URL, "confirmed");
  const deployer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  let PROGRAM_ID;
  let configPda, vaultAuthorityPda, vaultAta;
  const DEFAULT_TIERS = [0, 1_000_000, 5_000_000, 20_000_000, 75_000_000].map(
    (t) => BigInt(t) * 10n ** 9n
  );
  const DEFAULT_DURATION_DAYS = [30, 90, 180, 365];
  const DEFAULT_DURATION_MULTIPLIER = [100, 130, 175, 260];

  async function send(ix, signers, label) {
    return withRetry(async () => {
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
      if (process.env.VERBOSE_TEST_LOGS) console.log(`  ${label}: ${sig}`);
      return sig;
    }, label);
  }

  function ixInitializeConfig(authority, tiers, durationDays, durationMultiplier) {
    const data = Buffer.concat([
      discriminator("initialize_config"),
      ...tiers.map(u64le),
      ...durationDays.map(u16le),
      ...durationMultiplier.map(u16le),
    ]);
    const keys = [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TEST_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }
  function ixUpdateTierConfig(authority, tiers, durationDays, durationMultiplier) {
    const data = Buffer.concat([
      discriminator("update_tier_config"),
      ...tiers.map(u64le),
      ...durationDays.map(u16le),
      ...durationMultiplier.map(u16le),
    ]);
    const keys = [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }
  function ixSetPaused(authority, paused) {
    const data = Buffer.concat([discriminator("set_paused"), boolByte(paused)]);
    const keys = [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }
  function ixSetConfigAuthority(authority, newAuthority) {
    const data = Buffer.concat([discriminator("set_config_authority"), newAuthority.toBuffer()]);
    const keys = [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }
  function ixStake(owner, ownerAta, amount, lockDays) {
    const [userStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), owner.publicKey.toBuffer()],
      PROGRAM_ID
    );
    const data = Buffer.concat([discriminator("stake"), u64le(amount), u16le(lockDays)]);
    const keys = [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: userStakePda, isSigner: false, isWritable: true },
      { pubkey: TEST_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }
  function ixUnstake(owner, ownerAta) {
    const [userStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), owner.publicKey.toBuffer()],
      PROGRAM_ID
    );
    const data = discriminator("unstake");
    const keys = [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: userStakePda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TEST_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }

  async function freshFundedStaker(solLamports = 30_000_000) {
    const kp = Keypair.generate();
    await send(
      SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: solLamports }),
      [deployer],
      "fund staker"
    );
    const ata = await withRetry(
      () =>
        getOrCreateAssociatedTokenAccount(
          connection,
          deployer,
          TEST_MINT,
          kp.publicKey,
          false,
          "confirmed",
          undefined,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
      "create staker ATA"
    );
    return { kp, ata: ata.address };
  }
  async function mintTestAct(destAta, wholeTokens) {
    await withRetry(
      () =>
        mintTo(
          connection,
          deployer,
          TEST_MINT,
          destAta,
          deployer,
          BigInt(wholeTokens) * 10n ** 9n,
          [],
          undefined,
          TOKEN_2022_PROGRAM_ID
        ),
      "mintTo"
    );
  }
  async function fetchUserStake(owner) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), owner.publicKey.toBuffer()],
      PROGRAM_ID
    );
    const info = await connection.getAccountInfo(pda);
    return info ? decodeUserStake(info.data) : null;
  }
  async function expectRpcError(promise, ...codeFragments) {
    try {
      await promise;
      expect.fail("expected transaction to be rejected, but it succeeded");
    } catch (err) {
      const text = errText(err);
      const matched = codeFragments.some((f) => text.includes(f));
      expect(matched, `expected error to contain one of [${codeFragments.join(", ")}], got: ${text}`).to.be.true;
    }
  }

  before(async function () {
    console.log("\n[setup] Building throwaway fast-clock act-staking binary (cargo build-sbf)...");
    const originalLibRs = fs.readFileSync(LIB_RS_PATH, "utf8");
    const throwawayProgramKeypair = Keypair.generate();
    fs.writeFileSync(
      THROWAWAY_KEYPAIR_PATH,
      JSON.stringify(Array.from(throwawayProgramKeypair.secretKey))
    );
    PROGRAM_ID = throwawayProgramKeypair.publicKey;
    console.log("[setup] Throwaway program id:", PROGRAM_ID.toBase58());

    try {
      const patched = originalLibRs.replace(
        /declare_id!\("[^"]+"\);/,
        `declare_id!("${PROGRAM_ID.toBase58()}");`
      );
      expect(patched).to.not.equal(originalLibRs, "declare_id! patch did not match anything in lib.rs");
      fs.writeFileSync(LIB_RS_PATH, patched);

      sh(`cargo build-sbf --features test-fast-clock`, { timeout: 240_000 });
    } finally {
      // The .so already has the patched id baked in; the source is
      // reverted immediately after the build completes, matching this
      // repo's established throwaway-deployment hygiene.
      fs.writeFileSync(LIB_RS_PATH, originalLibRs);
    }

    console.log("[setup] Deploying to devnet...");
    sh(
      `solana program deploy "${SO_PATH}" --program-id "${THROWAWAY_KEYPAIR_PATH}" --keypair "${DEPLOYER_KEYPAIR_PATH}" --url ${RPC_URL}`,
      { timeout: 120_000 }
    );
    console.log("[setup] Deployed:", `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`);

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
    [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
    vaultAta = getAssociatedTokenAddressSync(
      TEST_MINT,
      vaultAuthorityPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  after(async function () {
    if (!PROGRAM_ID) return;
    try {
      console.log("\n[teardown] Closing throwaway program to reclaim rent...");
      sh(
        `solana program close "${PROGRAM_ID.toBase58()}" --keypair "${DEPLOYER_KEYPAIR_PATH}" --url ${RPC_URL} --bypass-warning`,
        { timeout: 60_000 }
      );
    } catch (err) {
      console.warn("[teardown] program close failed (non-fatal for test results):", err.message);
    } finally {
      try {
        fs.unlinkSync(THROWAWAY_KEYPAIR_PATH);
      } catch {}
    }
  });

  describe("initialize_config", () => {
    it("sets up config with the requested tiers/durations", async () => {
      await send(
        ixInitializeConfig(deployer, DEFAULT_TIERS, DEFAULT_DURATION_DAYS, DEFAULT_DURATION_MULTIPLIER),
        [deployer],
        "initialize_config"
      );
      const info = await connection.getAccountInfo(configPda);
      const cfg = decodeStakeConfig(info.data);
      expect(cfg.authority.equals(deployer.publicKey)).to.be.true;
      expect(cfg.mint.equals(TEST_MINT)).to.be.true;
      expect(cfg.vault.equals(vaultAta)).to.be.true;
      expect(cfg.totalStaked).to.equal(0n);
      expect(cfg.tiers.map(String)).to.deep.equal(DEFAULT_TIERS.map(String));
      expect(cfg.durationDays).to.deep.equal(DEFAULT_DURATION_DAYS);
      expect(cfg.durationMultiplier).to.deep.equal(DEFAULT_DURATION_MULTIPLIER);
      expect(cfg.paused).to.equal(false);
    });
  });

  describe("stake", () => {
    it("computes tier 0 for a small amount and records net-of-fee balance", async function () {
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 10); // 10 test-ACT, well under tier-1's 1,000,000 threshold
      const grossAmount = 10n * 10n ** 9n;

      const vaultBefore = (await getAccount(connection, vaultAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      await send(ixStake(kp, ata, grossAmount, 30), [kp], "stake");
      const vaultAfter = (await getAccount(connection, vaultAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const netReceived = vaultAfter - vaultBefore;

      expect(Number(netReceived)).to.be.lessThan(Number(grossAmount)); // 350 bps deposit fee withheld
      const impliedBps = ((grossAmount - netReceived) * 10_000n) / grossAmount;
      expect(Number(impliedBps)).to.be.closeTo(350, 10);

      const stake = await fetchUserStake(kp);
      expect(stake.amount).to.equal(netReceived);
      expect(stake.lockDays).to.equal(30);
      expect(stake.tier).to.equal(0);
    });

    it("computes a higher tier for a large amount", async function () {
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 6_000_000); // above tier-2's 5,000,000 threshold even after fee
      await send(ixStake(kp, ata, 6_000_000n * 10n ** 9n, 30), [kp], "stake");
      const stake = await fetchUserStake(kp);
      expect(stake.tier).to.be.greaterThan(0);
    });

    it("rejects an amount of zero", async function () {
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 1);
      await expectRpcError(send(ixStake(kp, ata, 0n, 30), [kp], "stake zero"), "ZeroAmount", "0x1771", "6001");
    });

    it("rejects a lock_days value that isn't one of the configured durations", async function () {
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 1);
      await expectRpcError(
        send(ixStake(kp, ata, 1n * 10n ** 9n, 45), [kp], "stake invalid duration"),
        "InvalidLockDuration",
        "0x1772",
        "6002"
      );
    });

    it("rejects staking while paused, and allows it again once unpaused", async function () {
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 1);

      await send(ixSetPaused(deployer, true), [deployer], "set_paused(true)");
      await expectRpcError(
        send(ixStake(kp, ata, 1n * 10n ** 9n, 30), [kp], "stake while paused"),
        "StakingPaused",
        "0x1770",
        "6000"
      );

      await send(ixSetPaused(deployer, false), [deployer], "set_paused(false)");
      await send(ixStake(kp, ata, 1n * 10n ** 9n, 30), [kp], "stake after unpause");
      const stake = await fetchUserStake(kp);
      expect(Number(stake.amount)).to.be.greaterThan(0);
    });
  });

  describe("unstake", () => {
    it("rejects unstaking before the lock matures", async function () {
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 5);
      await send(ixStake(kp, ata, 5n * 10n ** 9n, 30), [kp], "stake");
      await expectRpcError(send(ixUnstake(kp, ata), [kp], "unstake early"), "StillLocked", "0x1775", "6005");
    });

    it("succeeds after maturity, paying out net of the withdrawal fee (no gross-up), and closes the account", async function () {
      this.timeout(120_000);
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 1_000);
      const grossAmount = 1_000n * 10n ** 9n;

      await send(ixStake(kp, ata, grossAmount, 30), [kp], "stake");
      const staked = await fetchUserStake(kp);
      expect(Number(staked.unlockAt - staked.stakedAt)).to.equal(60); // 30 days * 2s fast-clock

      const waitMs = Math.max(0, Number(staked.unlockAt) - Math.floor(Date.now() / 1000) + 5) * 1000;
      await sleep(waitMs);

      const ownerBalanceBefore = (await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      await send(ixUnstake(kp, ata), [kp], "unstake mature");
      const ownerBalanceAfter = (await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const received = ownerBalanceAfter - ownerBalanceBefore;

      // staked.amount is already net of the deposit-side fee; unstake
      // does not gross up, so the wallet nets staked.amount * ~0.965
      // (withdrawal-side fee only) -- documented behavior, distinct from
      // act-presale's claim() which does gross up.
      const expectedApprox = (staked.amount * 965n) / 1000n;
      const delta = received > expectedApprox ? received - expectedApprox : expectedApprox - received;
      expect(Number(received)).to.be.greaterThan(0);
      expect(Number(delta)).to.be.lessThan(Number(staked.amount) / 100);

      const closedInfo = await connection.getAccountInfo(
        PublicKey.findProgramAddressSync([Buffer.from("user_stake"), kp.publicKey.toBuffer()], PROGRAM_ID)[0]
      );
      expect(closedInfo).to.be.null;
    });

    it("rejects unstaking when nothing is staked", async function () {
      const { kp, ata } = await freshFundedStaker();
      await expectRpcError(send(ixUnstake(kp, ata), [kp], "unstake nothing"), "AccountNotInitialized", "3012");
    });
  });

  describe("lock-shortening guard (top-ups)", () => {
    it("rejects a top-up whose lock_days is less than the time remaining, accepts one that extends it", async function () {
      const { kp, ata } = await freshFundedStaker();
      await mintTestAct(ata, 20);

      await send(ixStake(kp, ata, 10n * 10n ** 9n, 90), [kp], "initial stake (90 days)");
      const afterInitial = await fetchUserStake(kp);
      expect(afterInitial.lockDays).to.equal(90);

      await expectRpcError(
        send(ixStake(kp, ata, 1n * 10n ** 9n, 30), [kp], "top-up shortening to 30 days"),
        "CannotShortenLock",
        "0x1773",
        "6003"
      );

      await send(ixStake(kp, ata, 1n * 10n ** 9n, 90), [kp], "top-up same duration (90 days)");
      const afterSameDuration = await fetchUserStake(kp);
      expect(Number(afterSameDuration.amount)).to.be.greaterThan(Number(afterInitial.amount));

      await send(ixStake(kp, ata, 1n * 10n ** 9n, 365), [kp], "top-up extending to 365 days");
      const afterExtend = await fetchUserStake(kp);
      expect(afterExtend.lockDays).to.equal(365);
      expect(Number(afterExtend.unlockAt)).to.be.greaterThan(Number(afterSameDuration.unlockAt));
    });
  });

  describe("update_tier_config", () => {
    it("rejects a tier table that doesn't start at 0 or isn't strictly increasing", async function () {
      const badTiers = [1n, 2n, 3n, 4n, 5n].map((n) => n * 10n ** 9n); // doesn't start at 0
      await expectRpcError(
        send(
          ixUpdateTierConfig(deployer, badTiers, DEFAULT_DURATION_DAYS, DEFAULT_DURATION_MULTIPLIER),
          [deployer],
          "update_tier_config bad table"
        ),
        "InvalidTierTable",
        "0x1776",
        "6006"
      );
    });

    it("rejects a duration multiplier below 1.00x", async function () {
      await expectRpcError(
        send(
          ixUpdateTierConfig(deployer, DEFAULT_TIERS, DEFAULT_DURATION_DAYS, [100, 130, 175, 99]),
          [deployer],
          "update_tier_config bad multiplier"
        ),
        "InvalidDurationTable",
        "0x1777",
        "6007"
      );
    });

    it("applies a valid new tier table", async function () {
      const newTiers = [0, 2_000_000, 8_000_000, 25_000_000, 90_000_000].map((n) => BigInt(n) * 10n ** 9n);
      await send(
        ixUpdateTierConfig(deployer, newTiers, DEFAULT_DURATION_DAYS, DEFAULT_DURATION_MULTIPLIER),
        [deployer],
        "update_tier_config valid"
      );
      const info = await connection.getAccountInfo(configPda);
      const cfg = decodeStakeConfig(info.data);
      expect(cfg.tiers.map(String)).to.deep.equal(newTiers.map(String));

      // restore defaults so later tests aren't affected by this change
      await send(
        ixUpdateTierConfig(deployer, DEFAULT_TIERS, DEFAULT_DURATION_DAYS, DEFAULT_DURATION_MULTIPLIER),
        [deployer],
        "update_tier_config restore"
      );
    });

    it("rejects a call signed by a non-authority key", async function () {
      const impostor = Keypair.generate();
      await send(
        SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: impostor.publicKey, lamports: 10_000_000 }),
        [deployer],
        "fund impostor"
      );
      await expectRpcError(
        send(
          ixUpdateTierConfig(impostor, DEFAULT_TIERS, DEFAULT_DURATION_DAYS, DEFAULT_DURATION_MULTIPLIER),
          [impostor],
          "update_tier_config impostor"
        ),
        "ConstraintHasOne",
        "2001"
      );
    });
  });

  describe("set_config_authority", () => {
    let newAuthority;

    it("transfers authority, after which only the new authority can administer config", async function () {
      newAuthority = Keypair.generate();
      await send(
        SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: newAuthority.publicKey, lamports: 10_000_000 }),
        [deployer],
        "fund new authority"
      );

      await send(ixSetConfigAuthority(deployer, newAuthority.publicKey), [deployer], "set_config_authority");
      const info = await connection.getAccountInfo(configPda);
      const cfg = decodeStakeConfig(info.data);
      expect(cfg.authority.equals(newAuthority.publicKey)).to.be.true;

      // old authority (deployer) can no longer administer config
      await expectRpcError(
        send(ixSetPaused(deployer, true), [deployer], "set_paused as old authority"),
        "ConstraintHasOne",
        "2001"
      );

      // new authority can
      await send(ixSetPaused(newAuthority, true), [newAuthority], "set_paused as new authority");
      await send(ixSetPaused(newAuthority, false), [newAuthority], "unpause as new authority");
    });

    it("rejects handing authority to the default (all-zero) pubkey", async function () {
      await expectRpcError(
        send(
          ixSetConfigAuthority(newAuthority, PublicKey.default),
          [newAuthority],
          "set_config_authority to default pubkey"
        ),
        "InvalidNewAuthority",
        "0x1779",
        "6009"
      );
      const info = await connection.getAccountInfo(configPda);
      const cfg = decodeStakeConfig(info.data);
      expect(cfg.authority.equals(newAuthority.publicKey)).to.be.true; // unchanged
    });
  });
});
