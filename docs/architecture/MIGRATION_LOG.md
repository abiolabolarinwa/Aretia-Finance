# Migration Log — Aretia Finance

| ID | Date | Change | Behaviour change? | Verification | Rollback |
|---|---|---|---|---|---|
| M-01 | 2026-10-11 | Stage A baseline docs | none | n/a | revert commit |
| M-02 | 2026-10-11 | Move `src/scripts/walletTools.ts` → `src/swings/core/solanaTools.ts`; old path re-exports (`export *`); 36 import sites in `src/swings` repointed (incl. tests/live files) | **None intended.** Pinned: `SWAP_FEE_WALLET`, `TOKEN_PROGRAM_ID`, `KNOWN_TOKENS` snapshot, `isSolanaAddress` cases, identical binding identity across both paths | Pin test written and passing *before* the move; after: 118 files/1,290 tests, typecheck 0/0, api typecheck, build OK; lint warnings 25→3 | `git revert` the commit |
| M-03 | 2026-10-11 | CI: audit blocking at high; `projects-ci.yml`; `.nvmrc`; governance files; `Cargo.lock` un-ignored | CI only | workflow files reviewed, not run on GitHub | revert |
| M-04 | 2026-10-11 | Key-handling hardening in `gen-deployer.sh`, `convert-phantom-key.mjs` | Fail-safe only (refuse overwrite; 0600) | see F-12, F-14 | revert |

## Checklist
- [x] Baseline · [x] Governance files · [x] Boundary lint (report) · [x] Fee/primitive constants out of UI layer
- [ ] Extract `live.ts`/`liveDeps.ts` dependencies (3 exceptions) · [ ] SHA-pin actions · [ ] Commit program lockfiles/toolchain
- [ ] Program tests/CI (F-02) · [ ] F-15/F-16/F-17 program changes (need owner approval) · [ ] Move UI-script business logic (`walletSwings.ts` 2,108 lines) · [ ] ADR on website/extension duplication
