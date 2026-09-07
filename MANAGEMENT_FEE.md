# Management Fee — Wallet Record

**Status:** ✅ Wallet designated, 3 Sept 2026. Not yet funded — no fees have accrued, since ACT has no live liquidity pool and isn't trading yet.

**6 Sept 2026 update:** the management fee is raised from 0.1% to 0.5% of transfer volume, and the 1% burn allocation is removed (total transfer fee: 4.1% → 3.5%). Approved 2-of-3 and executed on-chain the same day — see `MINT.md`'s fee-authority section for the transaction and current status (scheduled for epoch 1031; check there before assuming 3.5% is already the rate being charged). This is also the fee stream `ATTORNEY_BRIEF.md` §4 Q3 asked counsel about at the old 0.1% figure; that question is reopened at 0.5% and hasn't been re-reviewed.

**7 Sept 2026 update:** a second, separate revenue stream into this wallet was added — a 1,000 ACT project-registration fee, paid by project developers when applying for catalyst-fund financing. See "Project registration fee" below. Not yet built (no wallet-connect or on-chain payment flow exists on `apply.html` yet), and not yet reviewed by counsel.

| Field | Value |
|---|---|
| Purpose | Two revenue streams, both funding Aretia Finance LLC's operational costs: (1) the 0.5% management fee slice of the 3.5% transfer fee, and (2) a 1,000 ACT project-registration fee paid by developers applying for funding. See `TOKENOMICS.md` §01–02 and "Project registration fee" below. |
| Address | `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2` |
| Custody | Single account inside the founder's existing Phantom wallet (same seed phrase, new derived account) — deliberately lighter-weight than the 2-of-3 treasury multisig, since this is an operational expense account, not the project-funding treasury. |
| Network | Solana Mainnet |
| Current balance | 0 — nothing to fund it with yet. |

## Why this is separate from the treasury multisig

