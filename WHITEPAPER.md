# Aretia Finance Protocol

*A Protocol-Enforced Climate Catalyst Fund*

`aretiafinance.org`

---

## Abstract

Climate finance suffers from a verification problem, not fundamentally a capital problem. Corporate climate commitments have accelerated even as proof of delivery has lagged behind them, a divergence most legible in the voluntary carbon market, where credit issuance has for years outpaced the retirements that would prove a credit was actually used.[^1] Separately, permissionless trading on major blockchain networks moves substantial capital daily for reasons unconnected to any social purpose. This paper describes a protocol that converts a fixed share of that ordinary trading activity into a continuously replenished climate catalyst fund. The conversion is enforced by the token's own transfer-fee extension rather than by policy, so the property holds by construction rather than by an operator's good conduct; that immutability applies to the aggregate fee rate specifically, a distinction Section 14 makes precise. Capital leaves the fund only against independently verified project milestones, with every step from withholding to disbursement visible on a public ledger and independently reproducible by any observer. What follows sets out the theory of change, the token protocol and its arithmetic, project selection and governance, an economic and legal analysis, and an impact-documentation framework, closing with a proposed and explicitly unbuilt second capital stage, gated by participation in ACT but never routed through the token itself, subject to prerequisites this paper states plainly rather than assumes.

---

## Part I. The Financing Challenge for Climate Mitigation and Adaptation Projects

## 1. The Verification Problem in Climate Finance

Trust in climate finance fails at a specific point: the gap between a pledge and its verification. Corporate climate commitments rose roughly 227 percent in the eighteen months to mid-2025, even as voluntary carbon credit retirements, the step that proves a credit was actually used rather than banked and forgotten, fell 7 percent over the same period.[^1] Commitment outpaced proof, and the divergence is itself the diagnostic. More recent data suggests the gap is narrowing, but from the supply side: first-half 2026 retirements held near 98 million credits while new issuance fell 31.9 percent year over year, to about 96.8 million.[^2] Supply and demand moved closer together, but a smaller, better-balanced market is not the same claim as a more reliably verified one; the structural weakness, that verification happens after the fact and is often performed by a party with an interest in a favorable result, was tested against fewer transactions, not resolved.

The mechanisms conventionally available to close this gap, grants, offset purchases, corporate pledges, share a common defect: each depends on a promise being honored after money or intent has already moved, and a grantor rarely audits its own grantee with the rigor an adversary would apply. A related but distinct problem affects projects that are already technically proven: a pilot with no doubt about its underlying engineering frequently cannot secure capital to scale, because conventional financing is built around large, discrete rounds poorly suited to incremental, milestone-based growth. A fund capitalized continuously, rather than through periodic raises, is structurally better matched to that need than either a one-time grant or a loan sized for a single disbursement.

None of this presumes bad faith. It is a claim about incentive structure: a system in which verification is optional, delayed, and self-administered will tend, in aggregate, toward exactly the pattern the data already shows. The correction is not moral exhortation but mechanism design. If verification cannot reliably be supplied by voluntary conduct, it must be supplied by structure.

## 2. Why Existing Approaches Fall Short

A mechanism paper is incomplete if it does not explain what it is not. Four existing categories each address part of the verification problem, not the whole of it.

### 2.1 Voluntary Carbon Markets and the Retirement Gap

Registries such as Verra and Gold Standard supply real methodological rigor to whether a reduction occurred; the market's weakness is follow-through, not measurement. A credit can be purchased and never retired, satisfying a buyer's internal accounting without completing the act that proves use. This protocol does not replace carbon registries; Section 17 treats registry-issued credits as one valid form of verified output. What it adds is a disbursement mechanism, described in Section 16, that does not depend on a purchaser's later discretion to complete a retirement step.

### 2.2 Traditional Grant-Based Climate Philanthropy

Grant philanthropy typically disburses in large tranches against a proposal and a narrative report authored substantially by the grantee itself. Considerable expertise goes into grant selection, but verification and disbursement are not architecturally coupled: a grant can be fully paid before a deliverable is confirmed, and the confirmation, when it occurs, is rarely independent of the party being evaluated. Section 16 describes a disbursement process in which that coupling is structural: a tranche is an instruction that will not execute until independent verification has already occurred on-chain.

### 2.3 Blended and Catalytic Finance

Catalytic capital, a term this paper adopts and extends in Part III, denotes capital placed to unlock activity that would not otherwise be financed on commercial terms, a first mover rather than the entire bankroll. Existing catalytic vehicles are capitalized through discrete fundraising events, requiring a fresh campaign each time a facility is deployed. The contribution here is narrow: whether such a vehicle can be capitalized continuously, as a structural property of an unrelated economic activity, rather than periodically. Section 6 makes this precise; Section 9 addresses whether the fund is catalytic in the stronger, measurable sense the term implies in that literature.

### 2.4 Token-Based Fundraising Without Enforcement

A number of tokens describe themselves as supporting a cause through a stated intention to donate trading fees or treasury holdings at the team's discretion. A token, for readers unfamiliar with the term, is a digital record of ownership on a public ledger, transferable without a bank or broker, its rules defined in code that runs on the ledger itself, a smart contract or, on Solana, a program.[^3] The distinguishing weakness of the charitable-token category is that the donation commitment is policy, not a property of the code: a team can simply not honor it without violating any smart contract, and an outside observer has no way to detect the omission besides the team's own disclosure. Sections 10 through 15 specify a token whose aggregate fee is a property of the mint's own on-chain configuration, verifiable without trusting the issuer's representation of it, a distinction this paper treats as load-bearing. Several existing environmental tokens illustrate the pattern being distinguished from: an intended percentage is publicized at launch but never implemented as an enforced, on-chain rule.[^4]

