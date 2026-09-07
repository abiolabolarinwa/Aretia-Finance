# Briefing Memo — Entity Formation for Aretia Climate & Aretia Climate Coin LLC

**Prepared for:** initial consultation with formation/crypto counsel
**Prepared by:** `[YOUR NAME]`
**Status:** ✅ **Resolved — 1 Sept 2026.** Legal review complete. The two-entity structure was approved as proposed. **Aretia Climate, LLC** (app) and **Aretia Climate Coin LLC** (coin/treasury) are both registered in **Delaware**. No changes to the securities framing, public-language approach, or management-fee structure were required at this time — counsel may revisit as the project develops. This document is kept below as the historical record of what was asked and approved; treat any section that reads as an open question as settled unless a later note says otherwise.

This memo originally existed to make the first conversation with counsel productive — it laid out what we were building, why a two-entity structure made sense, and the specific open questions that needed judgment. That consultation has now happened.

---

## 1. Background

`[Your name]` is building two related but distinct things:

1. **Aretia Climate** — a climate-focused software application. `[one or two sentences on what the app actually does]`. Self-funded to date, no outside investment, no nonprofit filings, no entity formed yet.

2. **Aretia ("ACC")** — a Solana-based token, tradeable on the open market against USDT, where a portion of every trade's transaction fee is diverted into a public treasury. That treasury funds a rotating portfolio of climate projects (reforestation, renewable energy, tokenized carbon-credit retirement, etc.) via grants and credit purchases, with treasury allocation eventually opened to token-holder governance.

Neither entity exists yet — this is a from-scratch decision, not an untangling of an existing structure.

## 2. Proposed structure — for your review, not a fixed decision

We're leaning toward **two separate entities** rather than one, and want your view on whether that's right, and how to structure each:

| | Entity A — "Aretia Climate" | Entity B — "Aretia Climate Coin LLC" |
|---|---|---|
| **Purpose** | Builds/operates the climate app | Issues ACC, holds and disburses the treasury, signs project-partner agreements |
| **Funding source** | Self-funded / possible future investment | Funded by on-chain transaction fees from ACC trading |
| **Key risk profile** | Standard software-company risk | Token/securities regulatory exposure, on-chain treasury custody, counterparty (project partner) contracts |
| **Working entity type** | LLC (or Delaware C-corp if outside investment is likely soon) | Open question — see Section 4 |

**Our reasoning for splitting them:** we don't want token-related regulatory or reputational risk (a bank account closure, a securities inquiry, a bad-actor accusation from the broader meme-coin space) able to reach the app's operations or banking relationship, and vice versa. We'd rather absorb two formation/filing costs now, while both entities are empty, than untangle a commingled entity later after the treasury holds real assets.

## 3. What Aretia Climate Coin LLC actually does — mechanism summary

For context on what you'd be advising on regarding Entity B specifically:

- **Token:** SPL Token-2022 mint on Solana, fixed supply (100,000,000), mint and freeze authority both revoked after initial mint — no one, including us, can create more tokens or freeze a wallet after launch.
- **Fee mechanism:** a transfer-fee extension native to the token standard collects a small percentage on every on-chain transfer (draft: ~4.1%, split across treasury (2%) / liquidity (1%) / burn (1%) / management fee (0.1%) — not yet finalized).
- **Management fee (0.1%):** funds Aretia Climate Coin LLC's own operational costs of running the treasury — verifying registry/credit documentation, reviewing partner Impact Reports, occasional site visits, dashboard upkeep. Structured and disclosed as a service fee to the operating entity, not a profit distribution to token holders. Flagging this explicitly because any fee stream that benefits the operating entity/team is directly relevant to the securities analysis below (Section 4, Q3) — want your read on whether this changes that analysis at all.
- **Treasury:** held in a Solana multisig (Squads), requiring multiple signers for any disbursement.
- **Disbursements:** either (a) grants to climate-project partners under a bilateral agreement, or (b) purchases and on-chain retirement of tokenized carbon credits from a registry (e.g., Verra-issued, bridged on-chain). All disbursements are public on-chain transactions.
- **Governance:** intended, eventually, to let token holders vote (via Realms/SPL Governance) on which projects in a vetted slate receive funding each cycle. Not live at launch.
- **What holding the token does *not* do:** no equity, no profit share, no claim on treasury assets, no direct ownership of any carbon credit. We've been deliberately drafting all internal and partner-facing language around "funds a treasury that supports projects" rather than "backed by" or "entitles you to," specifically to avoid characterizing this as a security or a regulated carbon-credit product — but we need your judgment on whether that framing actually holds up, and what it constrains us from saying publicly.

Full tokenomics draft, a draft project-partner agreement template, and a draft public-facing whitepaper are attached for reference (`TOKENOMICS.md`, `PARTNER_AGREEMENT_TEMPLATE.md`, `WHITEPAPER.md`) — all are unreviewed working drafts, prepared before this legal consultation, meant to be revised based on your input rather than treated as final. The whitepaper in particular should not go out publicly until you've reviewed its language against your answer to Question 4 below.

