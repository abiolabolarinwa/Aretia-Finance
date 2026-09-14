# ACT Staking — Design Record (Part VIII, Section 30 infrastructure)

**Status (updated 14 Sept 2026):** Program **compiles clean**, is **deployed and live on devnet** (upgraded 14 Sept to add `set_config_authority` and a lock-shortening fix, both described below), and `initialize_config`, `stake` (fresh + top-up), `unstake`'s rejection of early withdrawal, and now `set_config_authority` have all been **called for real against the live deployment and verified correct** — 13/13 checks on the stake/unstake run, 9/9 on the config-authority migration. Testing `stake` caught a real bug: the tier thresholds passed to `initialize_config` were unscaled (whole-token numbers where the program expects base units), silently maxing every staker straight to tier 4 regardless of size. Fixed on-chain via `update_tier_config` and fixed in the setup script so it doesn't recur. `StakeConfig.authority` has been migrated off the throwaway devnet deployer key onto the dedicated `devnet-upgrade-authority-keypair.json` (`36mcKLqe2dah5erGo1wH1C6FzyVKAfJpNwoxRKZA5UEj`), the same key that already holds this program's own upgrade authority, via the newly added `set_config_authority` instruction (see "Build log"). **Not yet tested: `unstake`'s success path** (after a lock actually matures), and the lock-shortening fix has not been separately exercised live (it shipped in the same binary `set_config_authority` was verified against, but that verification doesn't itself touch `stake`'s top-up path). A local-validator route (which would allow a shrunk test clock instead of waiting 30 real days) was attempted and blocked; the cause is now confirmed, not just suspected — ruled out Defender, admin privilege, and path directly, then found this is a documented upstream `solana-test-validator`-on-native-Windows issue with no quick native fix. **Decision: proceed with devnet-only coverage for now**, revisit via WSL or another Linux environment later. Not deployed to mainnet. See "Build log" below for the full diagnosis.

**Scope, per Section 32:** this is infrastructure only. It does not gate access to anything today, because Stage Two does not exist today. What it does is let a wallet lock ACT for a chosen duration and have that produce a deterministic, on-chain-readable tier. Nothing about that tier currently unlocks a data room, a marketplace listing, or any investment opportunity — there isn't one yet. Section 30's two hard rules apply unconditionally: no tier confers investor eligibility, and ACT's marketed value must never be represented as a function of any gated project's returns. This program does not touch either of those; it only computes and stores a number.

This is also the protocol's **first custom on-chain program**. Everything before this — the mint, the transfer-fee extension, the treasury multisig — is native Token-2022 configuration and Squads multisig instructions, built with raw `@solana/web3.js` scripts (see `scripts/rebuild-mint/`, `scripts/treasury-v2-setup/`). No custom program has been deployed before this one. That matters for risk: this is new code holding user funds, not a config change to code someone else wrote and the ecosystem has already exercised at scale. It should not go to mainnet with real value locked in it without the same devnet-first, verify-on-chain discipline already used for the mint and treasury (see `MINT_V2.md`, `TREASURY_V2.md`), and ideally an independent review before any meaningful amount of ACT is at stake — literally, in this case.

---

## The Capital Access Score (CAS) formula

Section 30 deliberately withheld a formula, calling premature precision worse than no formula. This defines one now, at the user's request, but keeps it changeable without a program redeploy — the thresholds live in a mutable on-chain config account the treasury multisig controls, not as hardcoded constants. Treat every number below as a starting point pending real holder-distribution data, not a settled figure.

```
CAS = staked_amount × duration_multiplier(lock_days) / 100
```

`staked_amount` is the net ACT actually held in the vault for that wallet (see "Fee handling" below — it is never the gross amount a user sent).

**Duration multiplier** (four fixed lock options; hundredths, so 100 = 1.00×):

| Lock period | Multiplier |
|---|---|
| 30 days | 1.00× |
| 90 days | 1.30× |
| 180 days | 1.75× |
| 365 days | 2.60× |