---

## Part II. Liquidity Availability through Emerging Financial Instruments and Digital Assets

## 3. Permissionless Trading as an Untapped Capital Source

Permissionless trading on major blockchain networks moves substantial capital daily for reasons unrelated to climate objectives. On Solana, permissionless community tokens reached a combined market capitalization near $40 billion by mid-2026, with Solana decentralized-exchange volume alone near $3.01 billion across a single 24-hour window.[^5] BNB Chain processed a comparable $1.25 billion in the same kind of window, with a July 2026 surge lifting BNB Chain volume 45 percent and Solana activity 38 percent.[^6] On Ethereum, individual permissionless tokens in this category carry market capitalizations in the low billions, within a combined cross-chain category exceeding $30 billion as of September 2026.[^7] This volume is not solicited; it is a byproduct of ordinary markets that would exist regardless of any climate-linked project.

The observation at the center of this paper is that three facts, a verification gap, a financing gap for already-proven projects, and an untapped, purpose-agnostic capital flow, can be connected mechanically rather than rhetorically. A protocol-level fee, enforced the way a transfer-fee extension is enforced (automatically, on every transfer, by the token standard itself) converts a fixed share of activity that already exists into climate capital independent of anyone continuing to believe in the underlying mission. The mechanism does not ask traders to care; it asks the token standard to do arithmetic, which it does regardless of sentiment. This does not, on its own, establish that meaningful volume will in fact materialize for this specific token; Section 20 returns to that question directly.

## 4. Contributions and Organization of This Paper

This paper defines the climate catalyst fund as a structural object distinguished by continuous replenishment and non-discretionary capitalization; specifies the token protocol and fee arithmetic in full, including which parts are enforced by immutable code and which remain subject to treasury governance; specifies a milestone-verified disbursement process and a category-specific diligence framework; presents a four-layer governance architecture designed against the failure mode of flat, one-holder-one-vote systems; offers a comparative economic analysis including where demand for the token itself might or might not come from; and states its own risks, limitations, and open legal questions rather than leaving them to be inferred.

The paper is organized into six further parts. Part III defines the catalyst fund and its theory of change. Part IV specifies the token protocol. Part V specifies project selection and governance. Part VI offers economic and social analysis, network selection, and legal status. Part VII addresses transparency, impact documentation, and illustrative arithmetic, followed by a conclusion. Part VIII departs from the rest of the paper's convention of describing only what is live or fully specified, proposing a second capital stage and stating what would need to be true before any part of it is built. An appendix of on-chain addresses follows.

---

## Part III. The Logic of the Catalyst Fund

## 5. Theory of Change

The causal chain runs as follows. Permissionless activity that already exists, and would exist regardless of this protocol, passes through a protocol-enforced fee at the moment of transfer. That fee produces continuous capital formation in a treasury-held fund without a discrete fundraising event. Capital is allocated to projects through a selection process independent of the treasury. Disbursement proceeds only in milestone-based tranches, each confirmed by verification independent of both this protocol's team and the project developer. Verified milestones produce climate outputs, connected category by category to climate outcomes, a distinction Section 17 draws precisely, and where a project's category permits it, verified outcomes are positioned to help mobilize additional capital, the sense in which the fund aims to be catalytic, a claim Section 9 treats as a target to be measured rather than a result already demonstrated.

Every link up to and including milestone-based disbursement is either already live on Solana mainnet or specified precisely enough to be built and independently checked. The final two links, that verified outputs correspond to genuine outcomes and that those outcomes mobilize further capital, depend on facts about the physical world and other actors' behavior that no protocol can guarantee by construction. Section 22 states directly what this mechanism does not, and cannot, guarantee.

## 6. Definition and Structural Properties

The catalyst fund is a treasury-held pool of capital that is, first, capitalized continuously by protocol-enforced fees rather than periodic fundraising; second, held under multi-party custody rather than any single controller; and third, disbursed only against independently verified milestones. Each property is structural, guaranteed by the system's design rather than by any party's conduct, a distinction Section 20.2 elaborates.

## 7. Continuous Replenishment

Let F(t) denote the fund balance at time t:

    F(t) = F(0) + Σ [0.02 × Vᵢ]   for every harvested transfer i occurring in (0, t]

where Vᵢ is the value of transfer i. F(t) is non-decreasing in trading activity and requires no fundraising event to increase, unlike a grant pool, whose balance is a step function, flat between raises and discontinuous at them. This says nothing about how large or frequent harvested transfers will be in practice; Section 20 treats that dependence explicitly.

## 8. Non-Discretionary Capitalization

No signer decides whether a given transfer contributes to F(t); the transfer-fee extension withholds at the protocol level, with no code path for a transfer to complete without it. A fund could in principle be replenished continuously by a party who nonetheless retained discretion over honoring that replenishment; this fund does not possess that discretion. Non-discretionary capitalization means whether a given transfer contributes cannot be revisited transaction by transaction; it does not mean the rate can never be revisited at all, a distinction Section 14 addresses, since the aggregate fee rate remains subject to treasury governance.

## 9. Relationship to Catalytic Capital in Blended Finance Theory

As Section 2.3 notes, catalytic capital denotes capital deployed to de-risk activity that would not otherwise clear commercial financing thresholds. This fund occupies that position, seeding climate work in verified tranches rather than functioning as a passive reserve or a lump-sum pool. The extension proposed is substituting continuous, code-enforced capitalization for the periodic, discretion-dependent capitalization that characterizes catalytic vehicles today.

