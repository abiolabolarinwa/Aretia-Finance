# Release Verification — Aretia Finance

No release has been verified by this work. This file is the template/record to complete **by an authorised human with network access**; do not fill from assumption.

## On-chain programs
None in this repository. `act-presale` (never deployed) and `act-staking` were removed on 2026-10-12. **Not done and not verifiable from here:** the staking program was deployed on **devnet** at `DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH`; that account may still exist and hold rent. Closing it (and reclaiming the SOL) needs its upgrade authority and is an on-chain action for an authorised human: `solana program close <id> --bootstrap-upgrade-authority …` on devnet. Nothing here did that.

## ACT mint
Mint address, transfer-fee config & withdraw authority, mint/freeze authority state (expected revoked per MINT.md stage D), metadata authority: _to be read from chain by an authorised human._

## Website release
Vercel deploy from tagged commit; env vars set as Sensitive; `CRON_SECRET` matches GitHub secret. Record deploy ID and commit here.
