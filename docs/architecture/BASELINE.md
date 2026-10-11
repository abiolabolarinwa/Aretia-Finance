# Aretia Finance — Baseline (Stage A)

Date: 2026-10-11 · Branch: `claude/vigilant-fermi-990xab` · Base commit: `a716796`
Status: **inspection only. No source, config or lockfile was changed to produce this document.**

Evidence legend: **[inspected]** read in source · **[executed]** command run, result recorded · **[unable to verify]** could not be run here.

Environment: Node v22.22.0 / npm 10.9.4, rustc 1.97.0, Linux sandbox **without general internet access**. Scope note: the task covers two repositories. This file covers `Aretia-Finance`; the separate `aretia-wallet` repository has its own `docs/architecture/BASELINE.md` on the same branch name. Cross-repo relationships are in §2.

## 1. Repository structure [inspected]

Not a monorepo: a protocol repository containing **nine independent Node/Rust projects, each with its own lockfile and no shared tooling**, plus ~16 root-level design documents. 688 tracked files (572 in `website/`).

| Path | Kind | Notes |
|---|---|---|
| `program/act-presale` | Anchor 0.30.1 program (`lib.rs`, 1,509 lines) | "Devnet only; not yet deployed anywhere" (Cargo description); `test = anchor test` |
| `program/act-staking` | Anchor 0.30.1 program (`lib.rs`, 476 lines) | "Deployed on devnet; not yet on mainnet"; tests are TS/mocha against devnet |
| `sdk/act-presale`, `sdk/act-staking`, `sdk/idl` | TypeScript clients + IDL JSON | Only a `build` script; no tests |
| `mainnet/*.sh`, `devnet/*.sh|ps1` | Operator shell scripts: create mint, mint to treasury, transfer/revoke authorities | Security-sensitive; read keys from `$HOME` paths |
| `scripts/{launch-pool,management-fee-proposal,rebuild-mint,treasury-v2-setup}` | Node `.mjs` operator tooling (Squads multisig proposals, mint v2, pools) | Each has its own `package.json` + lockfile; includes `convert-phantom-key.mjs` which reads a private key |
| `website/` | Astro 7 site + Vercel serverless `api/` + Supabase migrations; contains the **Aretia Swings** swap engine (`src/swings`, ~25k LOC), **Shield**, the web wallet UI (`src/scripts/wallet*.ts`), SafeSend/Pay/Ramp pages, radar proxy | 377 TS + 57 Astro files; 117 test files |
| `.github/workflows` | `website-ci.yml`, `codeql.yml`, `swings-discover.yml` (cron every 10 min → production endpoint) | |
| Root `*.md` | PROTOCOL, TOKENOMICS, WHITEPAPER(_TECHNICAL), PRESALE_DESIGN, STAKING_DESIGN, MINT(_V2), TREASURY(_V2), MANAGEMENT_FEE, LAUNCH_CHECKLIST, legal templates | Design records; several describe unimplemented modules |
| `website/docs/audit/*`, `website/docs/aretia-swings/*` | Existing audit-prep docs (scope, threat model, trust model, privileged ops, known risks; swings security model, audit package, readiness attestations) | Swings only; **the on-chain programs and mint operations have no equivalent audit pack** |

Absent [inspected]: `CODEOWNERS`, `SECURITY.md`, `CONTRIBUTING.md`, PR/issue templates, dependabot/renovate, `.nvmrc`/Node pin, `rust-toolchain.toml`, committed `Cargo.lock`, any CI for `program/`, `sdk/`, `scripts/`, `mainnet/`.

## 2. Existing architecture [inspected]

**On-chain:** ACT is a Token-2022 mint with a transfer-fee extension (MINT.md / `mainnet/stage-*.sh`); presale and staking are Anchor programs; treasury is a Squads multisig (TREASURY_V2.md, `devnet/multisig-signers.md`). `Anchor.toml` lists the **same program ID under `[programs.devnet]` and `[programs.mainnet]`** for both programs, while their own descriptions say they are not on mainnet; whether that ID is deployed on mainnet is **not verified** (no network).