That extension addresses how the fund is capitalized, not whether its deployments are catalytic in the stronger sense the literature intends: capital that demonstrably unlocks additional financing, rather than capital simply granted toward an outcome that would not otherwise have been financed. This paper's own grants are catalytic in intent without yet being catalytic in demonstrated leverage, since no funded project has yet reached completion. To make the term measurable, this paper adopts a catalytic leverage ratio:

    CLR = (Total external capital mobilized) / (Aretia capital deployed)

A CLR of 1 indicates a project received no additional financing beyond the fund's grant; a CLR of 4 indicates four additional dollars followed each dollar of catalyst-fund capital. No CLR is reported here, since no project has yet reached the disbursement process in Part V against which one could be measured; it is stated as a target this protocol commits to tracking once real disbursements occur.

---

## Part IV. The Token Protocol

The preceding parts describe why this mechanism exists. This part specifies how it is implemented: the token, its fee, the authorities that govern that fee, and the custody arrangement holding what the fee collects. Readers interested primarily in motivation and governance may proceed directly to Part V.

## 10. Token Design Overview

A token's design refers to the fixed parameters set at creation: how many units will ever exist, who if anyone can change that later, and what is automatically deducted from every transfer. These choices are recorded permanently on the ledger and independently checkable by anyone. Not every choice is equally permanent; Section 11 is explicit about which are and which are not.

## 11. Supply and Authority Structure

ACT is a Solana SPL Token-2022 asset. A Token-2022 mint carries several distinct on-chain authorities, each independently revocable or retainable; treating "immutable" as one property of the token obscures which specific capability is fixed. The table states the current status of every authority relevant to this protocol.

| Authority | Current holder | Can modify? | Revoked? |
|---|---|---|---|
| Mint authority | None | No | Yes, permanently, following the single initial mint |
| Freeze authority | None | No | Yes, never granted at deployment |
| Transfer-fee-config authority | Treasury multisig (2-of-3 Squads) | Yes, with 2-of-3 signer approval | No |
| Withdraw-withheld authority | Treasury multisig (2-of-3 Squads) | Yes, with 2-of-3 signer approval | No |
| Metadata (Metaplex account, via MetadataPointer) | A single deployer-held key remains recorded as update authority | No, in practice | Not formally revoked, but the account's own `is_mutable` flag is permanently false, which the Metaplex program enforces as a lock independent of who holds that recorded authority |
| Treasury (vault) authority | Treasury multisig (2-of-3 Squads) | Yes, with 2-of-3 signer approval | No, and not intended to be |

Total supply, 1,000,000,000 units at 9 decimals, and the impossibility of freezing any account are fixed absolutely. Mint authority was permanently revoked immediately after the single initial mint, which deposited the full supply into the treasury vault; no wallet has held newly created ACT outside that mint. Freeze authority was never granted.

The transfer-fee-config and withdraw-withheld authorities are, by contrast, deliberately retained by the treasury multisig, both requiring the same 2-of-3 approval that governs every treasury action in Section 15. This is not theoretical: the fee rate stated throughout this paper, 3.5 percent, was arrived at through exactly this mechanism, changed from an earlier 4.1 percent by a 2-of-3 approved transaction, with Token-2022 requiring the change take effect only from a future epoch. Section 14 states precisely what this means for which parts of the fee mechanism are and are not immutable. On-chain addresses are collected in Appendix A.

## 12. Immutability as a Design Choice, and Its Costs

Irrevocability is a deliberate tradeoff, not a costless guarantee. Permanently revoking mint authority forecloses any future adjustment to total supply, including one motivated by a need this paper cannot anticipate today, such as a security remediation requiring a supply migration; once revoked, that authority cannot be reinstated by any party. Freeze authority carries a parallel cost: never having been granted forecloses any future ability to freeze a compromised or implicated account, a capability some other deployments retain deliberately for that scenario. This paper treats both as acceptable costs of a stronger guarantee elsewhere, a non-discretionary supply and a non-discretionary account status, rather than as costless.

Metadata is governed separately and is not subject to the same tradeoff. ACT's name, symbol, and logo are attached through a Token-2022 MetadataPointer extension referencing a separate Metaplex Token Metadata account, populated at deployment; ACT displays a name and logo in any wallet or explorer supporting Token-2022 metadata. That account's own update-authority field still names a single key, not the treasury multisig, but its `is_mutable` flag was set to false at creation, a setting the Metaplex program itself enforces: no further update to the name, symbol, or logo is possible for any party, including that recorded authority. Metadata is accordingly immutable in practice despite a single key remaining nominally on record as its authority.

## 13. Market Access and Permissionless Trading

ACT trades on the open market against USDT, with no permission requirement. Any Solana wallet or exchange capable of handling a standard Token-2022 asset can transact it without protocol-specific integration, a property inherited from the token standard.

## 14. The Transfer-Fee Mechanism

### 14.1 The Withholding Function

Token-2022's native transfer fee extension withholds a percentage of every transfer at the protocol level, before the recipient's balance is credited, up to a configured maximum. The rate is 350 basis points, 3.5 percent, as of the epoch at which it last took effect.

### 14.2 What Is Protocol-Enforced and What Is Treasury Policy

This distinction governs how every other claim about the fee should be read. What Token-2022 enforces, without exception, is that the aggregate withheld amount is computed and withheld correctly at whatever rate is configured. What it does not enforce is any particular destination for that withheld amount once harvested, nor that the rate stays fixed forever, since the transfer-fee-config authority retains the power to change it under 2-of-3 approval and Token-2022's mandatory future-epoch delay. The protocol's strongest accurate claim is that it mechanically withholds 3.5 percent of every transfer, and that the treasury subsequently routes harvested fees per the split below; it is not accurate to state the protocol automatically sends any share directly to climate projects, since routing is treasury procedure under multisig approval, not a second on-chain-enforced ratio.