Increasing but concave — commitment is rewarded, but a 365-day lock isn't worth twelve 30-day locks stacked end to end. This shape mirrors the ve-token boost curves used by the platforms Section 31 already cites (Curve's veCRV being the canonical example of this exact idea, applied there to governance weight rather than access tiering).

**Tiers** (CAS thresholds, expressed against the fixed 1,000,000,000 ACT supply for legibility). The table below is in **whole ACT tokens** for readability; the on-chain `StakeConfig.tiers` values must be these numbers **× 10^9** (9 decimals) since CAS is computed on raw base units, the same units `amount` is measured in everywhere else in this program. Getting this scaling wrong doesn't error, it just silently maxes every staker out at tier 4 — confirmed the hard way on devnet (see "Build log": `init-devnet-config.mjs` originally stored these numbers unscaled, and `stake-unstake-devnet-test.mjs` caught a 2-ACT test stake landing at tier 4 immediately; fixed via `update_tier_config`, and in the init script itself, before this was ever pointed at anything but a throwaway test mint):

| Tier | CAS threshold (whole ACT) | On-chain value (base units, ×10^9) | Equivalent at 1.00× (30-day lock) |
|---|---|---|---|
| 0 — Public | below 1,000,000 | below 1,000,000,000,000,000 | — |
| 1 — Observer | ≥ 1,000,000 | ≥ 1,000,000,000,000,000 | 0.10% of supply |
| 2 — Participant | ≥ 5,000,000 | ≥ 5,000,000,000,000,000 | 0.50% of supply |
| 3 — Partner | ≥ 20,000,000 | ≥ 20,000,000,000,000,000 | 2.00% of supply |
| 4 — Anchor | ≥ 75,000,000 | ≥ 75,000,000,000,000,000 | 7.50% of supply |

These are guesses calibrated against nothing but the supply figure itself, exactly the situation Section 30 warned about — no trading history, no holder-distribution data exists yet (Section 20.1). They are stored in `StakeConfig.tiers` and changeable by the treasury multisig via `update_tier_config` without touching the program binary. Revisit them once ACT is actually trading and a holder distribution exists to calibrate against.

---

## Program architecture

Anchor program, workspace at `program/act-staking/`. Uses `anchor_spl::token_interface` throughout rather than the legacy `token` module, so it works against ACT's actual program (Token-2022), not classic SPL Token.

### Accounts

**`StakeConfig`** — singleton, PDA seeds `[b"config"]`
- `authority: Pubkey` — set to the treasury multisig's vault PDA (`GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`, per `TREASURY_V2.md`), not a personal key. A Squads-approved transaction CPIs into `update_tier_config`/`set_paused`; the 2-of-3 threshold is enforced by Squads before it ever reaches this program, so the program itself only needs a single signer check against `authority`.
- `mint: Pubkey` — the ACT mint
- `vault: Pubkey` — the vault's associated token account (owned by the `vault_authority` PDA, not by any wallet)
- `total_staked: u64` — net ACT currently locked, sum of all `UserStake.amount`
- `tiers: [u64; 5]` — CAS thresholds for tiers 0–4 (tier 0 is always 0)
- `duration_days: [u16; 4]` / `duration_multiplier: [u16; 4]` — the two tables above, parallel arrays
- `paused: bool` — circuit breaker; when true, `stake` is rejected but `unstake` still works, so a bug freezes new deposits without trapping anyone's existing funds
- `bump: u8`

**`UserStake`** — per wallet, PDA seeds `[b"user_stake", owner]`
- `owner: Pubkey`
- `amount: u64` — net ACT held for this wallet
- `lock_days: u16` — the duration option chosen
- `staked_at: i64` — unix timestamp, weighted-average on top-ups (below)
- `unlock_at: i64`
- `tier: u8` — cached, recomputed on every `stake`/`unstake`
- `bump: u8`

### Instructions