**Off-chain, website:** Astro pages → client scripts (`src/scripts/wallet*.ts`) → the Swings library (`src/swings/{core,router,engine,solana,dex,chains,wallet,shield,tokens,market,settlement,account,…}`) → provider calls via Vercel functions in `api/` (0x, Jupiter quote, GeckoTerminal, RPC proxy, ramp, Supabase). API handlers follow a good pattern: thin `api/x.ts` entry + testable `api/_x.ts` core with `env` injected (`env: process.env`) rather than read globally.

**Custody model** (from `src/swings/wallet/types.ts` and `sessionManager.ts`, plus grep): the web app is **non-custodial by design** — signing is delegated to the user's connected wallet (Wallet Standard / EIP-1193 / the Aretia Wallet extension via `window.AretiaWallet`); only the three files that mention key terms were found, and they are a comment contract, a comment and a telemetry redaction regex. This is an inspection-level finding, not a verified guarantee.

**Relationship to `aretia-wallet`:** the extension repo contains an independent Jupiter/viem/Solana implementation, SafeSend, bridge and ACT config; the website re-implements swap routing, chain adapters, Shield and SafeSend-adjacent UI. **Two codebases implement overlapping concerns with no shared package**; any fee, slippage or address-validation rule is duplicated and can drift. Whether consolidation is wanted is a product/ownership decision (ADR needed), not something to do structurally.

**Layer inversion [inspected]:** `src/swings/core/{fee,feeAssets,token}.ts`, `shield/classify.ts`, `settlement/cctp*.ts` import from `../../scripts/walletTools.js` — the supposedly pure Swings *core* depends on a UI-script module (it supplies `SWAP_FEE_WALLET`, `KNOWN_TOKENS`, `isSolanaAddress`, `ataAddress`, `TOKEN_PROGRAM_ID`). Fee wallet and fee constants live in a UI helper rather than in the core/config layer. `madge --circular` also reports one real cycle: `swings/solana/meteoraDbc.ts ↔ poolHints.ts`.

## 3. Verification results [executed]

`website/` was verified in a scratch copy (`git archive HEAD website`) because `npm ci` fails in the repository itself (see F-01); the repo tree was not modified.

| Check | Command | Result | Class |
|---|---|---|---|
| Install (as CI does) | `npm ci` in `website/` | **FAIL (exit 1):** lockfile out of sync with `package.json` — `Missing: typescript@5.9.3 from lock file` | Pre-existing; **would fail `website-ci.yml`** unless CI's newer npm resolves it (not tested; CI uses Node 24/npm 11) |
| Install (scratch) | `npm install --ignore-scripts` | exit 0, 757 packages | n/a |
| Unit tests | `npm test` (Vitest 5) | **117 files / 1,286 tests passed, 0 failed**, 27 s | Pass |
| Typecheck | `npm run typecheck` (`astro check`) | 0 errors, 0 warnings, 9 hints (394 files) | Pass |
| API typecheck | `npm run typecheck:api` | exit 0 | Pass |
| Lint | `npm run lint` | exit 0 | Pass |
| Build | `npm run build` | exit 0, 38 pages | Pass |
| Dependency audit | `npm audit --omit=dev` | exit 1: **3 moderate** (`jayson` → `stream-json`, via `@solana/web3.js` 1.99.x) | Pre-existing; CI runs it with `\|\| true`, so it never fails |
| Secret scan (regex over tracked files + history, names only) | private-key/AWS/Stripe/GitHub-token patterns, plus tracked-filename check for keypairs/`.env` | No matches. Only `website/.env.example` is tracked (placeholders; values not printed). Dedicated scanner is in CI (`gitleaks`) but was **not run here** | Pass (grep-level); [unable to verify] with gitleaks |
| Anchor programs | `anchor test`, `cargo build` | **Not run:** Anchor CLI/Solana toolchain absent; programs contain **0 in-source Rust tests** | [unable to verify] |
| SDK, `scripts/`, `mainnet/` | — | No tests, no CI | Not implemented |
| Live-network suites | `npm run test:live` | Not run (no network) | [unable to verify] |

## 4. Findings