### 14.3 Fee Allocation

96.5 percent of every transfer reaches the recipient net of the fee. Of the 3.5 percent withheld, 2.0 percentage points (about 57.1 percent of the withheld amount) route to the catalyst fund, 1.0 point (28.6 percent) to liquidity, and 0.5 points (14.3 percent) to protocol management, once harvested. Only the 3.5 percent aggregate is on-chain enforced; the destination split is the treasury's own procedure, applied consistently under the custody described in Section 15.

### 14.4 The Two-Phase Withhold-and-Harvest Design

A withheld amount does not move automatically at transfer time. It accumulates inside the recipient's own account as a publicly readable running balance; a separate "harvest" instruction later sweeps accumulated amounts into the treasury. This two-phase design lets every wallet and exchange already supporting Token-2022 handle ACT correctly with no protocol-specific integration; the complexity is confined to the harvest step, executed only by the treasury multisig.

### 14.5 Management-Fee Delivery and the Gross-Up Problem

The management fee wallet is held separately from the treasury multisig, so operational compensation can never be commingled with catalyst fund capital structurally. Delivering it requires a second transfer that itself incurs the same withholding. To land a net amount N after that transfer's own fee, the treasury must send a gross amount G satisfying:

    G − fee(G) = N
    G × (1 − b) = N     [when fee(G) < M]
    G = N / (1 − b) = N / 0.965

where b is the fee rate and M the mint's configured maximum fee. To deliver 1,000 ACT net, the treasury sends approximately 1,036.27 ACT, of which about 36.27 re-enters the fee split. A treasury operator who failed to account for this would systematically underdeliver intended compensation.

## 15. Treasury Custody

### 15.1 Multisignature Custody Model

Harvested fees settle into a Solana multisig using the Squads protocol, live on mainnet. The multisig defines three signers and a threshold of two; no single key, including any held by this protocol's operating entity, can move capital or change the transfer-fee rate unilaterally.

### 15.2 Threshold Selection: Why Two of Three

Two of three is the smallest configuration eliminating unilateral control while remaining operationally practical at this scale, consistent with Squads' own guidance. Section 18's governance architecture is the mechanism by which this parameter could be revisited as the system matures.

### 15.3 Signer Identity and Independence

*[Placeholder: this subsection will state, for each of the three signers, their role, independence from one another, jurisdiction, conflict-of-interest policy, replacement procedure, and key-security practices. Institutional counterparties will expect this in full, and this section is left open pending that disclosure rather than answered with generic assurances.]*

### 15.4 Operational Verification

The propose, review, approve, execute cycle has been tested end to end with a real mainnet transaction, approved independently by two of three signers: the transfer-fee rate change in Section 11 is itself an example of this cycle exercised for real, not merely configured.

---

## Part V. Project Selection and Governance

## 16. Milestone-Verified Disbursement

### 16.1 Forms of Disbursement

Capital leaves the fund primarily as a grant to a vetted project partner not itself tokenized. On-chain retirement of tokenized carbon credits is recorded here as a form the protocol may adopt should that infrastructure mature, not as a mechanism presently in use.

### 16.2 Tranche Structure and the Sequencing Problem

An approved project's commitment is divided into tranches, each releasing only after independent verification confirms the preceding milestone was met. This sequencing prevents "the fund financed a project" from silently meaning, in a given instance, "the fund sent money to a project that failed to complete its work," a failure mode Section 2.2 identified as endemic where verification and payment are not architecturally coupled.

### 16.3 On-Chain Auditability of Disbursements

Every disbursement is a public on-chain transaction from the known treasury address, representable to any observer only as what the chain state shows it to be.

## 17. Project Selection and Diligence

### 17.1 Category Taxonomy

The fund finances five categories: renewable energy, waste-to-energy, carbon reduction, technical assistance, and flood management and reforestation, each held to a diligence standard appropriate to its claim, applied by the technical committee in Section 18.

### 17.2 Levels of Verification: Activity, Output, and Outcome

Three levels matter throughout this Part. Activity describes what work was performed. Output describes what that activity directly produced, typically what Section 17.3's standards verify. Outcome describes the underlying climate result the output is evidence of, which usually requires an additional inferential step, metered generation implies avoided emissions only via an assumption about displaced energy sources; hectares planted imply removed carbon only via registry-governed assumptions about growth and survival. This protocol's disbursement process verifies activity and output directly; outcome claims rely on established third-party methodologies rather than an independent claim this protocol makes itself.

### 17.3 Category-Specific Diligence Standards

| Category | Verified output | Diligence standard |
|---|---|---|
| Renewable energy | Metered generation capacity added | Independent engineering certification; interconnection or off-take documentation |
| Waste-to-energy management | Waste diverted and energy generated | Operating permits, throughput metering, emissions monitored against a baseline |
| Carbon reduction | Emissions avoided or removed | Registry-issued credits or an equivalent third-party MRV protocol |
| Technical assistance | Capacity delivered: studies, training, MRV systems | Deliverable-based milestones; independent review of the work product itself |
| Flood management and reforestation | Hectares restored; flood-risk reduction | Remote-sensing canopy verification; hydrological modeling or post-event assessment |

Each row verifies an output in the Section 17.2 sense; translating it into a quantified outcome depends on the category-appropriate third-party methodology referenced, reported as such rather than independently verified by this protocol.

### 17.4 The Special Case of Technical Assistance

Technical assistance differs in kind, not degree: it funds the capacity that makes a future project bankable, a feasibility study or an MRV system a smaller developer could not otherwise build, rather than producing a physical or registry-verifiable output of its own. Its diligence is oriented around the work product actually delivered, since no physical asset yet exists to inspect.

