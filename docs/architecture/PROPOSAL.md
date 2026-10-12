# Aretia Finance — Target Architecture, Migration Map & Plan (Stage A proposal)

> **Note (2026-10-12):** this is the Stage A snapshot. The on-chain programs and SDKs it originally covered were later removed, and the references to them have been deleted from this file. See `docs/audit/FINDINGS_REGISTER.md` for current status.

Date: 2026-10-11 · Companion to [`BASELINE.md`](BASELINE.md) · Status: **proposal. Nothing here is implemented. No files have been moved.**

## 1. Verdict

This repository is a protocol workspace, not a single application. The brief's monorepo template (`apps/`, `packages/domain`, …) does **not** fit it and would mostly create empty packages. The highest-value, lowest-risk path is:

1. Give each existing project the same verification contract (install, test, lint, build, audit, secret scan) in CI.
2. Make the operator tooling reviewable and reproducible — it is among the least verified and most funds-sensitive code (F-04).
3. Enforce the layering that `website/src/swings` already intends, and fix the one proven inversion (F-05).
4. Document module ownership, trust boundaries and an audit pack for the mint and treasury operations, to match what already exists for Swings.

No directory moves are proposed: operator-tooling paths are referenced by docs and scripts.

## 2. Target module map (existing code, grouped by responsibility)

```mermaid
flowchart TD
  subgraph Chain[On-chain · Solana]
    MINT[ACT Token-2022 mint<br/>transfer-fee ext.]
    MS[Squads multisig treasury]
  end
  subgraph Ops[Operator tooling · high sensitivity]
    MN[mainnet/*.sh] --- SC[scripts/*] --- DV[devnet/*]
  end
  subgraph Site[website]
    PAGES[Astro pages / UI scripts]
    SW[src/swings<br/>core · router · engine · chains · dex · solana · shield · tokens · settlement]
    API[api/ Vercel functions<br/>thin entry + _core, env injected]
    DB[(Supabase migrations)]
  end
  EXT[External wallets<br/>Phantom · MetaMask · Aretia Wallet]
  PROV[Providers: Jupiter · 0x · GeckoTerminal · RPC · CCTP · Ramp]
  PAGES --> SW --> EXT
  PAGES --> API --> PROV
  SW --> API
  API --> DB
  Ops --> MINT & MS
```

Intended dependency direction inside `website/src`: `swings/core` and `swings/*` (pure logic, no DOM, no `scripts/`) ← `scripts/*` (UI glue) ← `pages/*`. Today, `swings/core/{fee,feeAssets,token}`, `shield/classify`, `settlement/cctp*` import `scripts/walletTools` (F-05); that edge is reversed in Stage C. Five `swings` files reference `window`/`document` (`chains/evmWallet`, `engine/price`, `wallet/{solanaContextWallet,types,walletConnect}`); these are the wallet-adapter edge and are acceptable if isolated and listed, but must be confirmed individually.

Trust boundaries to document in Stage D: browser ↔ user's wallet (signing) · browser ↔ Vercel API (no provider keys in client) · Vercel ↔ Supabase (service-role key, server-only) · cron secret · operator workstation ↔ mainnet (deployer keypair, Squads signers) · third-party providers/aggregators (untrusted data).

## 3. Proposed directory delta

```
Aretia-Finance/
├── .github/
│   ├── workflows/
│   │   ├── website-ci.yml     # keep; SHA-pin actions; blocking audit threshold
│   │   ├── projects-ci.yml    # NEW: install/build/audit for the script projects
│   │   └── (codeql, swings-discover unchanged)
│   ├── CODEOWNERS  dependabot.yml  pull_request_template.md   # NEW
├── docs/
│   ├── architecture/   # BASELINE.md, PROPOSAL.md, OVERVIEW.md, MIGRATION_LOG.md
│   ├── adr/            # NEW
│   ├── audit/          # NEW: audit pack (scope, privileged ops, controls, findings, remediation, evidence, releases)
│   └── security/       # NEW: key management & operator runbook, treasury/multisig model
├── CONTRIBUTING.md  SECURITY.md  .nvmrc   # NEW
└── (scripts/, mainnet/, devnet/, website/ unchanged)
```

`website/docs/audit` and `website/docs/aretia-swings` stay where they are (they scope Swings); the new root `docs/audit` covers the operator tooling and the mint/treasury side and links to them rather than duplicating.