- **`initialize_config`** — one-time, sets up `StakeConfig` and the vault ATA. Authority-gated.
- **`update_tier_config`** — authority-gated; replaces the tier thresholds and/or duration multipliers. This is how the illustrative numbers above get recalibrated later without a redeploy.
- **`set_paused(bool)`** — authority-gated circuit breaker.
- **`stake(amount: u64, lock_days: u16)`**
  1. Reject if `paused`.
  2. `lock_days` must be one of the four configured options.
  3. Read the vault ATA's token balance before the transfer.
  4. `transfer_checked` (Token-2022, via `token_interface`) `amount` from the user's ATA to the vault ATA.
  5. Read the vault ATA's balance after; `net_received = after - before`. This is the actual credited amount, independent of whatever the fee rate happens to be at the time — the program never hardcodes 3.5%, because Section 11 already establishes that rate is treasury-governed and can change. Computing net by balance delta rather than by formula is what keeps this correct across a future fee-rate change with no code update.
  6. If the wallet has no existing stake, set `staked_at = now`. If topping up an existing, still-locked stake, blend the ages by a weighted average so a large top-up can't retroactively inherit the old stake's full duration credit for free:
     ```
     new_staked_at = now − ⌊(old_amount × (now − staked_at)) / (old_amount + net_received)⌋
     ```
     A fresh deposit has age zero; this weights the blended age by how much of the new total each portion represents.
  7. `lock_days` on a top-up must be ≥ the days remaining until the existing `unlock_at` — you can extend or add to a commitment, never shorten one already in force.
  8. `unlock_at = now + lock_days × 86400`.
  9. Recompute `CAS` and `tier` from `StakeConfig`, cache both on `UserStake`. Update `total_staked`.
- **`unstake()`**
  1. Requires `now ≥ unlock_at`.
  2. `transfer_checked` the full `amount` from the vault back to the user's ATA, signed by the `vault_authority` PDA. This transfer also incurs the protocol's transfer fee like any other ACT transfer — the user receives net of that fee, and the staking UI needs to say so plainly before anyone confirms an unstake.
  3. Zero the position, close `UserStake` back to the owner (rent refunded), decrement `total_staked`.

No `extend_lock`-only instruction in this first cut — extending is just calling `stake` with `amount = 0` conceptually, but the current code requires `amount > 0`; a zero-amount top-up-only path is a natural, low-risk v2 addition once the base program is verified, not included here to keep the reviewable surface smaller.

### Reading tier data

No separate "view" instruction — Solana doesn't really have those. The website reads `UserStake` directly via `getAccountInfo` + the Anchor-generated IDL, the same client-side, no-server-in-the-path pattern the existing verification tool already uses (Section 24.3). A staking page would be additive to that pattern, not a departure from it.

---

## Fee handling — why balance-delta, not arithmetic

ACT carries a Token-2022 transfer fee (3.5% currently, treasury-governed, Section 14). Every transfer into or out of the vault is subject to it, including stakes and unstakes. Two wrong ways to handle this, both worth naming so they don't get reintroduced later:

- Trusting the `amount` parameter as what actually landed — wrong, because up to the configured max fee is withheld before the vault ever sees it.
- Hardcoding the current 3.5% rate to compute net — wrong, because Section 11 already changed this rate once by governance vote and can again; a hardcoded rate silently desyncs from reality the next time it does.

Reading the vault's own balance immediately before and after the CPI is correct under both a stable and a changing fee rate, with no assumption about what the rate currently is baked into the program at all.

---

## Toolchain — resolved, native Windows (no WSL needed)

WSL remains blocked on this machine (virtualization disabled in firmware, a BIOS/UEFI setting only fixable at the physical machine), but native Windows Rust turned out to be entirely workable once two gaps were closed:

1. **Rust itself** — installed via `winget install --id Rustlang.Rustup -e --source winget` (the `winget`, not `msstore`, source; the default source needs a one-time regional-agreement acceptance that failed non-interactively). Gives a working `stable-x86_64-pc-windows-msvc` toolchain.
2. **A host linker** — this machine had a *partial* Visual Studio Build Tools install (headers and libs present, `link.exe` itself missing) sitting at `...\Microsoft Visual Studio\18\BuildTools`. Repairing that exact instance via Chocolatey (`choco install mingw`, and separately trying to complete the same instance) hit a persistent, unrelated Chocolatey/NuGet lock bug (`Unable to obtain lock file access on ...`, a 69-second hang before failing — a Chocolatey issue, not a mingw-specific one). The fix that actually worked: `winget install --id Microsoft.VisualStudio.2022.BuildTools ... --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`, which installed a **second**, separate Build Tools instance at `...\Microsoft Visual Studio\2022\BuildTools` with the actual compiler binaries and Windows SDK. If you ever repeat this, check `vswhere -all -products * -format json` for multiple `installationPath` entries rather than assuming there's only one — that's what cost the most time here.

`cargo-build-sbf` (bundled with the Solana CLI, `cargo-build-sbf 4.1.0` / `platform-tools v1.54`) handles the actual SBF/eBPF cross-compilation itself once a working host `cargo`/linker exist for compiling proc-macros and build scripts; no Anchor CLI install was needed to produce a working `.so` — `anchor-lang`/`anchor-spl` are just regular crates. Anchor CLI would still be worth installing later for `anchor test`'s local-validator orchestration and IDL generation convenience, but wasn't required to get this far.

The network in this environment was highly intermittent throughout (DNS resolution to `github.com`, `index.crates.io`, and the platform-tools release asset host failed unpredictably, sometimes clearing in seconds, sometimes needing several retries) — if a build step fails with a network error, retry before assuming something is actually broken; several were.

## Build log

- **12 Sept 2026** — `cargo build-sbf` (release) against `programs/act-staking` **succeeded**: `Finished 'release' profile [optimized] target(s)`, producing `target/deploy/act_staking.so` (287 KB, verified as a valid `ELF 64-bit LSB shared object`). Only cosmetic `unexpected cfg` lint warnings remain (a known, harmless Anchor 0.30.1 + Rust 1.80+ interaction, not a defect).
  - One real bug caught and fixed by this: `Stake`'s accounts struct uses `init_if_needed` on `user_stake`, which requires `anchor-lang`'s `init-if-needed` cargo feature. Without it, Anchor's `#[derive(Accounts)]`/`#[program]` macros fail to generate a working implementation for that one struct, surfacing as a confusing cascade of `Bumps`/`Accounts` trait-not-satisfied errors that don't obviously point back at the missing feature flag. Fixed in `programs/act-staking/Cargo.toml`.
  - A real program keypair was generated (`solana-keygen new`) for the program id: `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`, wired into `Anchor.toml` and `declare_id!()`. The keypair file lives at `target/deploy/act_staking-keypair.json`, which is gitignored and has never been committed — treat it as sensitive (it can sign upgrade authority transactions once this is deployed) even though nothing has been deployed with it yet.