### 17.5 Portfolio Weighting as a Governance Parameter

Category determines diligence standard; it does not alter the milestone-release mechanism in Section 16, which governs every category identically. Relative category weighting is a Layer 1 governance parameter under Section 18, not fixed by this document.

## 18. Governance

### 18.1 The Failure Mode of Flat Token-Holder Voting

A flat, one-holder-one-vote system governing individual disbursements fails once a treasury is large enough to be worth attacking: a well-organized proposal can extract funds from a naive vote regardless of its formal legitimacy. This is a general property of systems concentrating decision authority in a single mechanism with no independent check on substance.

### 18.2 A Four-Layer Architecture

Governance is layered across four functions. Community governance, exercised through Realms, sets funding priorities and treasury allocation weights but does not vote on individual disbursements. A technical committee screens applications for scientific credibility, MRV soundness, and financial feasibility. Independent verification confirms, at each milestone, that a party independent of both this protocol's team and the developer has verified claimed progress. Smart-contract execution releases funds only once both layers have signed off, with no human discretion at the point of transfer.

### 18.3 Appointment Independence

Layering discretion introduces a narrower version of the same problem one level removed if the community layer alone appoints the technical committee and the committee alone appoints verifiers: the checking layers could become answerable only to each other. Appointment to the technical committee and the verifier pool runs through a nomination process kept structurally distinct from both the community vote and the treasury's operating entity, so neither owes its position to the party whose work it evaluates.

### 18.4 Phased Activation

Governance is phased in against real participation. Layer 1 activates once the holder base is large enough for a vote to carry genuine information content. Layers 2 through 4 build out across subsequent roadmap phases. Until Layer 1 is live, the treasury operates on team-curated grants under the identical milestone-verification discipline in Section 16.

### 18.5 Comparison to Single-Signer and DAO-Only Models

A single-signer model offers speed at the cost of the non-discretionary property this paper emphasizes throughout. A DAO-only model, voting directly on every disbursement, reintroduces Section 18.1's failure mode: a coordinated plurality can vote to disburse the treasury to itself. The four-layer architecture is designed to occupy neither extreme.

---

## Part VI. Economic and Social Analysis

## 19. Network Selection

### 19.1 Requirements for the Underlying Ledger

This mechanism requires transaction costs low enough for routine operations to remain economical, a native protocol-level fee-on-transfer primitive, and sufficient stable-asset liquidity to support the trading pair in Section 13.

### 19.2 Comparative Analysis

| Network | Fee per transfer | Native fee-on-transfer support | USDT liquidity |
|---|---|---|---|
| Solana | approximately $0.0003 | Yes, via the Token-2022 extension | Native SPL USDT, deep on Raydium and Orca |
| Base | approximately $0.01 to $0.05 | No, requires custom contract logic | Bridged USDT |
| BNB Chain | approximately $0.10 to $0.30 | No, requires custom contract logic | Deep, but with more centralized custody risk |
| Ethereum L1 | $2 to $30 or more | No, requires custom contract logic | Deepest overall, but expensive to disburse from frequently |

### 19.3 The Cost of Bespoke Fee Logic

The deciding factor is native fee-on-transfer support. On any chain lacking it, the withholding mechanism in Part IV would require bespoke program logic, an added attack surface reviewed separately from the token standard itself. Token-2022's extension is shared infrastructure already implemented correctly by every Solana wallet and exchange, built once for the whole ecosystem rather than once per project.

## 20. Economic Analysis

### 20.1 Fee Incidence and Trading Behavior

A 350-basis-point fee is a real cost, and whether it meaningfully deters the trading it depends on is an open empirical question this paper does not claim to have resolved, since no ACT trading history yet exists. What can be stated is narrower: the fee is fixed and fully disclosed before any transaction, unlike slippage or price impact, which vary with trade size and are often larger in absolute terms. Once real trading exists, this protocol commits to measuring and disclosing volume, unique holders, transfer frequency, realized fee revenue, liquidity, slippage, and retention.

### 20.2 Credible Commitment Through Mechanism Design

Section 2.4's distinction between a policy commitment and a code-enforced property has a formal name: the difference between cheap talk and a credible commitment device. A statement of intent the issuer could costlessly reverse is cheap talk regardless of sincerity. A property enforced by an immutable, permissionless standard is a credible commitment in the technical sense, since reneging would require an authority that no longer exists. Sections 11 and 12 describe the specific mechanism, permanent revocation, by which this is made costly to break for supply and freezing specifically; Section 14.2 is explicit that this property applies to the aggregate rate's correct withholding, not to the rate's value remaining fixed forever or to the destination split, both of which remain governed rather than immutable.

### 20.3 Liquidity Provision Incentives and Impermanent Loss

Whoever supplies the other side of the ACT-USDT pool bears impermanent loss, a standard property of automated market making, not a feature specific to this token. The fund's replenishment depends on trading volume, which depends on liquidity existing in the first place, which depends on some party accepting that risk for a share of trading fees.

### 20.4 Sources of Demand for ACT

This mechanism explains how trading activity generates climate capital; it does not explain why sustained trading in ACT specifically should occur, and these are two separate questions. The first is answered mechanically by Sections 7 and 8, regardless of who trades or why. The second is unresolved and cannot be resolved by this document; it depends on market conditions this protocol does not control, and the paper's own conclusion already names scale as the primary remaining challenge.

