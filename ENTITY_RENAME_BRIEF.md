# Briefing Memo — Entity Naming History: Aretia Climate Coin LLC → Aretia Climate Token LLC → Aretia Finance LLC

**Prepared for:** follow-up consultation with the same formation/crypto counsel who reviewed entity formation (1 Sept 2026), the mechanism-first language repositioning (4 Sept 2026), and the Aretia Foundation question (4 Sept 2026)
**Prepared by:** `[YOUR NAME]`
**Status:** 🟡 **In progress, 4 Sept 2026, current target Aretia Finance LLC.** The entity's legal name target changed twice on the same day, before either version of the Delaware Certificate of Amendment was confirmed filed. It moved from Aretia Climate Coin LLC to Aretia Climate Token LLC (documented in Sections 1 through 6 below, prepared first), and has now moved again to **Aretia Finance LLC**, dropping both "Climate" and "Token"/"Coin" from the legal name entirely. The ticker is unaffected by either change and remains **ACT**. A full documentation pass to the current target, Aretia Finance LLC, has been executed across every current, forward-facing document, with the same honest framing as before: the Delaware amendment is in progress, not independently confirmed as filed and effective. Historical records (`ATTORNEY_BRIEF.md`, `FOUNDATION_BRIEF.md`, deployment scripts under `devnet/` and `mainnet/`) remain untouched, showing the original name, since they document what was actually asked, approved, or executed at the time, under the name then in use.

**Practical note given two target-name changes in one day:** whichever name is actually reflected on the Delaware Certificate of Amendment when it is filed is the one that matters legally. If a filing was already submitted under "Aretia Climate Token LLC" before this second change, that filing needs to be corrected or re-submitted to target "Aretia Finance LLC" instead, rather than left to complete under a name already superseded in every document. Worth confirming directly with the registered agent handling the filing before assuming either name is final.

---

## 0. Second rename: Aretia Climate Token LLC → Aretia Finance LLC

Sections 1 through 6 below were prepared for the first rename, from Aretia Climate Coin LLC to Aretia Climate Token LLC, and are left intact as the historical record of that reasoning. This section covers what changed afterward.

**What changed:** the legal name target dropped "Climate" and "Token" entirely, landing on **Aretia Finance LLC**. This aligns with the domain chosen for the public site, `aretiafinance.org`, which itself was selected specifically to avoid "coin" in the name for the same reasons discussed in Section 2 below.

**What did not change:** the ticker (**ACT**), the protocol's own name (**Aretia Climate Finance Protocol**, used to describe the system as a whole rather than the legal entity operating it), the mint address, the treasury multisig, the management-fee wallet, and the co-funding vault. This is, once again, a documentation and legal-paperwork change only; none of the on-chain infrastructure encodes the LLC's legal name and none of it requires updating.

**Documentation pass, second rename:** executed 4 Sept 2026 across `WHITEPAPER.md`, `TOKENOMICS.md`, `PROTOCOL.md`, `MINT.md`, `MANAGEMENT_FEE.md`, `LIQUIDITY_ONE_PAGER.md`, `SIGNER_AGREEMENT_TEMPLATE.md`, `LAUNCH_CHECKLIST.md`, and the website. `CO_FUNDING.md` and `TREASURY.md` contain no reference to the entity's legal name and needed no change. `ATTORNEY_BRIEF.md` and `FOUNDATION_BRIEF.md` remain untouched as historical record, per the same reasoning applied to the first rename.

**Still open, in addition to the items in Section 6:** confirming which name, if either, has actually been filed with Delaware so far, and correcting course with the registered agent if a filing already targeted the now-superseded "Aretia Climate Token LLC."

---

## 1. Background

**Aretia Climate Coin LLC** — Delaware LLC, formed and reviewed by counsel 1 Sept 2026 (two-entity structure, compliance framing, management-fee treatment all approved as proposed), reviewed again 4 Sept 2026 for the mechanism-first public-language repositioning. It issues ACC, holds and disburses the treasury, and is the counterparty on project-partner agreements.

## 2. What's being proposed

Rename the entity to **Aretia Climate Token LLC**, and the ticker from **ACC** to **ACT**.

Two reasons this is being considered now rather than left alone:

1. **"Token" is technically the more accurate word.** In crypto usage, "coin" properly refers to a chain's native asset (SOL, ETH, BTC); ACC has always been an SPL **Token**-2022 asset on Solana, not a native coin. "Coin" was a common but slightly inaccurate word choice, and "Token" fits the mechanism-first, precise register the whitepaper already moved to on 4 Sept.
2. **Timing.** Nothing about the project has been made public yet — no live domain, no pushed repository, no on-chain name/symbol metadata set for the mint, no community that knows it by any name. This is close to the least costly moment this rename will ever be.

## 3. What actually has to happen (mechanically)

- **Delaware Certificate of Amendment** to the Certificate of Formation, changing the registered LLC name from Aretia Climate Coin LLC to Aretia Climate Token LLC. Filed with the Delaware Division of Corporations, typically through the entity's registered agent.
- **EIN / IRS records** — the entity's EIN stays the same (an EIN doesn't change with a name change), but the IRS needs to be notified of the new legal name, typically at the next tax filing or via direct notification.
- **Bank accounts and any existing agreements** naming the entity (this includes `SIGNER_AGREEMENT_TEMPLATE.md`, which currently defines "Aretia" as shorthand for "Aretia Climate Coin LLC") need to be updated to the new name once it's effective.
- **What does *not* need to change:** the Solana mint address, the treasury multisig address, the management-fee wallet, and the co-funding vault are all independent on-chain infrastructure — none of them encode the LLC's legal name, so none of them need to move or be recreated. Only the paperwork and public-facing language around them change.

## 4. Documentation impact (ready, not yet executed)

"Aretia Climate Coin LLC" currently appears across `WHITEPAPER.md`, `TOKENOMICS.md`, `PROTOCOL.md`, `MINT.md`, `TREASURY.md`, `MANAGEMENT_FEE.md`, `CO_FUNDING.md`, `LIQUIDITY_ONE_PAGER.md`, `ATTORNEY_BRIEF.md`, `FOUNDATION_BRIEF.md`, `SIGNER_AGREEMENT_TEMPLATE.md`, and the website. All of it is ready to update in a single pass, using the same protect-and-swap technique used for the earlier "Aretia Climate Coin" → "Aretia" brand rebrand — but that pass should only happen once the Delaware amendment is actually filed and effective, so no document ever states a legal name that isn't yet true.

## 5. Specific questions for counsel

1. **Does this rename need its own review**, or does it fall under the entity-structure approval already given, since only the name changes and nothing about the mechanism, ownership, or compliance framing does?
2. **Any issue amending the name this soon after formation** — anything that reads oddly to a bank, a future grantor, or a regulator about an LLC renamed within its first weeks?
3. **Realistic timeline** for the Delaware amendment to process, so the documentation pass can be scheduled against it rather than guessed at.
4. **Does the ticker change (ACC → ACT) need separate treatment**, given no on-chain metadata has been set for the mint yet — is there anything to flag before metadata is eventually created under the new symbol?
5. **Any other paperwork** (beyond `SIGNER_AGREEMENT_TEMPLATE.md`) that references the entity by name and would need a fresh signed version under the new name.

## 6. Timeline and current state

- Legal name: renaming to **Aretia Climate Token LLC**, Delaware amendment in progress.
- Ticker: renamed to **ACT** across all current documentation and the website; no on-chain metadata existed under ACC, so nothing on-chain required changing.
- Documentation pass: **done, 4 Sept 2026** — `WHITEPAPER.md`, `TOKENOMICS.md`, `PROTOCOL.md`, `MINT.md`, `MANAGEMENT_FEE.md`, `CO_FUNDING.md`, `LIQUIDITY_ONE_PAGER.md`, `SIGNER_AGREEMENT_TEMPLATE.md`, `PARTNER_AGREEMENT_TEMPLATE.md`, the website, and the management-fee-proposal scripts all updated. `TREASURY.md` contained no occurrences of either the old name or the ticker, so it needed no change. `ATTORNEY_BRIEF.md` and `FOUNDATION_BRIEF.md` were deliberately left as historical record.
- Still open: independent confirmation the Delaware amendment has actually been filed and is effective; the answers to Section 5's questions for counsel; updating any bank accounts or the real, already-signed co-signer agreements (the template here was updated, but agreements already executed with the two real co-signers, tracked outside this repo, are a separate re-signing question).

---

*Attachments for reference: `WHITEPAPER.md`, `TOKENOMICS.md`, `PROTOCOL.md`, `MINT.md`, `TREASURY.md`, `SIGNER_AGREEMENT_TEMPLATE.md` — all current, all reflect the entity's name as it stands today.*