- **12 Sept 2026** — Devnet deployment attempted and initially **blocked**: the public devnet faucet (`solana airdrop`, `https://api.devnet.solana.com`) returned "airdrop request failed. This can happen when the rate limit is reached" on every attempt, for a freshly generated throwaway deployer keypair (`Ujy25mQwz7AWHgWrS5727mN4gknSrHHEWXH95dGCgxf`) with a zero balance. This was a rate limit on the shared public faucet, not a code or toolchain problem, and persisted for hours across many retries. Unblocked once 2.5 devnet SOL was sent to that deployer address manually.
- **12 Sept 2026** — Devnet deployment **succeeded**, in two attempts: the first `solana program deploy` failed partway ("41 write transactions failed", again the environment's flaky network dropping some of the many small chunk-upload transactions a ~287 KB program requires) but left a resumable buffer account; resuming with `--buffer <printed-buffer-address>` (the deployer key already held write authority over it, no need to recover the ephemeral buffer keypair the CLI printed a seed phrase for) completed the deploy. Confirmed independently, not just trusted from the CLI's own success message, via `solana program show DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH --url devnet`:
  ```
  Owner: BPFLoaderUpgradeab1e11111111111111111111111
  ProgramData Address: 5jJF93QvbBFonbyDKqUu3fBqzesfCwNLkfQXDCjSyDAb
  Authority: Ujy25mQwz7AWHgWrS5727mN4gknSrHHEWXH95dGCgxf
  Data Length: 286968 bytes   (exact match to the local target/deploy/act_staking.so)
  Balance: 1.45867628 SOL
  ```
  Upgrade authority sat on the throwaway devnet deployer key immediately after this deploy; see the next two entries for what changed.
- **12 Sept 2026** — `initialize_config` **called for real against the devnet deployment and verified**, via `program/act-staking/scripts/init-devnet-config.mjs`: creates a throwaway devnet Token-2022 test mint (not real ACT, which only exists on mainnet), derives the `config`/`vault_authority` PDAs and the vault ATA the same way the program does, hand-builds the instruction (an Anchor sighash discriminator plus borsh-encoded fixed-size arrays, since no Anchor CLI/IDL exists in this environment to generate a client from), sends it, then reads back the `StakeConfig` account byte-for-byte against the Rust struct's exact field order and asserts each field independently rather than only checking the transaction didn't error. All nine checks passed: authority, mint, vault, tiers, duration days, duration multipliers, `total_staked == 0`, `paused == false`, and the config PDA's bump matching its own derivation. Also independently confirmed the vault ATA the program created via its `init` constraint is a real, 170-byte Token-2022 account (`solana account <address>`), not just an address that was referenced. `stake` and `unstake`, the instructions that actually move tokens, were not exercised by this script.
- **12 Sept 2026** — Devnet upgrade authority **transferred** off the throwaway deployer key onto a dedicated, durable keypair generated for this purpose (`program/act-staking/devnet-upgrade-authority-keypair.json`, gitignored, never committed): `solana program set-upgrade-authority ... --new-upgrade-authority devnet-upgrade-authority-keypair.json` (passing the new authority as a keypair, not a bare pubkey, so it co-signs as proof of control rather than needing `--skip-new-upgrade-authority-signer-check`). Confirmed via `solana program show`: `Authority: 36mcKLqe2dah5erGo1wH1C6FzyVKAfJpNwoxRKZA5UEj`. Still a single keypair, not a multisig — appropriate for devnet iteration, not a stand-in for what mainnet will eventually need (the treasury multisig, or a devnet-only multisig mirroring it, matching how every other authority in this protocol ended up governed).
- **13 Sept 2026** — Attempted a local-validator test harness (added a `test-fast-clock` cargo feature shrinking `SECONDS_PER_DAY` from 86,400 to 2, built separately via `cargo build-sbf --features test-fast-clock --sbf-out-dir target/deploy-test`, so a "30-day" lock resolves in 60 real seconds without touching the real devnet/mainnet build) specifically to test `unstake`'s success path without waiting real days. **Blocked**: every `solana-test-validator` invocation failed identically — `Access is denied (os error 5)` during "Error checking to unpack genesis archive" — regardless of ledger path (Temp, drive root, long path, short path all tried). Confirmed this is not a plain privilege issue: symlink creation itself fails in this environment (`New-Item -ItemType SymbolicLink` → "Administrator privilege required"), consistent with a Windows security product intercepting the genesis archive's unpacking, but the identical failure recurred even in a **verified, genuinely elevated** Administrator PowerShell window, ruling out simple elevation as the fix. Not resolved; the `test-fast-clock` feature and the deploy-test build remain in the repo for whenever this is unblocked (Defender protection-history check, or a machine without the restriction).
- **13 Sept 2026** — `stake` and `unstake` **called for real against the devnet deployment**, via `scripts/stake-unstake-devnet-test.mjs`, reusing the same config/test-mint `initialize_config` set up (the config PDA is a singleton, so a second mint isn't possible without redeploying). 13/13 checks passed: a fresh `stake` correctly transfers tokens and computes CAS/tier; a top-up `stake` correctly sums the amount and keeps `staked_at` within the weighted-average blend's expected bound; `unstake` before lock maturity correctly fails with `StillLocked` (error 6005 / `0x1775`), and the position is provably untouched afterward. **Not tested: `unstake`'s success path** — see the local-validator entries below for the full diagnosis.
- **13 Sept 2026** — Local-validator blocker **diagnosed conclusively, root cause confirmed, not fixed here**. Checked Windows Defender's protection history, threat detections, Controlled Folder Access, Attack Surface Reduction audit/block events, and Smart App Control directly (PowerShell `Get-MpThreatDetection`, `Get-MpThreat`, `Get-WinEvent` against the Defender operational log, `Get-MpPreference`) — none showed any block, quarantine, or detection correlating with the failures, and only one AV product (Defender itself) is even registered on this machine. Then tested the hypothesis directly rather than continuing to infer from logs: disabled real-time protection entirely (`Set-MpPreference -DisableRealtimeMonitoring $true`) and retried — **identical failure**, ruling Defender out completely, re-enabled immediately after. A web search then placed this precisely: `solana-test-validator`'s genesis-archive unpacking has a documented history of exactly this failure mode on native Windows ([anza-xyz/agave#24](https://github.com/anza-xyz/agave/issues/24), [solana-labs/solana#23666](https://github.com/solana-labs/solana/issues/23666), [#35629](https://github.com/solana-labs/solana/issues/35629), [#35649](https://github.com/solana-labs/solana/issues/35649)), and the ecosystem's own answer is to run it under WSL or Linux, not native Windows — the same assumption this repo's pre-existing `*-wsl.sh` scripts already made for the mint and treasury work. This converges back to the exact WSL/firmware-virtualization blocker documented at the top of "Toolchain" above; nothing new to try natively on this machine.
- **13 Sept 2026** — **Decision: proceed with devnet-only coverage for now.** `unstake`'s success path stays untested until either WSL is fixed (firmware virtualization enabled, a physical-machine action) or a different Linux/Mac environment is used for this one test. This is a deliberate, informed choice given the amount of native-Windows troubleshooting already exhausted, not an oversight — restated in "Still open" below.
  - **Real bug found by this test, not by inspection**: the tiers passed to `initialize_config` (`1e6, 5e6, 2e7, 7.5e7`) were meant as whole-ACT-token amounts per STAKING_DESIGN.md's own table, but CAS is computed on raw base units (9 decimals) — so a 2-ACT test stake (2,000,000,000 base units) already exceeded every threshold and landed at tier 4 immediately. Fixed on-chain via `scripts/fix-tier-thresholds-devnet.mjs` (`update_tier_config` with the same numbers × 10^9), fixed in `init-devnet-config.mjs` for future re-initializations, and the tier table above now states the base-unit values explicitly rather than only the human-readable whole-token ones, specifically so this doesn't recur when a real mainnet config is set up.

- **14 Sept 2026** — Devnet **program upgrade deployed**: the binary rebuilt after adding `set_config_authority` and the lock-shortening fix (see the two entries below) was pushed live via `solana program deploy` with `--program-id DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH --upgrade-authority devnet-upgrade-authority-keypair.json`, resuming once more through a dropped-write-transactions buffer (the same flaky-network pattern as the original 12 Sept deploy, not a new problem). `solana program show` afterward reported `Data Length: 297208 bytes` — neither the previous on-chain size (286968) nor the local `target/deploy/act_staking.so` (290816) it was built from, which is expected: the CLI is free to over-allocate a `ProgramData` account on upgrade for future headroom, and that padding is inert, not a sign the wrong bytecode landed. Byte-length comparison was deliberately not treated as the correctness proof here; the `set_config_authority` call in the next entry is.
- **14 Sept 2026** — `set_config_authority` **called for real and verified**, via the new `scripts/set-config-authority-devnet.mjs`: signed by the current authority (the throwaway deployer), moving `StakeConfig.authority` to `devnet-upgrade-authority-keypair.json`'s pubkey (`36mcKLqe2dah5erGo1wH1C6FzyVKAfJpNwoxRKZA5UEj`). Read the config back afterward and checked nine things independently, not just that the transaction didn't error: the authority actually changed to the new key, is no longer the old deployer key, and every other field (mint, vault, `total_staked`, tiers, `paused`, bump) is byte-identical to before the call. All 9 passed. This call is also the real proof the upgrade above deployed the new code: `set_config_authority` did not exist in the previous binary, so a successful call against it is a stronger correctness signal than the `ProgramData` size ever could be.
- **14 Sept 2026** — The lock-shortening fix (ceiling instead of floor division on remaining lock days during a top-up stake, see "Program architecture" → `stake` above) shipped in the same binary as the upgrade above and is therefore live on devnet, but has **not** been separately exercised live — the `set_config_authority` verification doesn't touch `stake`'s top-up path, and a true test needs a stake with a lock close to expiry, which either means waiting real days or the still-blocked local-validator route. Recorded here rather than implied by the upgrade succeeding.

## Still open

- [ ] **`unstake`'s success path has not been tested.** The rejection path (early withdrawal fails correctly) is verified; what happens when a lock actually matures and `unstake` is expected to succeed, move tokens back, and close the account, has not been exercised. Root cause of the local-validator blocker is confirmed (native-Windows `solana-test-validator` genesis-unpacking, a documented upstream issue, not this environment's misconfiguration; see the build log's three 13 Sept entries) and isn't quickly fixable here — Defender, privilege, and path have all been ruled out directly, not just assumed. **Decision: proceed with devnet-only coverage for now**; revisit via WSL (once firmware virtualization is enabled) or another Linux/Mac environment. This is the single most important remaining gap before treating this program as functionally verified, and it stays open until one of those two paths happens.
- [ ] **The lock-shortening fix (ceiling division on top-up) has not been exercised live.** It shipped in the 14 Sept upgrade and is live on devnet, but nothing has actually staked, waited most of a lock period, then topped up near expiry to confirm the fixed check behaves as intended rather than just compiling and passing a read-back of unrelated fields. Same underlying blocker as `unstake`'s success path: needs either real elapsed time or the local-validator route.
- [ ] **No test suite has run** in the `anchor test` sense. `tests/act-staking.ts` is a hand-written skeleton, never executed. `scripts/init-devnet-config.mjs`, `scripts/stake-unstake-devnet-test.mjs`, and `scripts/set-config-authority-devnet.mjs` cover the happy paths, one failure path (early unstake), and the config-authority migration manually against live devnet; they aren't a substitute for a suite covering the rest of the failure paths (wrong duration, paused config, zero amount, shortened lock on top-up).
- [ ] **No independent review** — required before any mainnet deployment, per this document's own stated risk (first custom program, holds user funds), and unaffected by everything above succeeding.
- [ ] Tier thresholds and duration multipliers are illustrative placeholders with no holder-distribution data behind them (now at least correctly *scaled* placeholders); revisit the actual numbers once ACT is trading.
- [ ] `website/stake.html` has since been built and linked from site navigation (explaining the mechanism and formula, honestly marked "in development, not live") — ahead of where this document originally said that should happen ("not before [devnet verification], so the UI isn't built against an interface that might still change"). The interface (account layout, instruction signatures) hasn't changed since that page was written, so this is a sequencing note rather than a known inconsistency, but if the account/instruction shapes change during test-suite work, the page's client-side reading code (once written) will need to track that.