Five things are commonly conflated under "why buy the token." Protocol utility is what ACT does inside the system: the asset whose transfers trigger the fee. The economic mechanism is what happens at transfer: a fixed percentage withheld and routed per Section 14. Governance rights are what holders eventually control once Layer 1 activates: funding priorities, not individual disbursements. Impact utility is what the resulting activity finances. Speculative demand is whatever the market independently creates around price, which this protocol neither engineers nor controls. This paper does not claim climate impact automatically creates token value, and does not require that claim: the fee-generation arithmetic in Section 7 operates on transfer activity itself, not price appreciation, and produces identical inflows whether ACT's price rises, falls, or stays flat, given the same transfer volume.

## 21. Social Dimensions of Project Selection

The five-category taxonomy deliberately includes technical assistance because that category serves developers with a credible technical approach but insufficient resources to produce the feasibility studies or MRV systems that would make a capital request bankable elsewhere. A diligence framework calibrated only to well-resourced applicants would exclude exactly the applicants a catalyst fund of this kind is best positioned to serve. Whether the process in practice remains accessible to smaller developers, rather than only those best able to navigate a formal review, is an open item this paper does not consider settled.

## 22. Risks and Limitations

Insufficient trading volume is the most direct risk: inflow is a fixed percentage of activity, and if that activity stays small the fund stays small regardless of mechanism soundness. A fee-induced reduction in volume is a related but distinct risk this paper commits to measuring rather than assuming an answer to. Liquidity risk and price volatility apply to ACT without qualification. Smart-contract and token-standard risk exists at the infrastructure level: this protocol's own harvest-and-route code has not yet undergone the independent review noted as outstanding in Section 26. Governance capture is a risk the four-layer architecture is designed to resist, not eliminate; verifier conflicts, undisclosed relationships between a nominally independent verifier and a project, would undermine the sequencing guarantee without being visible from the on-chain record alone. Project failure is inherent to project financing generally. Regulatory uncertainty could constrain participation or operation in ways this paper cannot predict. Climate-impact measurement uncertainty means even a fully successful disbursement process produces outputs whose translation into outcomes still depends on methodologies this protocol does not control.

None of this is hypothetical in the sense of unlikely; several, including insufficient volume and the absence of a completed review, are simply true of the mechanism's current stage.

## 23. Legal and Regulatory Status

This paper does not attempt a legal classification of ACT, since that requires jurisdiction-specific analysis it is not positioned to provide. ACT is a blockchain-based digital asset native to this protocol. Nothing here constitutes an offer of securities, investment advice, or a representation that ACT is classified identically across jurisdictions, whether as a utility token, payment token, investment contract, governance token, commodity-like asset, or otherwise. Treatment may differ by jurisdiction and depends on circumstances including some that have not yet occurred. Prospective holders should seek jurisdiction-specific legal advice rather than rely on this document as a substitute for it.

---

## Part VII. Impact Documentation and Management

## 24. Transparency and Independent Verifiability

### 24.1 On-Chain and Off-Chain Verification

On-chain claims, the mint's fixed supply and authorities, the fee configuration, the multisig threshold, every disbursement, describe chain state any party can independently recompute from the Solana ledger. Off-chain claims, the climate statistics cited in Part I, engineering certifications, a funded project's real-world performance, cannot be verified from the ledger, which records that the protocol did what it claims, not independently whether the underlying real-world claim is itself true. The ledger verifies protocol behavior, not physical reality.

### 24.2 The Transparency Dashboard

A public dashboard indexing inflow, disbursement, and running totals is in development and not yet live.

### 24.3 Client-Side Self-Verification

A client-side verification tool, already deployed at this protocol's website, queries Solana mainnet directly from the visitor's own browser and independently recomputes the on-chain claims in Sections 11 and 14.3, displaying the live result beside the documented claim. The tool's own source is visible in the page it runs from, so a skeptical visitor need not trust the tool either. This is a genuine mitigation against a specific risk rather than a substitute for it: a name, symbol, and logo, however accurately displayed for the genuine ACT mint per Section 12, are not unique to it, since nothing prevents a fraudulent mint from using a matching name and logo of its own; only the mint address itself is unique, which is why this tool verifies address-level facts directly rather than asking a visitor to trust a display name. It verifies only the on-chain category of claim in Section 24.1, not the off-chain category.

## 25. Illustrative Calculation

The mechanism's output is arithmetic, not a forecast. For any aggregate ACT transfer volume V between harvests, before the maximum-fee cap in Section 14.1 applies to any individual transfer:

| Aggregate volume V | Catalyst fund (2.0%) | Liquidity (1.0%) | Management fee (0.5%) |
|---|---|---|---|
| $10,000 | $200 | $100 | $50 |
| $100,000 | $2,000 | $1,000 | $500 |
| $1,000,000 | $20,000 | $10,000 | $5,000 |

Applied to illustrative annual volume rather than a single harvest:

| Illustrative annual transfer volume | Illustrative annual catalyst-fund capital |
|---|---|
| $1,000,000 | $20,000 |
| $10,000,000 | $200,000 |
| $50,000,000 | $1,000,000 |
| $100,000,000 | $2,000,000 |
| $500,000,000 | $10,000,000 |
| $1,000,000,000 | $20,000,000 |

Neither table is a projection of ACT's actual future volume, which is presently unknown. No step depends on price or sentiment; each is a fixed function of transfer volume, identical whether that volume reflects one large trade or many small ones.

---

## 26. Conclusion

This paper has described a mechanism converting a fixed, protocol-enforced share of ordinary token-transfer activity into standing climate capital, one that requires no renewed pledge, no trust in any party's discretion, and no step from withholding through disbursement that cannot be independently checked against the public ledger. The mechanism, as distinct from its eventual scale, is live: ACT is deployed on Solana mainnet with supply fixed and mint authority permanently revoked, and the treasury multisig operates under tested, exercised custody rather than merely configured custody. This paper has been explicit about what remains outside its guarantees: the fee rate and destination split remain governed rather than immutable; sustained demand for ACT is an open question Section 20.4 does not resolve; legal characterization varies by jurisdiction and is not settled here; and the risks in Section 22 are properties of the mechanism's current stage, not remote possibilities.