`TREASURY.md` flagged this as open: *"Set up a separate, lighter-weight wallet for the 0.1% management/operations fee, distinct from this 2-of-3 governance multisig."* (Written when the fee was still 0.1%; the wallet itself doesn't change with the rate.) Keeping it apart from `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg` means the two flows can never get commingled by accident, and the transparency dashboard (once built) can show "funded climate projects" and "operational costs" as genuinely separate on-chain totals — not just a reporting label on the same pool.

## How it actually gets funded (mechanism, not yet executed)

Token-2022's transfer-fee extension withholds one flat rate per transfer (3.5%, confirmed on-chain for epoch 1031 — see `MINT.md` for current status) — it does not split on-chain into the 2% / 1% / 0.5% buckets. Splitting is a manual step, done after harvesting:

1. Withheld fees accumulate in each holder's token account as ACT trades.
2. The treasury multisig (holder of the withdraw-withheld authority) harvests them into the treasury vault.
3. From that harvested amount, the treasury multisig sends the management-fee share — 0.5% ÷ 3.5% ≈ 14.29% of whatever was harvested — to this wallet as a normal transfer. The remaining ~85.71% (2% treasury + 1% liquidity, proportionally) stays with its intended purpose.

Step 3 requires a real treasury-multisig transaction each time it runs. Nothing to execute yet — there's a $0 amount to harvest until liquidity is seeded and trading starts.

## Harvest-and-split tooling

A manual-run script drafts the harvest + split as a Squads proposal — it never executes anything itself, only 2-of-3 approval in Squads does. See [`scripts/management-fee-proposal/`](scripts/management-fee-proposal/README.md).

**Dry-run verified, 3 Sept 2026.** Ran successfully against live mainnet: read the mint's real transfer-fee config (410 bps, matches `MINT.md`), scanned every Token-2022 account tied to the ACT mint, found 0 accounts with withheld fees, and exited cleanly — exactly the expected result pre-liquidity. The scan and fee-read logic is now confirmed correct against real on-chain data, not just against docs. `--execute` still hasn't been run — no reason to yet, since there's nothing to harvest.

Note: the default RPC endpoint (`solana-rpc.publicnode.com`) failed with a generic `fetch failed` on the first attempt; swapping to `https://api.mainnet-beta.solana.com` via the `RPC_ENDPOINT` env var worked immediately. Likely a transient issue with that specific public endpoint rather than anything wrong with the script — worth retrying the default next time, and keeping the override in your back pocket if it acts up again.

## Project registration fee (7 Sept 2026, built; decisions below settled)

A project developer applying for catalyst-fund financing pays a **1,000 ACT registration fee**, sent to this wallet, at the point of application (`apply.html`, Section 8 step 1 in `PROTOCOL.md`). No voting mechanism sits around this — the earlier idea of a community vote per category was considered and dropped (see conversation history) in favor of the existing, already-documented team-curated selection process (`WHITEPAPER.md` §9.3): management reviews applications and decides which projects proceed, under the same milestone-verification discipline (`WHITEPAPER.md` §7) as everything else.

**Rationale:** covers the real cost of reviewing an application — the same category of work (`registry/credit verification, Impact Report review, site visits, dashboard upkeep`) this wallet already exists to fund, per the Purpose row above. Charging an application fee to the same entity that reviews and decides is a real conflict-of-interest pattern in the abstract; the fee is defensible specifically because it's sized to cost-recovery for review work, not because it changes who benefits from an approval decision.

**Decided, 7 Sept 2026:**
- **Non-refundable.** The fee is forfeited regardless of outcome — it is priced as cost recovery for reviewing the application, not a stake in being funded, and is not returned or credited if a project is rejected.

**Still open:**
- **Fee value is undefined pre-launch.** 1,000 ACT has no fixed dollar cost until ACT trades. Revisit the number once there's a real price — it could turn out to be trivial (no deterrent effect, no real cost recovery) or exclusionary for smaller developers, particularly in the Technical Assistance category, which by its own definition (`WHITEPAPER.md` §8.2) often serves less-resourced applicants.
- **Not yet reviewed by counsel.** This is new legal surface area under `PROTOCOL.md` §16's existing "everything added beyond the original simple treasury mechanism" flag — an application-fee-to-the-decision-maker structure is exactly the kind of thing that draws regulatory scrutiny if not clearly bounded to actual cost recovery. This applies with or without a refund policy; forfeiture on rejection, specifically, is the version of this fact pattern that reads most like the operator profiting from rejections, not less — flag this explicitly to counsel, don't let the "it's just cost recovery" framing go unquestioned.

**Built, 7 Sept 2026:** `apply.html` requires paying 1,000 ACT before the submit button unlocks, via two paths:
1. **Connect and pay in-page** — Phantom, Solflare, or Backpack. A real `TransferChecked` instruction to this wallet's Token-2022 associated token account (idempotently created if needed). Trust Wallet is deliberately excluded from this path — its browser-extension provider doesn't reliably expose the same connect/sign interface these three share, and Solana support there has historically been mobile-app-focused rather than desktop-extension-focused.
2. **Manual verification** — for any payment made a different way (Trust Wallet, a CEX withdrawal, a different device): paste the transaction signature and the page looks it up on Solana directly, checking `pre`/`postTokenBalances` for a real increase of at least ~950 ACT in the management wallet's balance, before unlocking submit. Works regardless of how the transfer was constructed, since it checks the actual balance change rather than assuming a specific instruction shape — which is also why it isn't limited to any particular wallet or exchange.

Uses `@solana/web3.js` and `@solana/spl-token` loaded from `esm.sh` (not jsdelivr's `+esm` — that auto-bundles each package with its own copy of shared dependencies, which broke spl-token's internal layout checks when tested against a real HTTP origin; esm.sh's `?deps=` parameter dedupes correctly, verified before shipping).

**Verified in-browser, against real mainnet data:**
- Both instructions (path 1) build successfully with the correct program IDs, ATA derivations resolve to valid addresses.
- All three wallet-detection paths (Phantom/Solflare/Backpack) correctly report "not found" when absent.
- The manual verification path (path 2) was tested against a real, confirmed mainnet transaction (the `SetTransferFee` proposal signature, `4YwPZzV3q5yr...KfLD` — see `MINT.md`) and correctly rejected it with an accurate reason ("doesn't show any ACT received by the management wallet"), since that transaction is real but isn't an ACT payment. This is the strongest test actually available — no real ACT payment to this wallet exists yet to test the *accept* path against, since liquidity hasn't launched.
- No horizontal overflow at 390px or 1440px.

**Not verified:** an actual successful payment end-to-end (path 1's `signAndSendTransaction` call, or path 2 against a real qualifying transaction) — both need either a funded wallet or a real prior payment, neither of which can exist yet since ACT has no liquidity pool.

The client-side gate (disabled submit button) — and the manual verification path — are UX affordances, not the real enforcement, even though path 2 does check on-chain state: a technically motivated applicant could still bypass the page's JS entirely and POST straight to Formspree. See the code comment in `apply.html` and confirm `payment_tx_signature` against Solscan manually when reviewing any application, regardless of which path it came from.

## Still open

- [x] Dry-run the harvest-and-split script against live mainnet — done, 3 Sept 2026. Scan and fee-read logic confirmed correct.
- [ ] First real harvest-and-split cycle — blocked on liquidity going live and real trading volume accruing fees.
- [ ] Decide the cadence (per-transaction, weekly, monthly) once there's real volume to look at. The script can be scheduled once that's decided.
- [ ] Reference this wallet on the transparency dashboard as its own line, once that's built.

Public address only. No private keys, seed phrases, or personal signer information belong in this file or this repository, ever.