## 4. Specific questions for counsel

1. **Does the two-entity split make sense**, or would you structure this differently (e.g., one entity with clear internal separation, or a different split entirely)?
2. **Entity type and state for Entity B specifically.** We're aware Wyoming has a DAO LLC statute aimed at blockchain-protocol entities with on-chain governance — is that a fit here, or is a standard Delaware LLC/foundation structure more appropriate given we're not fully decentralized at launch?
3. **Securities analysis.** Does the token as described (open-market trading, fee-funded treasury, no profit share or equity claim, eventual holder governance over treasury allocation) create securities exposure under `[Howey / relevant framework]`? Does the governance feature specifically change that analysis?
4. **Public-language constraints.** What can and can't our marketing copy, website, and the tokenomics doc say, given the compliance framing above?
5. **Banking.** Any guidance on which banks/institutions are workable for an entity whose primary asset flow is crypto-derived treasury fees?
6. **KYC/AML obligations**, if any, given there's no presale or private offering planned — the token is intended to launch directly into open-market trading.
7. **Project-partner agreements.** Does the attached template's framing (grant/purchase, not investment) hold up, and what does it need before it's usable with a real partner?
8. **Management fee treatment.** The 0.1% fee described above flows to Aretia Climate Coin LLC (the operating entity) as compensation for treasury-management work, disclosed as its own line separate from project-funding disbursements. Is that structure and disclosure sufficient, or does it need to be framed differently (e.g., a formal services agreement between the entities, specific accounting treatment, additional public disclosure)?

## 5. Timeline and current state

- No entity formed, no funds moved, nothing public yet.
- Token has been scoped and parameters drafted; no smart contract deployed, not even on devnet, pending this legal review and toolchain setup.
- We'd like to have entity structure and public-language guidance settled before any devnet deployment goes further, and certainly before mainnet or any public marketing.

---

## 6. Addendum, 6 Sept 2026 — management fee changed after this brief was written

This brief and its Section 4, Q3/Q8 above were written against a **0.1%** management fee. That figure has since been raised to **0.5%** (5x), and the 1% burn allocation removed, taking the aggregate transfer fee from 4.1% to 3.5% (see `TOKENOMICS.md` §01, `MINT.md`). The text above is left as-is, unedited, since it's a record of what was actually sent for review — not retouched to match the new number.

This matters specifically because Q3 asked "any fee stream that benefits the operating entity/team is directly relevant to the securities analysis... want your read on whether this changes that analysis," and Q8 asked whether the *0.1%* structure and disclosure was sufficient. A 5x larger fee stream to the operating entity is a materially different fact pattern for both questions. **Neither has been re-reviewed at 0.5%.** Flagging this explicitly rather than letting the brief go stale silently: if counsel's answer to Q3/Q8 depended on the fee being small relative to the treasury allocation, that dependency should be re-checked before the 0.5% figure goes out in any public document.

## 7. Addendum, 7 Sept 2026 — new project-registration fee, not in the original brief at all

A new mechanism was added after this brief was written and has never been reviewed: a project developer applying for catalyst-fund financing pays a **1,000 ACT registration fee**, sent to the same management wallet discussed in Section 6 above. See `MANAGEMENT_FEE.md`, "Project registration fee," and `PROTOCOL.md` §8 step 1 for the full mechanism. Not yet built (no payment flow exists on `apply.html`).

This is a different fact pattern from Q3/Q8, not just a bigger version of the same one: those questions asked about a *transfer-fee* stream to the operating entity, sized as a small percentage of trading activity the entity doesn't control. This is an **applicant-pays-the-decision-maker** structure — the same entity that reviews and approves or rejects a project also collects a fee from every applicant regardless of outcome, with no independent layer checking that specific decision. The stated rationale is cost recovery for review work (site visits, documentation review — the same category of work the management wallet already exists to fund), which is a defensible pattern in the abstract (comparable to a standard application or listing fee), but:

- The fee's real dollar cost is undefined until ACT has a live price, so its size relative to actual review cost — the thing that would make it defensible — can't currently be assessed.
- No refund/credit policy has been decided (forfeited on rejection, credited against an eventual grant, or returned).
- It potentially affects the same securities-characterization question Q3 raised (does a fee stream to the operating entity, tied to token holdings/use, look like an expectation of profit from the issuer's efforts), from a new angle: does *requiring ACT to access the funding process itself* give the token a financial-rights-like utility.

**None of this has been reviewed.** Flagging it now, before any implementation, rather than after — this is exactly the kind of new mechanism Section 16 of `PROTOCOL.md` (legal/regulatory architecture) says needs counsel before being represented as final, publicly.

*Attachments: `TOKENOMICS.md`, `PARTNER_AGREEMENT_TEMPLATE.md`, `WHITEPAPER.md` (all working drafts, all explicitly marked as pending legal review).*
