# Aretia (ACT) — Tokenomics & Architecture

**Version:** 0.8 — ACT is live on mainnet (see `MINT.md`); public-language repositioned mechanism-first, reviewed and approved (4 Sept 2026); entity and ticker renamed (4 Sept 2026)
**Chain:** Solana
**Status:** Legal review complete for entity formation and the base treasury mechanism (1 Sept 2026), under the original meme-coin-adjacent framing. Issuing entity: **Aretia Finance LLC** (Delaware) — renamed from Aretia Climate Coin LLC; Delaware Certificate of Amendment in progress, not yet confirmed effective. Ticker renamed from ACC to ACT correspondingly; no on-chain metadata existed under the old symbol. On 4 Sept 2026, self-descriptive language was revised away from "meme coin" comparisons toward mechanism-first terms (SPL Token-2022, protocol-enforced transfer fee) and the treasury was reframed explicitly as a **climate catalyst fund**; the underlying mechanism, fee split, and treasury structure are unchanged. **This wording shift has been reviewed by counsel and approved (4 Sept 2026)** — see §06. The governance/milestone-financing architecture below is a separate, unrelated addition and remains **not yet reviewed** — see `PROTOCOL.md` for the full picture and its legal-status note. Locked build parameters (supply, authorities, fee split) are unchanged and already built; nothing here is legal, tax, or investment advice.

**This document is now the tokenomics reference for a broader system — see [`PROTOCOL.md`](PROTOCOL.md) for the full architecture (governance layers, project lifecycle, milestone financing, MRV, roadmap). This file stays focused on the token and treasury mechanics specifically.**

---

## Overview

ACT is an SPL **Token-2022** asset that trades on the open market — priced against USDT, no gatekeeping on who can buy or sell, no custom program required to enforce any of it. What's different sits underneath the trade: a fixed slice of every transfer is diverted into an on-chain treasury that functions as a **catalyst fund** for climate mitigation and adaptation projects, rather than backing one fixed asset. Holders don't own carbon credits by holding the token; they hold the economic engine of a climate finance protocol — trading activity keeps the catalyst fund continuously replenished, and the protocol's governance layers (not a single wallet, not a direct holder vote on individual payouts) decide where that capital goes. See `PROTOCOL.md` §7 for why governance is layered rather than a flat holder vote.

## Locked parameters

| Parameter | Value |
|---|---|
| Ticker | **ACT** |
| Total supply | **1,000,000,000** (fixed) |
| Mint authority | **Revoked** after initial mint — supply can never increase |
| Freeze authority | **Revoked** — no wallet can ever be frozen |
| Network | Solana — build and test on **devnet** before mainnet |

---

## 01 — Token layer

ACT is issued as an SPL **Token-2022** mint, using the standard's native **transfer-fee extension**. The fee is enforced at the protocol level on every transfer — no custom program logic required to skim, route, or evade it, and no way for a wallet to opt out of it.

**Per-trade split (draft parameters):**

| Destination | Share |
|---|---|
| Net transfer to recipient | 96.5% |
| Treasury — climate catalyst fund | 2% |
| Liquidity pool | 1% |
| **Management fee** — project monitoring & verification | **0.5%** |

**6 Sept 2026 update: burn removed, management fee raised 0.1% → 0.5%.** Total tax drops from 4.1% to 3.5% — the removed 1% burn share isn't redistributed, it's simply no longer withheld. Approved 2-of-3 and executed on-chain the same day; scheduled for epoch 1031 per Token-2022's mandatory future-epoch rule (see `MINT.md`'s fee-authority section for the transaction and current status — check there before assuming 350 bps is already the rate actually being charged). **This also reopened a securities-analysis question with counsel** about fee streams benefiting the operating entity, previously reviewed against 0.1%, not 0.5%, and not yet re-reviewed at the new figure. That question was still open when the on-chain change was executed.

