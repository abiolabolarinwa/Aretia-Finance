# Operator Runbook — keys, mainnet tooling, rotation

Status: **draft from source inspection (2026-10-11). Nothing here was executed.** Facts about live authorities are unknown to this repo and must be filled in by the owner.

## Principles
1. No signing key lives in this repository, in CI, or in chat/issue text. `.gitignore` blocks keypair-like files but is only a backstop.
2. Treasury and program authorities are held by the Squads multisig (2-of-3 per `TREASURY_V2.md`); personal/deployer keys should hold **no standing authority** after setup. Verify on-chain; do not trust this document.
3. Mainnet-capable tools are run only by the key holder, on a trusted private machine, after reading the script.
4. Every mainnet action is preceded by a written plan and a dry run/simulation where the tool offers one, and followed by an entry in `docs/audit/RELEASE_VERIFICATION.md`.

## Tool inventory (all high sensitivity; none executed by this review)
| Tool | What it does | Known guardrails | Gaps |
|---|---|---|---|
| `mainnet/gen-deployer.sh` | creates deployer keypair under `$HOME/aretia-mainnet/` | refuses to overwrite, `umask 077` (this branch) | key is plaintext, no BIP39 passphrase → store backups offline |
| `mainnet/stage-a…d-*.sh` | create mint (Token-2022, fee), mint supply to treasury ATA, transfer authorities, revoke mint authority | `set -e` | no confirmation, mixed RPC endpoints (`api.mainnet-beta` vs `publicnode`), state files written to `$HOME` — **F-13**; check if superseded |
| `devnet/*` | local/devnet setup | devnet only by intent | verify cluster before running |
| `scripts/management-fee-proposal/propose-*.mjs` | build Squads proposals (harvest, fee change) | "never executes on its own"; 2-of-3 approval needed | review output with `verify-proposal.mjs` before approving |
| `…/convert-phantom-key.mjs` | writes signer keypair file from a Phantom export | hidden input; 0600 mode (this branch) | long-lived plaintext key file — delete after use |
| `scripts/rebuild-mint/*`, `launch-pool/*`, `treasury-v2-setup/*` | mint v2, pools, test transfer | guard flags present in source (not reviewed in detail) | review before any use |

## Before any mainnet action
- [ ] `solana config get` shows the intended cluster and the intended signer pubkey (compare to the published address list).
- [ ] The plan names the exact instruction, accounts, amounts; simulated on devnet or via transaction simulation.
- [ ] For authority-changing actions: confirm the new authority is the intended Squads vault PDA and **test with a harmless action first**.
- [ ] Second person has reviewed the transaction contents (Squads proposal) independently of the proposer's tooling.

## Rotation / incident
- Suspected key exposure → treat as compromised immediately: move authority off that key via the multisig, revoke API keys, rotate `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `ZEROX_API_KEY`, RPC keys (Vercel + GitHub secrets). Deleting a committed file or rewriting git history does **not** un-leak it.
- Keep an offline record of: multisig members, threshold, vault PDA, program upgrade authority, mint authorities.
- Post-incident: add a finding to `docs/audit/FINDINGS_REGISTER.md`.
