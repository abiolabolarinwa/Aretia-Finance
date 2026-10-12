# Security Controls — Aretia Finance

Only controls observed in source/CI are listed. "Evidence" is where to look; "Verified" says whether a check was executed.

| Control | Where | Evidence | Verified |
|---|---|---|---|
| Authority-gated admin (has_one) | both programs | `UpdateConfig`, `Finalize` etc. | read; not tested |
| Pause that never blocks exit (staking: `unstake`) | programs | doc comments + code paths | read; not tested |
| Checked arithmetic / `overflow-checks = true` (release) | `Cargo.toml` | profile + `checked_*` | read |
| Token-2022 fee handled by balance delta / gross-up | staking `stake` | code | read; devnet suite exists, results not reviewed |
| Keypairs/.env ignored by git | `.gitignore` | patterns | grep-verified no tracked keypair/.env files (only `.env.example`) |
| Secret scanning of full history | `website-ci.yml` `secrets` job (gitleaks) | workflow | **not executed here** |
| SAST | `codeql.yml` (security-extended) | workflow | not executed here |
| Dependency advisories | `website-ci.yml` blocking at `high` (this branch) | workflow | `npm audit --omit=dev --audit-level=high` exit 0 locally |
| Least-privilege workflow permissions | all workflows | `contents: read` / `{}` | read |
| Env injected into API cores (no global reads) | `website/api/*` | `env: process.env` param | read |
| Non-custodial web wallet integration | `swings/wallet/*` | comments + grep | inspected; not independently verified |
| Telemetry redaction of secret-like keys | `swings/observability/telemetry.ts` | regex | read |
| Key-file creation hygiene | `gen-deployer.sh`, `convert-phantom-key.mjs` | this branch | F-12 verified w/ stub; F-14 syntax only |
| Architecture boundary lint | `website/eslint.config.js` | rule (warn) | executed: 3 warnings remain |
| Code owners / PR template / dependabot | `.github/` | files | exist; branch protection must be enabled by owner |

Not implemented: program tests, program CI, SHA-pinned actions, SBOM, signed releases, on-chain verification of deployed bytecode.
