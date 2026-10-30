# Management Fee — Wallet Record

**Status:** ✅ Wallet designated, 3 Sept 2026. Not yet funded — no fees have accrued, since ACT has no live liquidity pool and isn't trading yet.

**6 Sept 2026 update:** the management fee is raised from 0.1% to 0.5% of transfer volume, and the 1% burn allocation is removed (total transfer fee: 4.1% → 3.5%). Approved 2-of-3 and executed on-chain the same day — see `MINT.md`'s fee-authority section for the transaction and current status (scheduled for epoch 1031; check there before assuming 3.5% is already the rate being charged). This is also the fee stream counsel was previously asked about at the old 0.1% figure; that question is reopened at 0.5% and hasn't been re-reviewed.

**7 Sept 2026 update:** a second, separate revenue stream into this wallet was added — a project-registration fee, paid by project developers when applying for catalyst-fund financing (raised from an initial 1,000 ACT to **5,000 ACT** the same day). See "Project registration fee" below. Not yet reviewed by counsel.

| Field | Value |
|---|---|
| Purpose | Two revenue streams, both funding Aretia Finance LLC's operational costs: (1) the 0.5% management fee slice of the 1.5% transfer fee (3.5% until the 1 Oct 2026 change), and (2) a 5,000 ACT project-registration fee paid by developers applying for funding. See `TOKENOMICS.md` §01–02 and "Project registration fee" below. |
| Address | `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2` |
| Custody | Single account inside the founder's existing Phantom wallet (same seed phrase, new derived account) — deliberately lighter-weight than the 2-of-3 treasury multisig, since this is an operational expense account, not the project-funding treasury. |
| Network | Solana Mainnet |
| Current balance | 0 — nothing to fund it with yet. |

## Why this is separate from the treasury multisig