**Trading pair:** Primary pool is ACT / USDT (Tether's Circle-issued SPL token) on Raydium, mirrored on Orca for depth, with Jupiter aggregating routes for anyone swapping in from SOL or another asset. Liquidity-pool tokens are locked for a fixed term at launch so early liquidity can't be pulled out from under holders.

> **Design note:** 3.5% total tax is a starting figure, not a fixed constant — it should be tuned against norms for comparable Solana open-market token launches (most successful launches run 0–2% to stay competitive on swap price) before mainnet. A higher treasury cut funds more climate impact per trade; a lower one keeps the token more attractive to pure traders.

> **Why a separate management fee, not folded into treasury:** running the treasury responsibly costs real money — verifying registry certificates, reviewing Impact Reports, occasional site visits, maintaining the transparency dashboard. Funding that from an undisclosed slice of the "treasury" allocation would quietly make the "2% funds climate projects" claim partly untrue. Keeping the 0.5% as its own disclosed line — reported separately on the transparency dashboard, never merged into the project-funding total — keeps that claim honest. This fee funds Aretia Finance LLC's operational work; it is not a profit share or dividend to token holders.
>
> **Where it goes:** a dedicated wallet, separate from the treasury multisig — `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`. Not yet funded; see `MANAGEMENT_FEE.md`.

## 02 — Treasury layer

The treasury is Aretia's **catalyst fund**: a standing, continuously replenished pool of capital whose stated purpose is financing climate mitigation and climate adaptation projects. It is not a one-time pledge and not a grant round that depletes and has to be re-raised — every trade tops it up again, by protocol design, whether or not anyone is actively fundraising. That framing matters for what the fund is *for*: catalytic capital, in blended climate finance, is capital placed specifically to seed and de-risk activity that wouldn't otherwise get financed on its own — a first mover, not the entire bankroll. Aretia's catalyst fund is built to play that role on-chain, releasing capital in verified tranches (`PROTOCOL.md` §8–9) against real mitigation and adaptation work rather than sitting as an idle reserve.

Accumulated fees settle into a **Squads multisig** — Solana's equivalent of Gnosis Safe — requiring multiple independent signers to approve any outbound disbursement. No single key can move treasury funds. **Live on mainnet:** vault `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`, 2-of-3 threshold, real independent co-signers, full propose-approve-execute cycle tested (see `TREASURY_V2.md`).

Each disbursement from the catalyst fund is one of two kinds:

- **Grants** — a lump-sum transfer to a vetted project partner (a reforestation cooperative, a community solar developer) that isn't itself tokenized. Simpler to execute, harder to verify on-chain beyond "funds left the treasury."
- **Retirements** — the treasury buys and permanently retires tokenized carbon credits (for example, Toucan's BCT/NCT or a comparable bridged registry credit) on-chain. Slower to source, but produces a provable, quantified tonnes-CO2 figure tied to a transaction hash.

Disbursements draw from an illustrative functional allocation — a separate dimension from *which project category* gets funded (Section 04 below): **60% climate mitigation, 20% climate adaptation, 10% ecosystem development, 5% MRV/verification, 5% emergency reserve**. Mitigation and adaptation together make up 80% of the fund's intended functional use — consistent with its role as a catalyst fund for both sides of the climate response, not just emissions-reduction work. These weights are a starting configuration Layer 1 governance can revise through the defined procedure — see `PROTOCOL.md` §6.

Every disbursement — either kind — is a public on-chain transaction from a known treasury address. A companion transparency dashboard (separate build) can index those transactions and render them as a running ledger: date, amount, recipient or registry, and running total.

**Management fee handling:** the 0.5% management fee settles in its own dedicated wallet — `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`, deliberately separate from the 2-of-3 treasury multisig — so it can never be commingled with project-funding assets even by accident, not just by reporting convention. It pays for Aretia Finance LLC's operational costs of running the treasury: registry/credit verification, Impact Report review, occasional site visits, and dashboard upkeep. This is a service fee for that work, not a profit distribution to token holders or team members personally. See `MANAGEMENT_FEE.md` for the wallet record and the harvest-and-split mechanism.

## 03 — Governance layer

Flat "holders vote on every payout" governance breaks the moment the treasury is large enough to matter — a single well-organized proposal can extract real money from a naive vote. ACT governance runs in four layers instead (full detail in `PROTOCOL.md` §7):

1. **Community** (token holders, via **Realms**/SPL Governance) — vote on funding priorities, project categories, and treasury allocation weights. Not individual project payouts.
2. **Technical committee** — domain experts screen individual project applications against climate science, MRV credibility, financial feasibility, and social/environmental risk.
3. **Independent verification** — a party independent of both the protocol team and the project developer confirms a funded project actually did what it claimed, before further milestone funds release.
4. **Smart contract execution** — funds move only after Layers 2 and 3 both sign off on a given milestone. No human discretion at the point of transfer.

Governance is phased in, not switched on at launch: the treasury runs on team-curated grants first, with Layer 1 voting handed over once there's a large enough, engaged holder base for it to be meaningful rather than symbolic, and Layers 2–4 built out through the roadmap phases in `PROTOCOL.md` §17.

## 03a — Milestone financing

Approved projects don't receive their full commitment as one lump sum. Capital releases in tranches tied to verified progress: an approval commits a total amount, then each milestone releases its tranche only after Layer 3 verification confirms the prior one was actually met. This is what keeps "the treasury financed a project" from meaning "the treasury sent money to a project that never finished." See `PROTOCOL.md` §8–9 for the full lifecycle and a worked example.

## 04 — Project portfolio

"Tied to many climate-friendly projects" means the treasury spreads across categories rather than committing to one. An illustrative first-cycle split — entirely hypothetical, pending real project vetting:

| Category | Share |
|---|---|
| Reforestation | 35% |
| Renewable energy | 30% |
| Credit retirement reserve | 20% |
| Direct air capture | 15% |

Each category needs its own diligence bar. Reforestation and land-use projects lean on registry standards (Verra, Gold Standard); renewable energy grants need proof of actual generation capacity added, not just intent; direct air capture is early-stage and highest-risk per dollar. None of this is decided by the smart contract — it's a curation and governance question that sits entirely off-chain.

## 05 — Chain selection

Solana over the EVM alternatives, primarily for the native transfer-fee extension and the permissionless retail-trading volume it launches into.

| Chain | Fees | Permissionless retail trading volume | Native tax-on-transfer | USDT liquidity |
|---|---|---|---|---|
| **Solana** | ~$0.0003/tx | Dominant — BONK, WIF, pump.fun ecosystem | Yes — Token-2022 extension | Native SPL USDT, deep on Raydium/Orca |
| Base | ~$0.01–0.05/tx | Growing, more app-driven than trading-driven | No — needs custom contract logic | Bridged USDT, good Uniswap depth |
| BNB Chain | ~$0.10–0.30/tx | Strong, PancakeSwap-centric | No — needs custom contract logic | Deep, but more centralized custody risk |
| Ethereum L1 | $2–30+/tx | Most credible, least liquid for small trades | No — needs custom contract logic | Deepest overall, expensive to disburse often |

Tradeoff to hold onto: Solana's tooling is Rust/Anchor, not Solidity, so the developer pool for extending the program later is narrower — real, but outweighed here by not having to hand-roll fee logic and by where this kind of permissionless trading volume actually lives right now.

## 06 — Compliance framing

This is the line that determines how heavily regulated the token is, and it comes down to wording as much as mechanism.

**Keep:** *"ACT funds a public treasury that supports climate projects."* Trading activity generates fees; fees fund grants and credit retirements; anyone can verify the flow on-chain. Counsel's original approval (1 Sept 2026) was informed in part by describing this as reading closer to a charity meme coin — a deliberately lighter regulatory posture. Public-facing language has since moved to mechanism-first terms (SPL Token-2022, protocol-enforced transfer fee, catalyst fund) instead of the meme-coin comparison; the underlying mechanism and the "funds a treasury" claim are unchanged. **This specific wording shift was reviewed and approved by counsel on 4 Sept 2026** — the mechanism-first framing is confirmed as still holding the same compliance posture.

**Avoid:** *"ACT is backed by carbon credits"* or *"holding ACT entitles you to a share of project revenue or credits."* Either claim starts to look like an unregistered security or an unlicensed carbon-credit product, which pulls in securities law and registry-verification obligations this design doesn't build for.

This section is a drafting guardrail, not legal advice — actual marketing copy, the public whitepaper, and jurisdiction-specific structuring all need a securities lawyer's sign-off before anything goes live.

## 07 — Roadmap

1. **Lock tokenomics parameters** — done (this doc).
2. **Legal review** — done (1 Sept 2026). Two-entity structure, current compliance framing, and management-fee treatment all approved as proposed. Follow-up review (4 Sept 2026): mechanism-first repositioning away from "meme coin" language, plus the "climate catalyst fund" framing for the treasury, approved with the same compliance posture — see §06. Second follow-up (4 Sept 2026): Aretia Foundation (a separately-existing, not-yet-active Delaware nonprofit) confirmed to stay fully independent of this entity — no ownership, no parent/subsidiary relationship.
3. **Decide on the legal entity** — done. **Aretia Climate, LLC** (app) and **Aretia Finance LLC** (coin/treasury), both Delaware, both registered.
4. **Build and test the mint** — done, and live. Token-2022 mint with the 3.5% transfer-fee config, deployed for real on **Solana mainnet**: `7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG`, 1,000,000,000 fixed supply, mint authority permanently revoked, fee authorities on the treasury vault. Full detail: `MINT_V2.md`.
5. **Stand up treasury and governance** — done for the treasury: Squads multisig live on mainnet, 2-of-3 real independent signers, full propose-approve-execute cycle tested (see `TREASURY_V2.md`). Realms governance still pending.
6. **Independent program review** — audit the mint configuration and any custom instructions before mainnet.
7. **Seed and lock liquidity** — planned, not yet funded. Target: 5,000,000 ACT (5% of treasury supply) + $10,000 USDT via the treasury's direct Raydium integration (no personal-wallet custody), implied starting price ≈$0.002/ACT, LP tokens locked 6 months. Currently pending investor conversations for the $10,000 — capital is not yet in hand.
8. **Ship the transparency dashboard** — public ledger of treasury inflows and disbursements, live before or at launch, not after.
9. **Public launch.**
10. **Vet the first project slate** — reviewed from real applications submitted via the public funding form (`apply.html`), not sourced in advance.

---

*Working draft for internal planning. Figures throughout — fee percentages, split ratios, allocation examples — are illustrative starting points for discussion except where marked "locked." Nothing in this document is legal, tax, or investment advice.*