## 4. File migration map

| From | To | Stage | Risk / gate |
|---|---|---|---|
| — | `docs/*`, governance files | B | None |
| `SWAP_FEE_WALLET`, `KNOWN_TOKENS`, `isSolanaAddress`, `ataAddress`, `TOKEN_PROGRAM_ID` in `src/scripts/walletTools.ts` | `src/swings/core/config.ts` (new), with `walletTools.ts` re-exporting the same names | C | **Fee-destination-sensitive.** Precondition: a test asserting current values/behaviour; values must be byte-identical; separate PR; owner review |
| `solana/meteoraDbc.ts ↔ poolHints.ts` cycle | extract shared type/helper | C | Low |
| Logic in `src/scripts/walletSwings.ts` (2,108 lines) and `walletApp.ts` | into `src/swings/*` use-case modules | later / backlog | Medium; only with test coverage per extracted piece; not part of this effort's first pass |

## 5. Gates to add (Stage B, minimal and reversible)

- **Install integrity:** regenerate `website/package-lock.json` using CI's Node/npm and prove `npm ci` passes (F-01). Lockfile-only change, no dependency version changes.
- **CI:** SHA-pin actions; `permissions` least-privilege per job (already good); make `npm audit --omit=dev --audit-level=high` blocking with a dated allow-list for known issues (current: 3 moderate, so a `high` threshold passes today); add `projects-ci.yml` for the script projects; extend gitleaks to a pre-merge check on all paths.
- **Boundary rule:** ESLint `no-restricted-imports` (already a dependency) forbidding `src/swings/**` → `src/scripts/**` and `src/pages/**`, introduced in *report-only* mode, with the five known violations in an explicit, dated exceptions list that shrinks as F-05 is fixed.
- **Config:** `website/.env.example` already exists with placeholders; add a startup/readiness validation reference to `docs` (the repo already has `npm run readiness` — to be reviewed, not assumed sufficient).

## 6. Prioritised plan

| # | Stage | Task | Acceptance |
|---|---|---|---|
| 1 | B | Fix lockfile (F-01) | `npm ci` exits 0 with CI's npm |
| 2 | B | Governance files; CODEOWNERS for `mainnet/`, `scripts/`, `website/api`, `website/src/swings/{core,router,engine,wallet,shield}`, `.github/` | Files exist |
| 3 | B | Operator-tooling review: inventory of every script that touches keys/mainnet, with required confirmations and who may run it (F-04) | `docs/security/OPERATOR_RUNBOOK.md` + findings |
| 4 | B | Lint boundary rule (report-only) | Violations listed |
| 5 | D | Audit pack: scope, privileged operations, mint/freeze/fee authority state | `docs/audit/*`, with "unverified" where applicable |
| 6 | C | Pin fee behaviour with tests; relocate constants (F-05) | Tests identical before/after; diff reviewed |
| 7 | D | Triage 3 moderate advisories (`jayson`/`stream-json`) | Reachability recorded |
| 8 | ADR | Website ↔ extension duplication (F-06) | Decision recorded; no code change |

## 7. Risk register (initial)

| ID | Risk | Likelihood | Impact | Basis | Mitigation |
|---|---|---|---|---|---|
| R-03 | Operator key handling error (mint/treasury authority) | Low–Medium | Critical | F-04 | Runbook, multisig-only authorities (Squads), dry-run flags, no keys on dev machines — confirm actual state |
| R-04 | Swap-fee destination or fee maths changed by an unrelated edit to a UI helper | Low | High | F-05 | Pinning test; relocate behind compatibility re-export |
| R-05 | Provider data (token metadata, quotes) manipulates user flows | Medium | High | Swings threat model already exists | Existing `judgeSwapSimulation`/Shield; re-review in Stage D |
| R-06 | Production cron secret/endpoint abuse | Low | Medium | `swings-discover.yml` | Secret rotation procedure documented |
| R-07 | Docs overstate readiness | Medium | High | F-10 | Add "implemented / designed only" status to each protocol doc |

## 8. Approval needed

Stage B items are documentation, CI and governance only. I intend to proceed with those after your confirmation of this plan. I will **not**, without explicit approval: regenerate or change dependency versions beyond the single lockfile fix, run any `mainnet/` or `scripts/` operator tool, touch fee/treasury configuration, or deploy anything.
