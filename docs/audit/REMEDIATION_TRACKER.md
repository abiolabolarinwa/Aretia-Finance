# Remediation Tracker — Aretia Finance

Legend: ✅ done on branch + evidence · 🟡 partial · ⬜ not started · 👤 needs owner decision/action. "Done" never means merged or externally reviewed.

| ID | Action | State | Evidence / next step |
|---|---|---|---|
| F-05 | Move Solana primitives to `swings/core` with re-export | ✅ | `solanaTools.test.ts`; full suite green; see MIGRATION_LOG M-02 |
| F-12 | `gen-deployer.sh` no overwrite | ✅ | stub test (see register) |
| F-14 | Keypair file mode 0600 | 🟡 | `node --check` only |
| F-07 | CI audit blocking; projects CI | 🟡 | SHA-pin actions 👤 (needs SHA lookup outside tool scope) |
| F-01 | Document npm 11 / `.nvmrc` | ✅ | `.nvmrc`, CONTRIBUTING |
| F-13 | Confirmation guards on mainnet stage scripts | 👤 | owner to confirm whether superseded |
| F-08 | Triage script-project high advisories | 🟡 triaged | per-project reachability notes in THIRD_PARTY_DEPENDENCIES.md |
| F-06 | ADR: share code between website and extension? | 👤 | ADR-0003 written (proposed); owner decision; fee drift 0.58% vs 0.29% to confirm |
| F-09 | Import cycle | ✅ | `madge --circular` clean; suite green. `any`/suppression counts still open |
| F-10 | Status labels on design docs | ⬜ | backlog |