What remains is scale: real trading volume, a seeded liquidity pool, an independent program review, a live dashboard, disclosed signer identities, and a first slate of verified project partners against which the catalytic leverage ratio can finally be measured rather than only defined. None of this requires trusting a new promise; each is a specific piece of work whose completion will be as verifiable as everything already described. This protocol does not ask any party to promise that climate finance will happen; it attempts to encode the financing mechanism into the infrastructure that generates the capital, keeping generation, selection, verification, and disbursement structurally separate, while stating precisely where its guarantees end and an open question begins. Part VIII sets out, separately and with its own prerequisites, a proposed extension toward a second capital stage; nothing above presumes it will be built, and nothing in it should be read as already true of the protocol today.

---

## Part VIII. Toward a Climate Capital Marketplace: A Proposed Second Stage

## 27. Motivation and Scope of This Part

Everything in Parts I through VII is either live on Solana mainnet or specified precisely enough to be built and checked against that specification. This Part departs from that convention deliberately: every claim in Sections 28 through 33 describes proposed architecture, none of it live, none of it committed to a deployment date, all of it conditional on the prerequisites in Section 32. This Part states plainly that the mechanism itself does not yet exist. It is included because the question motivating it, whether the catalyst fund can extend beyond a one-way grant into a mechanism that also connects verified projects to larger pools of investment capital, is a natural continuation of the theory of change in Section 5, and because naming a proposed extension explicitly is preferable to leaving it undocumented while informally shaping the protocol's direction. Readers interested only in what this protocol does today may skip to Appendix A without loss of continuity.

## 28. The Two-Stage Capital Model

### 28.1 Stage One: Catalyst Capital

Stage One is the mechanism already specified in Parts III through V, a continuously replenished fund disbursing milestone-verified grants to projects screened against Section 17.3's standards, restated here only to give Stage Two a fixed point to build from.

### 28.2 Stage Two: Aretia Project Finance

A project that has completed a full Stage One cycle would become eligible for project-finance underwriting against standard metrics: internal rate of return, net present value, debt-service coverage, and cash-flow projections under base, upside, and downside cases. A project clearing underwriting could then list on a proposed Aretia Project Marketplace, raising growth or construction capital through a project-specific vehicle, not through ACT. Stage One capital carries no expectation of financial return; Stage Two capital, by construction, does, priced and structured accordingly by the vehicle in Section 29. No project has reached this process to date, a status this Part treats as the specific, named prerequisite in Section 32 rather than a gap to gloss over.

## 29. Structural Separation Between ACT, the Project Participation Instrument, and the Underlying Project

The central design constraint on Stage Two is that ACT must not itself become a claim on any project's cash flows, which would function as an investment contract and alter ACT's legal position in ways Section 23 does not anticipate. The proposed structure separates three layers. ACT remains exactly what Sections 10 through 15 specify, a liquid, permissionlessly traded token whose transfer generates the fee in Section 14 and confers, under Section 30, tiered priority for visibility into Stage Two opportunities. A project participation instrument, legally distinct from ACT, would be created separately for each project reaching Stage Two, an SPV interest, fund unit, or structured note, whichever form a qualified securities counsel determines fits that project. The underlying project itself sits beneath that instrument. An investor's capital flows into the participation instrument, never into the ACT mint or treasury; no code path proposed in this Part routes investment capital through the token contract itself.

## 30. Tiered Access Through ACT Staking

Subject to the separation above, ACT staking is proposed as the mechanism determining a holder's visibility into, and priority for, Stage Two opportunities, not their financial return, which under Section 29 is governed entirely by the participation instrument. A holder who stakes or locks ACT would gain a higher tier of information and, at higher tiers, priority allocation and earlier notice. Staking amount and duration are proposed as inputs, on the reasoning that longer commitment represents a more durable form of participation; contribution or reputation within the ecosystem is named as a candidate third input left unspecified pending a concrete, non-discretionary way to measure it. This paper deliberately does not publish a weighted formula combining these inputs into a single access score, of the kind informally called a Capital Access Score during this design's development. Publishing specific weights ahead of real data to calibrate them against would present a precision the model does not yet possess; Section 32 states this as a prerequisite rather than a stylistic preference. Two properties hold regardless of how the formula is eventually specified. No tier confers investor eligibility: a holder's ability to actually commit capital remains governed by the securities law of that holder's own jurisdiction and the eligibility rules of that project's specific instrument, and staking expands what a holder can see, not whether they are legally permitted to invest. ACT's own marketed value must never be represented as a function of any gated project's financial performance; conflating the two would reintroduce, informally, the expectation-of-profit-from-others'-efforts structure Section 29's separation exists to avoid.

## 31. Related Work and Positioning Against Prior Art

No individual piece of this model is without precedent. Tiered staking that gates priority access to a separate offering is established in token-launch infrastructure, as with Polkastarter and DAO Maker.[^8] Special-purpose-vehicle-per-asset structures paired with independent underwriting and investor tranching are the operating model of Centrifuge's Tinlake platform.[^9] Crypto-denominated, project-linked investment in African renewable energy has already been attempted at meaningful scale by Sun Exchange, which subsequently shifted its own model from individual crowdfunding toward institutional funders, a data point this paper treats as a reason for caution about Stage Two's investor base rather than evidence against the model in principle.[^10] Verified-output marketplaces connecting a confirmed environmental result to a buyer are the operating model of Regen Network's marketplace for ecological credits. What this paper proposes as a combination, not as any one component, is a single protocol in which the early, unbankable stage of a project's life is financed non-discretionarily by the fee in Part IV, and graduation into an underwritten, separately instrumented opportunity is gated by participation in the same token that funded the earlier stage. This paper claims only that it has not, to the authors' knowledge, been assembled from these specific pieces in this specific sequence, with the same caution Section 20 applies elsewhere to competitive claims.

