# Management Fee — Wallet Record

**Status:** ✅ Wallet designated, 3 Sept 2026. Not yet funded — no fees have accrued, since ACT has no live liquidity pool and isn't trading yet.

| Field | Value |
|---|---|
| Purpose | Receives the 0.1% management fee slice of the 4.1% transfer fee — funds Aretia Finance LLC's operational cost of running the treasury (registry/credit verification, Impact Report review, site visits, dashboard upkeep). See `TOKENOMICS.md` §01–02. |
| Address | `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2` |
| Custody | Single account inside the founder's existing Phantom wallet (same seed phrase, new derived account) — deliberately lighter-weight than the 2-of-3 treasury multisig, since this is an operational expense account, not the project-funding treasury. |
| Network | Solana Mainnet |
| Current balance | 0 — nothing to fund it with yet. |

## Why this is separate from the treasury multisig

`TREASURY.md` flagged this as open: *"Set up a separate, lighter-weight wallet for the 0.1% management/operations fee, distinct from this 2-of-3 governance multisig."* Keeping it apart from `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg` means the two flows can never get commingled by accident, and the transparency dashboard (once built) can show "funded climate projects" and "operational costs" as genuinely separate on-chain totals — not just a reporting label on the same pool.

## How it actually gets funded (mechanism, not yet executed)

Token-2022's transfer-fee extension withholds one flat 4.1% per transfer — it does not split on-chain into the 2% / 1% / 1% / 0.1% buckets. Splitting is a manual step, done after harvesting:

1. Withheld fees accumulate in each holder's token account as ACT trades.
2. The treasury multisig (holder of the withdraw-withheld authority) harvests them into the treasury vault.
3. From that harvested amount, the treasury multisig sends the management-fee share — 0.1% ÷ 4.1% ≈ 2.44% of whatever was harvested — to this wallet as a normal transfer. The remaining ~97.56% (2% treasury + 1% liquidity + 1% burn, proportionally) stays with its intended purpose.

Step 3 requires a real treasury-multisig transaction each time it runs. Nothing to execute yet — there's a $0 amount to harvest until liquidity is seeded and trading starts.

## Harvest-and-split tooling

A manual-run script drafts the harvest + split as a Squads proposal — it never executes anything itself, only 2-of-3 approval in Squads does. See [`scripts/management-fee-proposal/`](scripts/management-fee-proposal/README.md).

**Dry-run verified, 3 Sept 2026.** Ran successfully against live mainnet: read the mint's real transfer-fee config (410 bps, matches `MINT.md`), scanned every Token-2022 account tied to the ACT mint, found 0 accounts with withheld fees, and exited cleanly — exactly the expected result pre-liquidity. The scan and fee-read logic is now confirmed correct against real on-chain data, not just against docs. `--execute` still hasn't been run — no reason to yet, since there's nothing to harvest.

Note: the default RPC endpoint (`solana-rpc.publicnode.com`) failed with a generic `fetch failed` on the first attempt; swapping to `https://api.mainnet-beta.solana.com` via the `RPC_ENDPOINT` env var worked immediately. Likely a transient issue with that specific public endpoint rather than anything wrong with the script — worth retrying the default next time, and keeping the override in your back pocket if it acts up again.

## Still open

- [x] Dry-run the harvest-and-split script against live mainnet — done, 3 Sept 2026. Scan and fee-read logic confirmed correct.
- [ ] First real harvest-and-split cycle — blocked on liquidity going live and real trading volume accruing fees.
- [ ] Decide the cadence (per-transaction, weekly, monthly) once there's real volume to look at. The script can be scheduled once that's decided.
- [ ] Reference this wallet on the transparency dashboard as its own line, once that's built.

Public address only. No private keys, seed phrases, or personal signer information belong in this file or this repository, ever.
