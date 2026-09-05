# Briefing Memo — Aretia Foundation's Role Relative to Aretia Climate Coin LLC

**Prepared for:** follow-up consultation with the same formation/crypto counsel who reviewed the original entity structure (1 Sept 2026) and the mechanism-first language repositioning (4 Sept 2026)
**Prepared by:** `[YOUR NAME]`
**Status:** ✅ **Resolved — 4 Sept 2026.** Counsel approved **Option B**: Aretia Foundation stays fully independent from Aretia Climate Coin LLC — no parent/subsidiary relationship, no shared ownership. Aretia Foundation will pursue its own 501(c)(3) status as a standalone climate-mitigation/adaptation organization, and can work *alongside* the treasury as a counterparty (a vetted grant recipient of the catalyst fund, or a co-funder bringing in outside grant dollars) rather than owning or controlling it. Aretia Climate Coin LLC's structure, ownership, and everything previously reviewed (1 Sept and 4 Sept 2026) are **unchanged** — this decision required no restructuring of the already-approved token/treasury setup. This document is kept below as the historical record of what was asked and approved; treat any section that reads as an open question as settled unless a later note says otherwise.

---

## 1. Background

Two entities already exist and are already operating, both previously reviewed and approved:

- **Aretia Climate, LLC** — the climate app. Delaware LLC.
- **Aretia Climate Coin LLC** — issues ACC, holds and disburses the treasury, signs project-partner agreements. Delaware LLC. Live on Solana mainnet since 2 Sept 2026 (see `MINT.md`, `TREASURY.md`). Earns a 0.1% management fee off token-transfer volume, disclosed and tracked separately from the project-funding treasury (see `MANAGEMENT_FEE.md`).

A third entity also exists, formed separately and **not yet active**:

- **Aretia Foundation** — a Delaware nonprofit (nonstock) corporation. No programs, no board activity, no filings beyond formation, and **no federal tax-exempt status applied for or granted**. "Nonprofit" here is a Delaware corporate-law status (no shareholders, mission-locked purpose clause) — it does not by itself mean the entity is tax-exempt under IRC §501(c)(3) or any other federal category.

Because Aretia Foundation has no history yet, this is a clean moment to decide what it's for before it accumulates any activity — which is the reason for this memo now rather than later.

## 2. What prompted this question

The motivation is **access to climate-focused grant and matching-fund programs** that require a grantee to be a registered nonprofit. The initial idea was to make Aretia Foundation the parent of Aretia Climate Coin LLC — Foundation as sole member/owner, LLC as subsidiary.

Before going further, two concerns surfaced that seem worth your read before either of us treats this as the right structure:

1. **Grant eligibility likely requires federal tax-exempt status, not just Delaware nonprofit-in-form status.** Most institutional climate funders can only grant to organizations that are themselves tax-exempt (typically 501(c)(3) or a recognized foreign equivalent), or that they can grant to under formal expenditure-responsibility procedures most small funders won't bother with. A Delaware nonstock corporation with no federal exemption may not actually unlock the funding being sought — it may look, to a grantmaker, like any other corporation.
2. **If 501(c)(3) status is pursued later, owning a token-issuing, fee-collecting LLC seems likely to complicate that application.** An organization operated exclusively for charitable purposes owning a commercial entity that issues a tradeable token and earns a management fee off its trading volume looks like exactly the fact pattern that invites private-inurement/private-benefit scrutiny and potential unrelated business income tax (UBIT) exposure. It also puts the already-reviewed and already-operating token structure inside the timeline and uncertainty of a federal exemption application it doesn't currently need to be near.

These are pattern-matches, not a legal opinion — flagging them is exactly why this needs your judgment before either entity's structure changes.

## 3. Two structures under consideration — for your review, not a decision