`TREASURY.md` flagged this as open: *"Set up a separate, lighter-weight wallet for the 0.1% management/operations fee, distinct from this 2-of-3 governance multisig."* (Written when the fee was still 0.1%; the wallet itself doesn't change with the rate.) Keeping it apart from `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg` means the two flows can never get commingled by accident, and the transparency dashboard (once built) can show "funded climate projects" and "operational costs" as genuinely separate on-chain totals — not just a reporting label on the same pool.

## How it actually gets funded (mechanism, not yet executed)

Token-2022's transfer-fee extension withholds one flat rate per transfer (1.5% once the 1 Oct 2026 change takes effect; 3.5% before — see `MINT_V2.md` for current status) — it does not split on-chain into the 1% / 0.5% buckets. Splitting is a manual step, done after harvesting:

1. Withheld fees accumulate in each holder's token account as ACT trades.
2. The treasury multisig (holder of the withdraw-withheld authority) harvests them into the treasury vault.
3. From that harvested amount, the treasury multisig sends the management-fee share — 0.5% ÷ 1.5% ≈ 33.33% of whatever was harvested — to this wallet as a normal transfer. The remaining ~66.67% (the 1% climate catalyst fund share) stays in the treasury. Fees withheld at the earlier 3.5% rate (none existed at the time of the change) would be split 1/7 instead; `propose-harvest.mjs`'s share constant must match the rate the harvested fees were withheld at.

Step 3 requires a real treasury-multisig transaction each time it runs. Nothing to execute yet — there's a $0 amount to harvest until liquidity is seeded and trading starts.

## Harvest-and-split tooling

A manual-run script drafts the harvest + split as a Squads proposal — it never executes anything itself, only 2-of-3 approval in Squads does. See [`scripts/management-fee-proposal/`](scripts/management-fee-proposal/README.md).

**Dry-run verified, 3 Sept 2026.** Ran successfully against live mainnet: read the mint's real transfer-fee config (410 bps, matches `MINT.md`), scanned every Token-2022 account tied to the ACT mint, found 0 accounts with withheld fees, and exited cleanly — exactly the expected result pre-liquidity. The scan and fee-read logic is now confirmed correct against real on-chain data, not just against docs. `--execute` still hasn't been run — no reason to yet, since there's nothing to harvest.

Note: the default RPC endpoint (`solana-rpc.publicnode.com`) failed with a generic `fetch failed` on the first attempt; swapping to `https://api.mainnet-beta.solana.com` via the `RPC_ENDPOINT` env var worked immediately. Likely a transient issue with that specific public endpoint rather than anything wrong with the script — worth retrying the default next time, and keeping the override in your back pocket if it acts up again.

## Project registration fee (7 Sept 2026, built; decisions below settled)

A project developer applying for catalyst-fund financing pays a **5,000 ACT registration fee** (raised from an initial 1,000 ACT, 7 Sept 2026, same day), sent to this wallet, at the point of application (`apply.html`, Section 8 step 1 in `PROTOCOL.md`). No voting mechanism sits around this — the earlier idea of a community vote per category was considered and dropped (see conversation history) in favor of the existing, already-documented team-curated selection process (`WHITEPAPER.md` §9.3): management reviews applications and decides which projects proceed, under the same milestone-verification discipline (`WHITEPAPER.md` §7) as everything else.

**Rationale:** covers the real cost of reviewing an application — the same category of work (`registry/credit verification, Impact Report review, site visits, dashboard upkeep`) this wallet already exists to fund, per the Purpose row above. Charging an application fee to the same entity that reviews and decides is a real conflict-of-interest pattern in the abstract; the fee is defensible specifically because it's sized to cost-recovery for review work, not because it changes who benefits from an approval decision.

**Decided, 7 Sept 2026:**
- **Non-refundable.** The fee is forfeited regardless of outcome — it is priced as cost recovery for reviewing the application, not a stake in being funded, and is not returned or credited if a project is rejected.

**Still open:**
- **Fee value is undefined pre-launch, more so now.** 5,000 ACT (raised 5x from the initial 1,000) has no fixed dollar cost until ACT trades. Revisit the number once there's a real price — the same accessibility concern applies at 5x the size: it could turn out to be trivial, or it could meaningfully exclude smaller developers, particularly in the Technical Assistance category, which by its own definition (`WHITEPAPER.md` §8.2) often serves less-resourced applicants.
- **Not yet reviewed by counsel.** This is new legal surface area under `PROTOCOL.md` §16's existing "everything added beyond the original simple treasury mechanism" flag — an application-fee-to-the-decision-maker structure is exactly the kind of thing that draws regulatory scrutiny if not clearly bounded to actual cost recovery. This applies with or without a refund policy; forfeiture on rejection, specifically, is the version of this fact pattern that reads most like the operator profiting from rejections, not less — flag this explicitly to counsel, don't let the "it's just cost recovery" framing go unquestioned.

**Built, 7 Sept 2026:** `apply.html` requires paying 5,000 ACT (raised from an initial 1,000 ACT the same day) before the submit button unlocks, via two paths:
1. **Connect and pay in-page** — Phantom, Solflare, or Backpack. A real `TransferChecked` instruction to this wallet's Token-2022 associated token account (idempotently created if needed). Trust Wallet is deliberately excluded from this path — its browser-extension provider doesn't reliably expose the same connect/sign interface these three share, and Solana support there has historically been mobile-app-focused rather than desktop-extension-focused.
2. **Manual verification** — for any payment made a different way (Trust Wallet, a CEX withdrawal, a different device): paste the transaction signature and the page looks it up on Solana directly, checking `pre`/`postTokenBalances` for a real increase of at least ~4,750 ACT in the management wallet's balance, before unlocking submit. Works regardless of how the transfer was constructed, since it checks the actual balance change rather than assuming a specific instruction shape — which is also why it isn't limited to any particular wallet or exchange.

Uses `@solana/web3.js` and `@solana/spl-token` loaded from `esm.sh` (not jsdelivr's `+esm` — that auto-bundles each package with its own copy of shared dependencies, which broke spl-token's internal layout checks when tested against a real HTTP origin; esm.sh's `?deps=` parameter dedupes correctly, verified before shipping).

**Verified in-browser, against real mainnet data:**
- Both instructions (path 1) build successfully with the correct program IDs, ATA derivations resolve to valid addresses.
- All three wallet-detection paths (Phantom/Solflare/Backpack) correctly report "not found" when absent.
- The manual verification path (path 2) was tested against a real, confirmed mainnet transaction (the `SetTransferFee` proposal signature, `4YwPZzV3q5yr...KfLD` — see `MINT.md`) and correctly rejected it with an accurate reason ("doesn't show any ACT received by the management wallet"), since that transaction is real but isn't an ACT payment. This is the strongest test actually available — no real ACT payment to this wallet exists yet to test the *accept* path against, since liquidity hasn't launched.
- No horizontal overflow at 390px or 1440px.

**Not verified:** an actual successful payment end-to-end (path 1's `signAndSendTransaction` call, or path 2 against a real qualifying transaction) — both need either a funded wallet or a real prior payment, neither of which can exist yet since ACT has no liquidity pool.

The client-side gate (disabled submit button) — and the manual verification path — are UX affordances, not the real enforcement, even though path 2 does check on-chain state: a technically motivated applicant could still bypass the page's JS entirely and POST straight to Formspree. See the code comment in `apply.html` and confirm `payment_tx_signature` against Solscan manually when reviewing any application, regardless of which path it came from.

## Swap fee on the web wallet (4 Oct 2026; corrected Oct 2026)

**Aretia Swings** (the swap screen at /wallet) charges **0.58% of the amount paid, only when the swap is paid with a native coin (SOL, ETH, BNB, POL), that coin wrapped, or a main stablecoin** (the exact list is `website/src/swings/core/feeAssets.ts`; the rate and the fee wallets are in `website/src/swings/core/fee.ts`, the only place they are set). Selling any other token carries no fee. On Solana the fee goes to this wallet in the same transaction as the swap; on the EVM networks it goes to the EVM fee address supplied at build time, either in the same batch as the swap or, for a wallet that cannot batch, as its own transaction just before the swap (not refunded if the person then declines the swap or it fails). Fees round down, so very small amounts pay none. It is a third income stream here and has not been reviewed by counsel. The first swap in each token also opens this wallet's token account for that token (about 0.002 SOL, paid by the user and shown in the review). For SOL swaps the wallet must hold at least 0.00089 SOL, otherwise the fee is waived on that swap.

**The legacy Trade tab fee** (the older Jupiter swap screen's code, `website/src/scripts/walletSwap.ts`) is still in the code: `SWAP_FEE_BPS = 100n` in `walletTools.ts` is **1% of the token being sold, whatever the token**, sent to this wallet in the same transaction, and it is what `planSwap` charges when its caller does not pass `feeBps`. Today the only caller is Swings (`website/src/swings/live.ts`), which passes `feeBps: 0n` and charges only the 0.58% above, so a swap is never charged both and the 1% is not charged in practice. Any new caller must pass `feeBps` explicitly; the default should be retired.

## Move USDC fee (21 Oct 2026)

Every **Move USDC** move (Circle CCTP, Pay > Move USDC and the plan's move step) carries an Aretia fee, on both routes (fast and standard) and from every source chain (EVM and Solana). It is **added on top: the recipient receives the full amount entered.**

| Product | Aretia fee | Paid in | Paid to | When |
|---|---|---|---|---|
| Swap (Aretia Swings) | 0.58% of the amount paid (coins and main stablecoins only) | the asset paid with | this wallet (Solana) / the EVM fee address | with the swap |
| **Move USDC** | **0.1% of the amount moved** (`MOVE_FEE_BPS = 10`, rounded up to the next 0.000001 USDC) | **USDC, on the source chain** | this wallet's **USDC account** (Solana source) / the EVM fee address `PUBLIC_ARETIA_EVM_FEE_ADDRESS` (EVM source) | Solana: inside the burn transaction (all or nothing). EVM: its own transfer after any approval and before the burn, sent only after the burn has been simulated, and never charged twice for a retry of the same move |

Example: enter 1,000 USDC. Aretia's fee is 1 USDC; on the standard route Circle charges nothing, so 1,001 USDC leaves the wallet and 1,000 USDC arrives. On the fast route Circle's fee (at most a few cents per 1,000) is added on top too, and the recipient still gets at least 1,000. The 10,000 USDC per-move cap applies to the amount entered.

The rate lives only in `website/src/swings/core/fee.ts` (`MOVE_FEE_BPS`, `moveFeeFor`). It is recomputed from that constant whenever a move is built and checked: a saved or restored quote cannot change it.

**Operator, once:** a move from Solana needs this wallet's **USDC associated token account** to exist (`ATA(2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2, USDC mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, Token program)`). Aretia never opens it at a user's expense; until it exists, moves from Solana are refused with "Aretia's fee account for USDC on Solana has not been opened yet". It very likely exists already (any swap paid in USDC on Solana opens it); check on Solscan and, if missing, create it from the Phantom account (receiving any USDC does it) or with `spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --owner 2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`. Moves from EVM networks need `PUBLIC_ARETIA_EVM_FEE_ADDRESS` set at build time; without it they are refused, never sent without the fee.

Referrals: a Move fee is fee revenue from the trader like a swap fee, and a referrer earns the same 20% share of it when it is reported (see `website/docs/referrals.md`). Not reviewed by counsel.

## Still open

- [x] Dry-run the harvest-and-split script against live mainnet — done, 3 Sept 2026. Scan and fee-read logic confirmed correct.
- [ ] First real harvest-and-split cycle — blocked on liquidity going live and real trading volume accruing fees.
- [ ] Decide the cadence (per-transaction, weekly, monthly) once there's real volume to look at. The script can be scheduled once that's decided.
- [ ] Reference this wallet on the transparency dashboard as its own line, once that's built.

Public address only. No private keys, seed phrases, or personal signer information belong in this file or this repository, ever.