## 32. Prerequisites and Sequencing

This Part is a proposal, not a roadmap with a date attached, and states the specific conditions that would need to be true before any part of Stage Two begins to be built, in order. First, the protocol's operating entity must be actually and verifiably registered in whatever jurisdiction is ultimately selected, a condition distinct from, and presently unmet relative to, any statement elsewhere describing entity formation as complete; this document does not represent that condition as satisfied as of publication. Second, the liquidity pool referenced in Section 22 must be seeded and ACT actually trading. Third, at least one project must complete a full Stage One cycle as specified in Section 16, so the mechanism is demonstrated in practice and the catalytic leverage ratio in Section 9 can be measured at least once. Fourth, the independent program review named as outstanding in Sections 22 and 26 must be completed, since Stage Two involves materially larger sums. Fifth, a single project participation instrument must be structured completely with qualified securities counsel in every relevant jurisdiction, as a proof of structure rather than a template for immediate replication. Only once all five are met does this paper consider it appropriate to generalize the pattern into a scored marketplace or any automated version of the discovery-through-exit lifecycle this design's working materials describe informally. Building the scoring layer or the marketplace interface ahead of that sequence would produce a polished pipeline with no completed deals inside it, a failure mode named here so it can be checked against directly.

## 33. Legal Treatment of the Proposed Second Stage

Section 23's disclaimer applies here without qualification. A participation instrument structured to carry an expectation of return generated substantially by a developer's or this protocol's own efforts is likely to fall within securities regulation in most relevant jurisdictions, an outcome this paper anticipates rather than designs around; Section 32's fifth prerequisite exists so that structuring happens once, correctly, with qualified counsel, before it happens again. ACT staking under Section 30 is intended to be documented, from the point any part of this Part is built, as protocol access and participation, not as an investment or a security, consistent with Section 23's treatment of ACT itself. As with Section 23, this paper does not attempt a jurisdiction-specific classification of any future instrument, since none has been created and no jurisdiction selected; any party evaluating a real instrument created under this model should treat that instrument's own offering documents as authoritative, not this Part's description of the general model.

---

## Appendix A: On-Chain Reference Addresses

The following addresses are referenced throughout this paper by description rather than repeated inline.

| Reference | Address / Identifier |
|---|---|
| ACT mint address | `7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG` |
| Metaplex metadata account | `7YeVTArd3DZ7aMJs46ZYZDSZiY8seB6g9h2geL4UvW4f` |
| Token-2022 program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Treasury multisig (Squads) | `5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr` |
| Treasury vault | `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` |
| Management fee wallet | *To be confirmed; not yet addressed as part of this rebuild.* |

## Notes

[^1]: Corporate climate commitment growth and 2025 voluntary carbon credit retirement figures per the Science Based Targets initiative (SBTi), as reported in Carbon Direct, "Key Trends in the 2026 Voluntary Carbon Market" (2026).

[^2]: First-half 2026 voluntary carbon market issuance and retirement volumes per Sylvera, "Q2 2026 Carbon Data Snapshot," and Climate Focus, "Carbon Markets 2026 H1: Review and Outlook" (2026).

[^3]: A general, simplified account for readers unfamiliar with blockchain terminology, not a technical or legal definition.

[^4]: This paper does not name specific charitable or environmental tokens for comparison, since the point is structural rather than an evaluation of any named project's conduct.

[^5]: Solana permissionless-token category market capitalization and volume, and Solana decentralized-exchange 24-hour volume, as of mid-2026, per CoinGecko-sourced reporting.

[^6]: BNB Chain decentralized-exchange volume, and July 2026 volume and active-address growth for BNB Chain and Solana respectively, per CryptoRank.io, "Meme Coin Trading Lifts Solana Addresses 38%, BNB Chain Volume 45%" (2026).

[^7]: Ethereum-based permissionless-token market capitalizations and aggregate cross-chain category market capitalization, as of September 2026, per CoinGecko and CoinMarketCap-sourced reporting.

[^8]: Tiered stake-for-allocation mechanics as documented in Polkastarter's and DAO Maker's own public platform documentation.

[^9]: Centrifuge's Tinlake platform structure, including per-pool special-purpose vehicles and its two-tranche investor return model, per Centrifuge's own protocol documentation.

[^10]: Sun Exchange's peer-funded, bitcoin-payable solar cell financing model across Africa, including its Nhimbe Fresh project in Zimbabwe, and its subsequent shift toward institutional funders, per pv magazine, TechCrunch, CoinDesk, and ITWeb reporting on Sun Exchange between 2020 and 2024.

*The comparative trading-volume and market-capitalization figures in footnotes 5 through 7 are drawn from third-party market-data aggregators accessible at the time of writing, are subject to constant change, and have not been independently re-verified against primary on-chain data by this paper's authors.*

---

*This whitepaper is preliminary and subject to change. It does not constitute an offer or solicitation to buy or sell any security, token, or other financial instrument in any jurisdiction where such offer or solicitation would be unlawful. This protocol has not been registered under the securities laws of any jurisdiction. Prospective holders should conduct their own research and consult independent advisors before making any decision related to ACT.*
