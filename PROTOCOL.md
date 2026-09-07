# The Aretia Climate Finance Protocol

**Version 0.1 — architecture draft.** This document supersedes the "climate meme coin" framing used in earlier drafts of the tokenomics doc and whitepaper. It is the master blueprint everything else — tokenomics, whitepaper copy, website, smart contracts — should be built from.

**Legal status, stated once, not repeated on every page:** entity formation (Aretia Climate, LLC and Aretia Finance LLC, both Delaware) and the simpler "treasury funds climate projects" mechanism already went through legal review and were approved. Aretia Finance LLC was renamed from Aretia Climate Coin LLC on 4 Sept 2026 (Delaware amendment in progress — see `ENTITY_RENAME_BRIEF.md`); the ticker changed correspondingly from ACC to ACT. Everything new in this document — governance tiers, milestone-based project financing, incentive-token mechanics, and a formal Aretia Climate ↔ Protocol service relationship — is **not yet reviewed** and should not be represented publicly as final until it is.

---

## 1. Vision

Climate finance has money and it has need, but it doesn't have trust. Pledges outpace verified action. Capital moves slowly, opaquely, and often without proof that it did what it claimed. Meanwhile, permissionless token trading on Solana moves enormous amounts of real volume with no purpose beyond the trade itself.

Aretia's vision: a protocol where economic activity — ordinary, permissionless token trading — continuously and automatically converts into transparent, verifiable climate finance, with every dollar's path from trade to project to measured impact visible on-chain.

## 2. Mission

Don't think "a token where a percentage of trading funds climate projects." Think: **a decentralized financial protocol that continuously converts economic activity into transparent climate finance, using verifiable data to determine where capital goes and what impact it creates.**

The token is the economic engine. It is not the whole product. The protocol — treasury, governance, project financing, measurement, reporting — is the product. The token trades openly and can carry a real trading community on the surface; underneath, every transfer replenishes a catalyst fund for climate mitigation and adaptation work.

## 3. Principles

- **Transparency** — every treasury inflow and outflow is a public on-chain transaction. No step in the money's path is hidden.
- **Additionality** — funded projects must demonstrate impact that would not have happened anyway. A project that was going to happen regardless doesn't get protocol capital.
- **Climate integrity** — no greenwashing. Claims are verified independently before they're published, not taken on faith.
- **Accountability** — capital release is conditioned on verified milestones, not promises. No single party — not the team, not one committee, not one signer — can unilaterally move treasury funds.
- **Decentralization** — governed in layers, not by a founder's wallet. Decentralization is a target the protocol grows into, not a claim made on day one.
- **Measurability** — impact is expressed in numbers (tCO₂e avoided, households served, MWh generated), sourced from a defined MRV methodology, not in adjectives.

## 4. Protocol architecture

```
                CLIMATE FINANCE PROTOCOL
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     TOKEN           TREASURY         GOVERNANCE
        │                │                │
        └────────────────┼────────────────┘
                         │
                  PROJECT REGISTRY
                         │
                  PROJECT FINANCING
                         │
                 MILESTONE ENGINE
                         │
                       MRV
                         │
                  IMPACT REGISTRY
                         │
                      SOLANA
```

Eight modules, plus the chain they run on. Not all eight exist yet — see Section 19 (Roadmap) for what's real today versus what's built in later phases.

## 5. Token economics

| Parameter | Value |
|---|---|
| Ticker | **ACT** |
| Chain | Solana (SPL Token-2022) |
| Total supply | **100,000,000**, fixed — minted once, mint authority revoked |
| Freeze authority | Never granted |
| Transaction allocation | **3.5%** total, protocol-enforced via the native transfer-fee extension |

**Per-trade split** (as of 6 Sept 2026 — burn removed, management raised 0.1% → 0.5%; see `TOKENOMICS.md` §01 and `MINT.md`'s fee-authority section for what's needed to actually move this on-chain):

| Destination | Share |
|---|---|
| Recipient (net) | 96.5% |
| Climate Treasury | 2.0% |
| Liquidity | 1.0% |
| Protocol operations (management) | 0.5% |

Worked example: a wallet transfers 100 ACT. 96.5 ACT reaches the recipient. 2 ACT routes to the Climate Treasury. 1 ACT supports liquidity. 0.5 ACT funds protocol operations (MRV, verification, dashboard upkeep — see Section 6).

Scaled to trading volume: if $1,000,000 of taxable volume occurs in a period, roughly $20,000 (2%) accrues to the Climate Treasury from that volume alone, before liquidity/operations shares. This is illustrative — actual accrual depends on real trading volume, which doesn't exist yet pre-launch.

### What the token does