| | Option A — Foundation as parent | Option B — Foundation independent, working alongside the LLC |
|---|---|---|
| **Relationship** | Aretia Foundation becomes sole member/owner of Aretia Climate Coin LLC | Aretia Foundation stays fully separate; the two entities interact as counterparties, not parent/subsidiary |
| **How it could touch grant funding** | Foundation would need its own 501(c)(3) status regardless; owning the LLC doesn't add grant eligibility by itself | Foundation pursues 501(c)(3) as a standalone climate-mitigation/adaptation organization with a clean charitable purpose, no token-issuance business inside it |
| **How it could touch the treasury** | LLC's management-fee revenue would flow up to the Foundation as owner | Foundation could instead be one of the treasury's vetted grant recipients (receiving catalyst-fund disbursements like any other project partner), or a co-funder bringing outside grant dollars alongside the treasury's own fee-derived capital |
| **Effect on the already-approved token/LLC structure** | Materially changes it — ownership, control, and the compliance analysis counsel already approved would all need to be revisited | No effect — Aretia Climate Coin LLC continues exactly as already reviewed and operating |
| **Main risk** | Private-benefit/UBIT exposure if Foundation later seeks exemption; slower, less certain path to actually unlocking grants | Requires running two entities with genuinely separate governance instead of one consolidated structure |

Our tentative lean, purely from pattern-matching and not as a substitute for your judgment, is Option B — but we want your read on whether that's actually right, and on structures we haven't thought of.

## 4. What Aretia Climate Coin LLC does today (context, not a re-ask)

Full detail is already in `TOKENOMICS.md`, `WHITEPAPER.md`, `MINT.md`, `TREASURY.md`, and `MANAGEMENT_FEE.md` — summarized here only for the specific question this memo raises:

- ACC is an SPL Token-2022 asset on Solana, fixed 100,000,000 supply, mint and freeze authority both revoked.
- A 4.1% transfer fee splits: 2% to the treasury (functions as a **climate catalyst fund** — standing capital, continuously replenished by trading activity, financing climate mitigation and adaptation projects released against verified milestones), 1% liquidity, 1% burn, 0.1% management fee.
- The management fee is disclosed, separately tracked, service compensation to Aretia Climate Coin LLC for running the treasury (registry verification, Impact Report review, dashboard upkeep) — not a profit distribution to token holders.
- Treasury custody is a 2-of-3 Squads multisig on Solana mainnet; disbursements go to vetted project partners or on-chain carbon-credit retirements.
- This entire structure — including the "meme coin"-free, mechanism-first public language and the "catalyst fund" framing for the treasury — was reviewed and approved by counsel on 4 Sept 2026, under the existing two-LLC structure with no Foundation involvement.

## 5. Specific questions for counsel

1. **Does Option A create meaningful private-benefit or UBIT exposure** if Aretia Foundation later seeks 501(c)(3) status, given Aretia Climate Coin LLC's fee-generating, token-issuance business?
2. **Is Option B — Foundation independent, working alongside rather than owning the LLC/treasury — the cleaner path** to both grant eligibility and protecting the LLC's already-approved compliance posture? What are we not seeing?
3. **If Aretia Foundation pursues 501(c)(3), what's the realistic path and timeline** (streamlined Form 1023-EZ eligibility, or the full Form 1023), especially if it will receive disbursements sourced from a crypto treasury?
4. **If the treasury's catalyst fund disburses to Aretia Foundation as a vetted grant recipient**, does the fact that the source of funds is token-transfer-fee revenue create any wrinkle on either side — for the Foundation's exempt-purpose analysis, or for Aretia Climate Coin LLC's own disbursement process?
5. **Should Aretia Foundation and Aretia Climate Coin LLC share any officers, directors, or control**, or does keeping them fully independent (no shared control) matter for either entity's analysis?
6. **Any Delaware-specific considerations** for a nonstock nonprofit corporation receiving grant income sourced, even indirectly, from cryptocurrency trading activity?

## 6. Timeline and current state

- Aretia Foundation: formed, Delaware nonstock nonprofit corporation, **no activity, no board actions, no federal exemption application filed**.
- Aretia Climate Coin LLC: live, operating, mint and treasury both on mainnet, publicly reviewed and approved twice (1 Sept and 4 Sept 2026).
- **No structural change has been made to either entity.** This memo exists specifically to get your input before anything moves — we'd rather ask now, while Aretia Foundation is still a blank slate, than restructure something with history later.

---

*Attachments for reference: `TOKENOMICS.md`, `WHITEPAPER.md`, `PROTOCOL.md`, `MINT.md`, `TREASURY.md`, `MANAGEMENT_FEE.md` — all current, all previously reviewed except where each document's own status line says otherwise.*
