# Release Verification — Aretia Finance

No release has been verified by this work. This file is the template/record to complete **by an authorised human with network access**; do not fill from assumption.

## Per program (act-presale, act-staking)
| Item | Value |
|---|---|
| Git commit/tag built | _unknown_ |
| Rust toolchain, Anchor/Solana CLI versions | _unknown — no pin in repo_ |
| `Cargo.lock` committed? | **No** (ignore rule removed on this branch; owner to commit lock that built the binary) |
| Build command (verifiable build, e.g. `anchor build --verifiable` / solana-verify) | _unknown_ |
| Local binary SHA-256 | _unknown_ |
| Deployed program ID / cluster | `Anchor.toml`: presale `5hmgnujNib14NDkEgRsLpY3H8SBDCsLryiymNKY6fWku`, staking `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH` (same under devnet and mainnet keys — live state unverified) |
| On-chain executable-data hash == local hash? | _not verified_ |
| Upgrade authority (address / who holds it) | _unknown_ |
| Config `authority` (address; Squads vault PDA?) | _unknown_ |
| IDL in `sdk/idl` matches on-chain IDL? | _not verified_ |

## ACT mint
Mint address, transfer-fee config & withdraw authority, mint/freeze authority state (expected revoked per MINT.md stage D), metadata authority: _to be read from chain by an authorised human._

## Website release
Vercel deploy from tagged commit; env vars set as Sensitive; `CRON_SECRET` matches GitHub secret. Record deploy ID and commit here.