| ID | Severity | Class | Finding |
|---|---|---|---|
| F-01 | Medium | Pre-existing | `website/package-lock.json` is out of sync (`npm ci` fails locally). Reproducible-install guarantee is broken until verified on CI's npm. The lockfile contains only `typescript@6.0.3`; npm 10.9.4 expects a nested `typescript@5.9.3` entry for some dependency (not identified). A fresh `npm install` in the scratch copy resolved cleanly with everything deduped to 6.0.3, so the fix is probably only a lockfile regeneration — but that must be done with CI's npm version and re-verified, not assumed. |
| F-02 | High | Pre-existing | **No automated verification of the on-chain programs.** Zero Rust tests; TS tests require a validator/devnet; no CI job. Presale and staking handle user funds. |
| F-03 | High | Pre-existing | `program/*/Cargo.lock` is **git-ignored** (`.gitignore`), so program builds are not reproducible and a deployed binary cannot be tied to a dependency set. Also no `rust-toolchain.toml`. |
| F-04 | High | Requires human review | Operator tooling that reads/produces keys (`scripts/management-fee-proposal/convert-phantom-key.mjs`, `mainnet/gen-deployer.sh`, `mainnet/stage-*.sh`) is in the repo with no CI, tests or documented change control. I did **not** run any of it and did not read secrets. Whether the mainnet scripts have a confirmation guard before sending was not verified. |
| F-05 | Medium | Pre-existing | Layer inversion and fee constants located in a UI helper (§2). Changing `walletTools.ts` could silently change swap-fee destination for the "core". Needs a test pinning `SWAP_FEE_WALLET` and fee maths before any move. |
| F-06 | Medium | Pre-existing | Duplicate implementations of swap/chain/Shield logic across `Aretia-Finance/website` and `aretia-wallet` (§2). |
| F-07 | Medium | Pre-existing | CI covers only `website/`. `swings-discover.yml` hits a production URL every 10 min with a bearer secret (least-privilege `permissions: {}` is good; request target is hard-coded). Actions are tag-pinned (`@v4`/`@v2`), not SHA-pinned. `npm audit` is non-blocking. |
| F-08 | Low | Pre-existing | Nine independent lockfiles/dependency sets in operator scripts and SDKs with no audit coverage. |
| F-09 | Low | Pre-existing | One true cycle in `swings/solana`; 11 `any`, 3 lint/ts suppressions in `src`+`api`. |
| F-10 | Info | Requires human review | Root design docs mix implemented and aspirational features (PROTOCOL.md itself says "not all eight exist yet"). Existing `website/docs/audit` correctly says what does not exist yet for Swings; the same discipline is absent for on-chain/treasury docs. |
| F-11 | Info | Requires human review | `Anchor.toml` mainnet program IDs vs. "not deployed" descriptions (§2). |

Nothing above was fixed in Stage A.

## 5. Critical dependencies

`anchor-lang/anchor-spl 0.30.1`, `pyth-solana-receiver-sdk 0.3.1` (presale pricing oracle) · `@solana/web3.js ^1.99` (moderate advisories) · `@walletconnect/ethereum-provider` · `@bonfida/spl-name-service` · `@noble/curves 1.9.7` (pinned) · Astro 7, Vitest 5, TypeScript 6 (all recent majors) · Supabase (service-role key server-side), Vercel, 0x, Jupiter, GeckoTerminal, Squads multisig, Circle CCTP (`swings/settlement/cctp.ts`).

## 6. Areas of high complexity (signals)

`src/scripts/walletSwings.ts` (2,108 lines, UI script containing swap flow) · `src/pages/wallet/index.astro` (1,476) · `src/scripts/walletApp.ts` (1,287) · `walletShield.ts` (931) · `src/swings/dex/entries.ts` (810) · `dex/directEvm.ts` (610) · `solana/directSolana.ts` (525). `src/swings/solana` (5.3k) and `dex` (5.0k) are the largest subsystems. Business logic embedded in UI scripts is the main structural smell.

## 7. Recommended order (details in `PROPOSAL.md`)

1. Resolve F-01 (regenerate lockfile with CI's npm; verify `npm ci`).
2. Track `Cargo.lock`; pin toolchain; add program CI (build + a first set of Rust/LiteSVM tests for invariants) — **no program source changes**.
3. Document and review operator-key tooling (F-04) before any mainnet step.
4. Pin `SWAP_FEE_WALLET`/fee behaviour with tests, then relocate constants into `swings/core/config` with a compatibility re-export.
5. Governance files, SHA-pinned actions, blocking audit threshold with allow-list, extend CI to `sdk/` and `scripts/`.
6. Decide, via ADR, whether the website and extension share a package.