1. **Economic participation** — trading activity contributes to the treasury automatically, by protocol design, not by anyone's discretion.
2. **Governance** — holders participate in Layer 1 governance (Section 7): funding priorities, project categories, treasury allocation weights.
3. **Incentives** — ecosystem participants (project discovery, community contribution, climate-data contribution, project monitoring) can potentially earn tokens for contribution. *Not yet designed or built — Phase 3+.*
4. **Coordination** — the common economic unit the community organizes around.
5. **Reputation** — sustained participation may unlock governance tiers or ecosystem roles over time. *Not yet designed — Phase 3+.*

### What the token explicitly does not do

- It does not promise price appreciation from treasury growth. That framing is a different legal product with real securities exposure, and Aretia does not make that claim.
- It is not a claim on any specific carbon credit (Section 14).
- It is not an investment contract, equity stake, or profit-sharing arrangement (unchanged from the original whitepaper's risk disclosure).

## 6. Treasury

The treasury functions as Aretia's **climate catalyst fund** — standing capital, continuously replenished by trading activity, purpose-built to finance climate mitigation and adaptation projects. It is deliberately not a one-time pledge or a grant round that runs dry: catalytic capital, as used in blended climate finance, seeds and de-risks activity that wouldn't get financed on its own, rather than being the entire bankroll for any one project. Every mechanism below — governed entry, multisig custody, milestone-gated exit — exists to keep that catalyst fund credible and auditable, not just funded.

**How money enters:** the 2% treasury share of every trade's transfer fee, routed automatically by the Token-2022 transfer-fee extension into a Squads multisig.

**How money is stored:** a Solana multisig (Squads), requiring multiple independent signers. **Live as of 1 Sept 2026:** `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg`, 2-of-3 threshold, real independent co-signers — see `TREASURY.md`. This satisfies Section 13's requirement below; it is no longer a single-signer placeholder.

**How money leaves:** only through the governed project-financing pipeline (Section 8) — application, screening, approval, milestone-gated release. Never a direct discretionary transfer.

### Illustrative treasury allocation (functional budget, distinct from project category)

| Allocation | Share |
|---|---|
| Climate mitigation | 60% |
| Climate adaptation | 20% |
| Ecosystem development | 10% |
| MRV / verification | 5% |
| Emergency reserve | 5% |

These weights are a starting configuration, not fixed forever — Layer 1 governance (Section 7) can propose changes through the defined procedure. This is a different dimension from the *project category* split (reforestation, renewable energy, etc.) described in the tokenomics doc — one is "what kind of climate action," the other is "what functional bucket the money sits in" before it's deployed to a specific project.

## 7. Governance — four layers, not one

A flat "token holders vote on everything" model breaks the moment the treasury is large enough to matter — a single well-organized proposal can extract real money from a naive DAO vote. Aretia uses four layers instead:

**Layer 1 — Community.** Token holders propose and vote on funding priorities, project categories, and treasury allocation weights. They do **not** directly approve individual project disbursements.

**Layer 2 — Technical committee.** Domain experts evaluate individual project applications against climate science, MRV credibility, financial feasibility, and environmental/social risk. This is where Aretia Climate's existing climate-intelligence capability (Section 4 relationship, below) plugs in most directly.

**Layer 3 — Independent verification.** A party independent of both the protocol team and the project developer confirms that a funded project actually achieved what it claimed, before further milestone funds release.

**Layer 4 — Smart contract execution.** Funds move only after Layers 2 and 3 have both signed off on a given milestone. No human discretion at the point of transfer — the contract enforces what the governance process already decided.

### Aretia Climate's role — kept as a separate entity, not owner of the protocol

Aretia Climate, LLC (the climate-intelligence company) is **not** the same entity as Aretia Finance LLC (the protocol's issuer), and does not own or control the protocol. Its relevant capability — climate risk modeling, GHG accounting, MRV, geospatial and physical-risk data — makes it a natural **service provider / technical verifier to the protocol** (most likely feeding Layer 2, and potentially Layer 3 for some project types, though independent verification should not be exclusively provided by an affiliated entity for projects where that creates a conflict of interest). This relationship needs a real, arm's-length services agreement once formalized — flagged here, not yet drafted.

## 8. Project lifecycle

1. **Application.** Developer pays a 5,000 ACT registration fee (raised from an initial 1,000 ACT, 7 Sept 2026, same day; to the management wallet — see `MANAGEMENT_FEE.md`, "Project registration fee") and submits: location, technology, capital requirement, expected emissions reduction, project lifetime, beneficiaries, financial model, implementation plan, environmental/social information, monitoring methodology.
2. **Screening (Layer 2).** Does it reduce emissions? Is the methodology credible? Is there additionality? What are the social/environmental risks? Is the developer legitimate? Is the project financially viable? Today, pre-Layer-2-activation, this is management review directly (`WHITEPAPER.md` §9.3) rather than a separate technical committee. No token-holder vote decides individual projects — considered and deliberately rejected, since it reproduces the "DAO-only" failure mode `WHITEPAPER.md` §9.1/§9.4 argues against by name.
3. **Approval.** Layer 2 sign-off (today: management), informed by Layer 1's standing priorities once active (which categories/regions are currently favored).
4. **Milestone-gated financing (Section 9).** Capital releases in tranches tied to verified progress, not as one lump sum on approval.
5. **Implementation.** The developer executes the project.
6. **MRV (Section 10).** Ongoing measurement against the stated methodology.
7. **Verification (Layer 3).** Independent confirmation of claimed progress at each milestone.
8. **Reporting.** Results — funded amount, energy generated, emissions avoided, people served, funding remaining, verification status — published to the public Project Registry (Section 11).

**Worked example (illustrative, not a real project):** a Kenyan developer requests $250,000 for a 2 MW solar mini-grid. The treasury doesn't wire $250,000 on approval. It commits $250,000, then releases $75,000 at Milestone 1, $100,000 at Milestone 2 (after independent verification), and the final $75,000 at Milestone 3 (after final verification) — reducing the risk of capital disappearing into a project that's never finished.

## 9. Milestone financing

Standard shape: **Application → Approval → Milestone 1 release → Verification → Milestone 2 release → Verification → Milestone 3 release → Verification → Final payment.** Exact tranche count and sizing vary by project type and size; the constant is that no tranche after the first releases without independent verification of the prior one.

## 10. MRV framework (Measurement, Reporting, Verification)

*Not yet built — this section defines the target, not a shipped system.* At minimum, an MRV methodology needs to specify: what's measured (energy generated, emissions avoided, beneficiaries reached, jobs created), how it's measured (metering, satellite/geospatial data, site verification), what percentage of expected impact counts as "on track" versus "underperforming," and who is qualified to certify it. Aretia Climate's existing CMIP6/Planetary Computer/geospatial and GHG-accounting work is the most direct internal capability toward this — see Section 7's relationship note.

## 11. Climate integrity — preventing greenwashing

- No project is represented as funded until treasury capital has actually moved on-chain.
- No impact figure is published without a named methodology and a verification party.
- Expected impact and actual impact are both published, side by side, so shortfalls are visible rather than hidden behind an initial projection.
- The token is never described as itself representing a tonne of carbon (Section 14) — that conflation is a common vector for real and perceived greenwashing in this space.

## 12. Smart contracts — what gets automated

- The 3.5% transfer-fee split (deployed and tested at the earlier 4.1% rate with a burn share; the 3.5% figure with no burn and a 0.5% management fee was approved 2-of-3 and executed on-chain 6 Sept 2026, scheduled for epoch 1031 — see `MINT.md`, `TOKENOMICS.md` §01).
- Milestone-gated treasury disbursement, once the Milestone Engine module exists (Phase 2+): funds move only after Layer 2 + Layer 3 sign-off is recorded on-chain.
- What is **not** automated: the judgment calls (screening, verification) — those stay human, by design, per Layer 2/3 above. The contract enforces the *outcome* of human review, not the review itself.

**Technical note on Solana Token-2022:** the transfer-fee split already relies on Token-2022's native `TransferFeeConfig` extension — this is standard, supported behavior, not custom logic. Token-2022 extensions must be planned at mint creation and can affect wallet/DEX/DeFi composability; **DEX and wallet compatibility testing needs to be a real, scheduled part of the pre-mainnet plan**, not an afterthought. Separately: **transfer hooks should be avoided unless a specific future feature genuinely requires one.** A transfer hook runs custom program logic on every transfer and requires extra accounts — real overhead, and Solana's own documentation flags integration/compatibility limitations. The milestone engine and other protocol logic almost certainly belong in a *separate* program that reads/writes the treasury, not bolted onto the token's own transfer path.

## 13. Security

- **Multisig, not a founder's wallet** — the treasury is controlled by a Squads multisig requiring multiple independent signers. A single-person "multisig" does not satisfy this and should not be marketed as if it does (see the earlier flag on treasury setup).
- **Timelocks** — significant treasury actions (allocation-weight changes, large disbursements) should have a delay between approval and execution, giving the community a window to notice and react to something wrong.
- **Emergency controls** — a defined, narrow emergency-pause capability, itself multisig-gated, for the case where something is actively going wrong (an exploit, a compromised signer) — scoped to *halting* new disbursements, not to unilaterally moving funds.
- **Audits** — independent review of the mint configuration before mainnet (already planned in the existing roadmap); independent review of any milestone-engine/governance program before it ever touches real treasury funds.

## 14. Transparency

Publicly available, permanently: every treasury transaction (inflow and outflow), the current treasury allocation weights, the full Project Registry (Section 11 below) with funded amount, milestone status, and verification status per project, and the governance proposal/vote history once governance is live.

## 15. Project Registry

A public, permanent record of every project the protocol has funded:

```
Project #001 — Solar Mini-grid, Kenya
Funding committed:     $250,000
Funding released:      72%
Status:                Active
Expected impact:       18,500 tCO2e
Actual impact:         7,840 tCO2e
Households served:     4,200
Verification:          Completed (Milestone 2)
Blockchain record:     [link]
MRV data:               [link]
Project documents:     [link]
```

*Illustrative — not a real project. The registry itself is a Phase 2+ build, not live today.*

## 16. Legal / regulatory architecture

- Entity structure: **Aretia Climate, LLC** (climate-intelligence company) and **Aretia Finance LLC** (protocol issuer), both Delaware, both formed and legally reviewed as of 1 Sept 2026 — see `ATTORNEY_BRIEF.md`.
- A third entity, **Aretia Foundation** (Delaware nonprofit, formed but not yet active), is **not** part of this ownership structure and never becomes a parent of either LLC — reviewed and confirmed 4 Sept 2026, see `FOUNDATION_BRIEF.md`. It is expected to pursue its own 501(c)(3) status independently and, if that happens, may interact with the treasury as a counterparty (a vetted grant recipient of the catalyst fund, or a co-funder bringing outside grant dollars) — never as an owner or controller of Aretia Finance LLC.
- **Everything added in this document beyond the original simple treasury mechanism is new legal surface area**, specifically: governance-token characterization (does Layer 1 voting power change the securities analysis?), milestone-financing/project-lending characterization (does the protocol's project financing resemble a lending or investment activity requiring separate licensing?), incentive-token distribution (does paying contributors in ACT for work create a compensation/securities question?), the 5,000 ACT project-registration fee paid to the management wallet (an applicant-pays-the-decision-maker structure — defensible as cost recovery for review work, but needs counsel to confirm it doesn't read as pay-to-play, especially since the fee's real dollar value is undefined until ACT trades; see `MANAGEMENT_FEE.md`), and the Aretia Climate ↔ Protocol service relationship (needs a real intercompany agreement, arm's-length terms, and conflict-of-interest handling for any project where Aretia Climate both provides MRV data and financially benefits from the relationship). None of this is resolved. All of it needs counsel before any of it is represented as final, publicly.
- The token is never to be marketed as representing carbon credits directly (Section 14/Token economics) — that is a different, more heavily regulated product category.

## 17. Roadmap — four phases, not one launch

**Phase 1 — Foundation** *(current phase; mostly what's already built)*
- ✅ Token (ACT) — **live on Solana mainnet**, `BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT`, fixed 100M supply, mint authority revoked, fee authorities on the treasury vault. See `MINT.md`.
- ✅ Entity formation and initial legal review
- ✅ Treasury multisig with real independent signers — live on mainnet, 2-of-3, tested end-to-end
- ⬜ Transparent transaction allocation live on a public dashboard
- ⬜ Basic governance (even if team-curated at first)
- ⬜ Project Registry (v1 — manual/simple, not the full on-chain version)
- ✅ Project application intake (`apply.html`) — built ahead of schedule, live at launch rather than waiting for Phase 2. Now gated on a 5,000 ACT registration fee paid from the applicant's own wallet (see `MANAGEMENT_FEE.md`, "Project registration fee") before the form unlocks. Screening (Layer 2) and milestone-gated funding are not yet built; submissions are received, not yet automatically processed. **The form still can't actually deliver a submission** — `action` points at a literal `YOUR_FORM_ID` Formspree placeholder that was never replaced with a real form ID; fix this before treating the intake as functional.

**Phase 2 — Climate finance**
- Project scoring (Layer 2), funding proposals, milestone-gated funding, verification (Layer 3)

**Phase 3 — MRV**
- Project monitoring, climate-impact measurement, emissions accounting, satellite/geospatial data integration, climate-risk data, independent verification infrastructure, incentive-token mechanics for ecosystem contributors

**Phase 4 — Global protocol**
- Multiple countries and project types, institutional participation, project developers, climate funds, NGOs, additional validators/verifiers, potentially multi-chain

The mistake to avoid: building Phase 3/4 machinery before Phase 1 is genuinely solid. A treasury multisig still controlled by one person, or a governance system that exists on paper but not on-chain, undermines every claim this document makes about decentralization and accountability. Phase 1 has to be real before Phase 2 starts.

---

*This is a living architecture document. `TOKENOMICS.md` and `WHITEPAPER.md` should stay consistent with it; where they haven't caught up yet, this document is the source of truth.*
