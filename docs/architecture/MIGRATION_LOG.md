# Migration Log — Aretia Finance

| ID | Date | Change | Behaviour change? | Verification | Rollback |
|---|---|---|---|---|---|
| M-01 | 2026-10-11 | Stage A baseline docs | none | n/a | revert commit |
| M-02 | 2026-10-11 | Move `src/scripts/walletTools.ts` → `src/swings/core/solanaTools.ts`; old path re-exports (`export *`); 36 import sites in `src/swings` repointed (incl. tests/live files) | **None intended.** Pinned: `SWAP_FEE_WALLET`, `TOKEN_PROGRAM_ID`, `KNOWN_TOKENS` snapshot, `isSolanaAddress` cases, identical binding identity across both paths | Pin test written and passing *before* the move; after: 118 files/1,290 tests, typecheck 0/0, api typecheck, build OK; lint warnings 25→3 | `git revert` the commit |
| M-03 | 2026-10-11 | CI: audit blocking at high; `projects-ci.yml`; `.nvmrc`; governance files | CI only | workflow files reviewed, not run on GitHub | revert |
| M-04 | 2026-10-11 | Key-handling hardening in `gen-deployer.sh`, `convert-phantom-key.mjs` | Fail-safe only (refuse overwrite; 0600) | see F-12, F-14 | revert |
| M-06 | 2026-10-11 | Remove dead code: `HomeHero.astro` | none | zero references (grep incl. docs, config, globs); website tests 1,290/1,290, typecheck 0 errors, lint, build 38 pages — identical to before | `git revert` |
| M-08 | 2026-10-12 | **On-chain programs, SDKs and their website surface removed** (the products they supported were cancelled). Deleted the program and SDK trees, their on-chain test crate, design docs, one website page with its nav / search / utilities entries, and the related CI and config entries; added a non-permanent redirect for the removed page. **Relocated, not deleted:** eight AMM-compatibility / test-token files → `scripts/devnet-amm` (own manifest with 9 dependencies; 290→141 locked packages; its `.npmrc` records the Anchor 0.30.1 / Orca peer mismatch). Public wording on the website, in the whitepapers and in the protocol docs was updated to match; technical whitepaper: one section deleted, later sections renumbered with every cross-reference fixed | Yes — the removed programs, SDK surface and page no longer exist; public wording and the technical whitepaper's section numbering changed | website 1,290 tests / `astro check` 0 errors / lint / build 37 pages; no code referenced the removed programs outside their own trees; HTML tag balance unchanged on every edited page | `git revert`; last commit containing the removed code: `7f08c9b`. The code removal and its documentation changes are in one commit, `cdeecd9` |

IDs M-05, M-07 and M-09 were assigned to changes to code that has since been removed; their rows were deleted on 2026-10-12.

## Checklist
- [x] Baseline · [x] Governance files · [x] Boundary lint (report) · [x] Fee/primitive constants out of UI layer
- [ ] Extract `live.ts`/`liveDeps.ts` dependencies (3 exceptions) · [ ] SHA-pin actions
- [ ] Move UI-script business logic (`walletSwings.ts` 2,108 lines) · [ ] ADR on website/extension duplication
