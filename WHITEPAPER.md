# Aretia: A Protocol-Enforced Climate Catalyst Fund

`aretiafinance.org`

---

## Abstract

Climate finance suffers from a verification problem rather than a capital problem in the narrow sense. Pledges accelerate faster than verified action, and capital that does move often does so slowly, opaquely, and without proof that it accomplished what it claimed. At the same time, permissionless token trading across major blockchain networks generates enormous, continuous transaction volume with no purpose beyond the trade itself, a volume that exists independent of any climate objective and would exist whether or not this protocol did. This paper describes a protocol that converts a fixed share of ordinary token transfer activity into standing, continuously replenished capital, termed a climate catalyst fund, without requiring any party to trust a promise at any stage. The mechanism is enforced by the token's own transfer fee extension rather than by policy, meaning the property holds by construction rather than by the good conduct of any operator. Capital leaves the fund only against independently verified project milestones, with every step, from fee withholding through final disbursement, visible on a public ledger and independently reproducible by any observer with an internet connection. This paper presents the financing and liquidity landscape motivating the design, the logic of the catalyst fund, the token protocol and its arithmetic, the project-selection and governance architecture, an economic and social analysis of the mechanism, and the impact-documentation framework applied to funded work. The result is not a pledge and not a one-time grant, but a self-replenishing source of catalytic capital engineered to keep operating whether or not anyone continues to advocate for it.

---

## Part I. The Financing Challenge for Climate Mitigation and Adaptation Projects

## 1. The Verification Problem in Climate Finance

Trust in climate finance breaks down at a specific and identifiable point: the gap between a pledge and its verification. Corporate climate commitments (measured as the number of companies setting near-term and net-zero targets) rose approximately 227 percent in the eighteen months leading up to mid-2025, a figure that on its own would suggest the field is accelerating.[1] Yet voluntary carbon credit retirements, the step in the lifecycle of a credit that proves it was actually used rather than purchased and left unclaimed, fell 7 percent over the same period.[1] Commitment outpaced proof through 2025, and the divergence between the two figures is itself the diagnostic.

More recent data suggests this gap is beginning to close, though from the supply side rather than the demand side. In the first half of 2026, voluntary carbon credit retirements reached approximately 98 million credits, while new issuances totaled approximately 96.8 million, a 31.9 percent decline from the 142.3 million issued in the first half of 2025.[2] Retirement volume held comparatively steady while issuance contracted sharply, bringing supply and demand into closer balance than in prior years. This is a healthier ratio, but it says nothing about whether verification itself has become more reliable, only that fewer new claims are being made against which verification could fail. The underlying structural weakness (that verification, where it occurs at all, happens after the fact and is frequently conducted by a party with an interest in a favorable outcome) has not been resolved by a smaller market; it has simply been tested against fewer transactions.

The mechanisms conventionally available to close the verification gap (grant programs, offset purchases, and corporate pledges among them) share a common structural weakness: each depends on a promise being honored after the money or the stated intent has already moved. A grantor rarely audits its own grantee with the same rigor an adversary would apply. A corporation announcing a pledge has every reason to publicize the announcement and comparatively little operational incentive to publicize a shortfall against it years later.

A second, related problem sits alongside the verification gap: a financing problem specifically affecting projects that have already been technically proven. A pilot project or a proven technology deployed at small scale frequently cannot secure capital to scale, not because the underlying science or engineering is in doubt, but because conventional financing pathways are built around large, discrete rounds that do not suit incremental, milestone-based scaling. A catalyst fund, capitalized continuously rather than through periodic fundraising cycles, is structurally better suited to this kind of incremental financing need than either a one-time grant or a commercial loan sized for a single large disbursement.

This is not a claim that actors in climate finance are acting in bad faith as a rule. It is a claim about incentive structure. Any system in which verification is optional, delayed, and self-administered will tend, in aggregate and over time, toward the outcome the data already shows: commitments that outpace proof. The correction implied by this diagnosis is not moral exhortation but mechanism design. If verification cannot be reliably supplied by voluntary conduct, it must be supplied by structure.

## 2. Why Existing Approaches Fall Short

A mechanism paper is incomplete if it does not explain what it is not. This section situates the proposed protocol against four existing categories of approach, each of which addresses part of the verification problem described in Section 1 but not, this paper argues, the whole of it.

### 2.1 Voluntary Carbon Markets and the Retirement Gap

The voluntary carbon market provides a registry-based mechanism for quantifying and transacting emissions reductions, and established registries such as Verra and Gold Standard supply real methodological rigor to the question of whether a given reduction occurred. The market's weakness is not measurement but follow-through: a credit can be purchased and never retired, sitting in an account as a purchased-but-unused asset that satisfies a buyer's internal accounting without ever completing the act (retirement) that actually proves use. The retirement gap described in Section 1 is precisely this failure mode expressed as a statistic. This protocol does not replace carbon credit registries; Section 16 explicitly treats registry-issued credits as one valid form of verified output. What it adds is a disbursement mechanism, described in Section 15, that does not depend on a purchaser's subsequent discretion to complete a retirement step, since a milestone-verified grant is itself structured around confirmed completion rather than confirmed purchase.

### 2.2 Traditional Grant-Based Climate Philanthropy

Grant-based philanthropy, whether from private foundations, corporate social responsibility budgets, or bilateral development finance, typically disburses in large tranches against a proposal and a narrative report, with verification, if it occurs at all, taking place through a final report authored substantially by the grantee itself. This is not a claim that grant-based philanthropy is ineffective; considerable expert judgment goes into grant selection, and program officers frequently possess deep domain expertise. The structural weakness is narrower: verification and disbursement are not architecturally coupled. A grant can be fully disbursed before the deliverable is confirmed, and the confirmation, when it occurs, is rarely independent of the party being evaluated. Section 15 of this paper describes a disbursement process in which that coupling is structural rather than aspirational: a tranche is an instruction that will not execute until an independent verification event has already occurred on-chain.

### 2.3 Blended and Catalytic Finance

The term catalytic capital, which this paper adopts and extends in Part III, originates in blended finance practice, where it denotes capital placed specifically to unlock or de-risk activity that would not otherwise be financed on commercially reasonable terms, functioning as a first mover that makes a project bankable rather than as the entire bankroll for it. Existing catalytic capital vehicles are almost universally capitalized through discrete fundraising events: a foundation commits a sum, a development finance institution allocates a facility, and that sum, once deployed, requires a fresh fundraising cycle to replenish. The contribution proposed here is narrow but meaningful: it asks whether a catalytic capital vehicle can be capitalized continuously, as a structural property of an unrelated economic activity, rather than periodically, as the product of a fundraising campaign. Section 5 makes this precise.

### 2.4 Token-Based Fundraising Without Enforcement

A number of existing tokens describe themselves as supporting a charitable or environmental cause, typically through a stated intention that some share of trading fees or treasury holdings will be donated to a cause at the team's discretion. Before continuing, it is worth pausing on what a token actually is, since the term is used throughout this paper and is not universal knowledge outside blockchain contexts. A token, in this context, is a digital record of ownership maintained on a public, shared ledger called a blockchain, transferable between parties without requiring a bank, broker, or other intermediary to process the transfer. A given token's rules (how many units exist, how transfers are processed, what happens automatically at the moment of transfer) are defined in software that runs on the blockchain itself, commonly called a smart contract or, on the Solana network specifically, a program.[3]

The distinguishing weakness of the charitable-token category, relative to the protocol proposed here, is that the donation commitment is a policy rather than a property of that underlying code. A team that states an intention to donate a share of proceeds can, without violating any smart contract, simply not do so, and an external observer has no mechanism by which to detect the omission other than the team's own subsequent disclosure. Sections 9 through 14 of this paper specify a token whose fee mechanism is a property of the mint's own on-chain configuration, verifiable by any party without trusting the issuing party's representation of it, a distinction this paper treats as load-bearing rather than cosmetic. Several existing environmental or charitable tokens illustrate the pattern: a project publicizes an intended percentage donation at launch, but does not implement that percentage as an enforced, on-chain transfer-fee rule, leaving compliance unverifiable after the fact.[4]

---

## Part II. Liquidity Availability through Emerging Financial Instruments and Digital Assets

## 3. Permissionless Trading as an Untapped Capital Source

Separately from the climate finance question, permissionless token trading across major blockchain networks moves substantial real capital every day, for reasons entirely unrelated to climate objectives. This activity is not confined to any single network. On Solana, the category of permissionless, community-driven tokens reached a combined market capitalization of roughly $40 billion with daily trading volume near $4 billion as of mid-2026, and Solana decentralized-exchange volume alone reached approximately $3.01 billion across a single 24-hour window.[5] BNB Chain processed a comparable $1.25 billion in decentralized-exchange volume over the same kind of window, with a July 2026 surge lifting BNB Chain trading volume by 45 percent and Solana on-chain activity by 38 percent, to roughly 31.4 million active addresses.[6] On Ethereum, individual permissionless tokens in this category carry market capitalizations in the low billions of dollars (Shiba Inu at approximately $2.5 billion and Pepe at approximately $1.19 billion, as two illustrative examples) within a combined cross-chain category exceeding $30 billion in aggregate market capitalization as of September 2026.[7]

This volume is not raised, solicited, or persuaded into existence on any of these networks. It is a byproduct of ordinary, permission-free markets functioning exactly as they are designed to function, and it would continue to exist in the complete absence of any climate-linked project, exactly as it did before one existed.

The observation at the center of this paper is that three facts (a verification problem in climate finance, a financing gap affecting already-proven projects, and an untapped, purpose-agnostic capital flow moving through permissionless digital-asset markets) can be connected mechanically rather than rhetorically. A protocol-level fee, enforced the same way a native transfer-fee extension is enforced on a supporting network (automatically, on every transfer, by the token standard itself rather than by the discretion of any operator), can convert a fixed share of trading activity that already exists into climate capital that does not depend on anyone continuing to believe in, advocate for, or even be aware of the underlying mission. The mechanism does not ask traders to care. It only asks the token standard to do arithmetic, which it does regardless of anyone's sentiment. Section 18 returns to why Solana specifically was selected as the network on which to implement this mechanism.

## 4. Contributions and Organization of This Paper

This paper makes the following contributions. First, it defines the climate catalyst fund as a specific structural object, distinguished from an ordinary treasury or grant pool by two properties (continuous replenishment and non-discretionary capitalization) and situates that definition within the existing vocabulary of blended and catalytic climate finance. Second, it specifies the token protocol and transfer fee mechanism in full, including the arithmetic of fee allocation and the gross-up computation required to deliver a net amount through a fee-bearing internal transfer, a detail this paper has not seen treated explicitly elsewhere. Third, it specifies a milestone-verified disbursement process and a category-specific diligence framework applied before any project reaches that process. Fourth, it presents a four-layer governance architecture designed to avoid the specific failure mode of flat, one-holder-one-vote systems once a treasury is large enough to be worth attacking. Fifth, it offers a comparative economic and social analysis against network alternatives and against existing approaches to climate finance more broadly, on the grounds that a mechanism paper that does not explain why the alternatives were rejected has not fully explained its own design.

The remainder of this paper is organized into five further parts. Part III defines the catalyst fund formally. Part IV specifies the token protocol: its design, its transfer-fee mechanism, and treasury custody. Part V specifies project selection, diligence, and governance. Part VI offers an economic and social analysis, including network selection and a discussion of who the diligence framework is designed to serve. Part VII addresses transparency, impact documentation, and illustrative arithmetic under several volume scenarios, followed by a conclusion and an appendix of on-chain reference addresses.

---

## Part III. The Logic of the Catalyst Fund

## 5. Definition and Structural Properties

The catalyst fund is defined as the central object of this system: a treasury-held pool of capital that is, first, capitalized continuously by protocol-enforced transfer fees rather than by periodic fundraising; second, held under multi-party custody rather than any single controller; and third, disbursed only against independently verified project milestones rather than at the discretion of any one party. Each of these three properties is structural, meaning it is guaranteed by the design of the system rather than by the conduct of any party operating within it, a distinction elaborated further in Section 19.

## 6. Continuous Replenishment

Let F(t) denote the fund balance at time t. Then:

    F(t) = F(0) + Σ [0.02 × Vᵢ]   for every harvested transfer i occurring in (0, t]

where Vᵢ is the value of transfer i. F(t) is non-decreasing in trading activity and requires no discrete fundraising event to increase. This is the property that distinguishes a catalyst fund, as the term is used here, from an ordinary grant pool of the kind discussed in Sections 2.2 and 2.3. A grant pool's balance is a step function, flat between fundraising events and discontinuous at them. F(t) is instead a running sum over an activity, trading, that occurs continuously and independently of the fund's own fundraising calendar, because it has none.

## 7. Non-Discretionary Capitalization

No signer, founder, or committee decides whether a given transfer contributes to F(t). The transfer fee extension computes and withholds the fee at the protocol level, and there is no code path in which a transfer completes without it. This property matters independently of the replenishment property described above. A fund could in principle be replenished continuously by a party who nonetheless retained discretion over whether to honor that replenishment on any given day, and such a fund would not possess the property described here. Non-discretionary capitalization means the choice has already been made, once, at the level of the mint's configuration, and cannot be revisited transaction by transaction.

## 8. Relationship to Catalytic Capital in Blended Finance Theory

As noted in Section 2.3, the term catalytic capital is drawn from blended finance practice, where it denotes capital deployed specifically to de-risk or unlock activity that would not otherwise clear commercial financing thresholds. This protocol's catalyst fund occupies that same functional position within its own system, seeding and de-risking climate mitigation and adaptation work in verified tranches, described fully in Section 15, rather than functioning as a passive reserve awaiting a single large disbursement or as a lump-sum grant pool of the kind described in Section 2.2. The extension this paper proposes to that existing vocabulary is the substitution of a continuous, code-enforced capitalization process for the periodic, discretion-dependent capitalization process that characterizes catalytic capital vehicles as they are presently constituted.

---

## Part IV. The Token Protocol

The preceding parts describe why this mechanism exists and what problem it solves. This part turns to how it is actually implemented: the token itself, the fee it carries, and the custody arrangement that holds what the fee collects. Readers primarily interested in the motivation and governance of the protocol, rather than its technical construction, may proceed directly to Part V without loss of continuity.

## 9. Token Design Overview

A token's design, in the sense used here, refers to the specific, fixed set of parameters chosen at the moment a token is created: how many units will ever exist, who if anyone retains the authority to change that later, and what if anything is automatically deducted from every transfer. These choices are made once, recorded permanently on the blockchain's own ledger, and are independently checkable by anyone, without needing to trust a description of them written by the party that created the token. The remainder of this Part specifies those choices for ACT, the asset native to this protocol, followed by the fee mechanism the token carries and the custody arrangement governing where a withheld fee ultimately settles.

## 10. Supply and Authority Structure

ACT is issued as a Solana SPL Token-2022 asset with the following fixed parameters.

| Parameter | Value |
|---|---|
| Total supply | 100,000,000, fixed |
| Decimals | 9 |
| Mint authority | Revoked |
| Freeze authority | Never granted |

Supply is fixed by construction rather than by policy. "Mint authority" refers to the on-chain permission required to create additional units of a token after its initial creation; a token whose mint authority is intact can, in principle, have its supply increased at any time by whoever holds that authority. Here, mint authority was permanently revoked immediately following the single initial mint, which deposited the full supply into the treasury vault's associated token account, meaning the ability to create additional ACT was destroyed, not merely declined to be used, and cannot be reinstated by any party. No wallet, including the treasury's own, has held newly created ACT outside that initial mint. "Freeze authority," similarly, is the on-chain permission required to lock a specific holder's token account so it cannot send or receive further transfers; no such authority was ever granted for ACT, meaning no account holding ACT can be frozen by any party, including this protocol's own operating entity. On-chain addresses for the mint and the accounts referenced throughout this Part are collected in Appendix A, rather than repeated inline.

## 11. Immutability as a Design Choice, and Its Costs

The irrevocability described above is a deliberate tradeoff rather than a costless guarantee. Revoking mint authority forecloses, permanently, any future ability to attach on-chain identifying metadata (a name, symbol, or logo) to the mint, since the standard mechanisms for doing so each require an authority this mint no longer possesses. The practical consequence is that ACT displays without a name, symbol, or logo in wallets and block explorers. This is treated here as an honest cost of the commitment device rather than an oversight: because the token's own identity cannot be made self-evident on-chain, the mitigation adopted is to make independent verification of its actual, real properties as easy as possible for anyone who encounters it; a tool for doing exactly that is described in Section 21.3.

## 12. Market Access and Permissionless Trading

ACT trades on the open market against USDT, with no permission requirement and no gatekeeping of any kind. Any Solana wallet or exchange capable of handling a standard Token-2022 asset can transact it without integrating any protocol-specific logic, a property inherited directly from the token standard rather than engineered specifically for this project.

## 13. The Transfer-Fee Mechanism

### 13.1 The Withholding Function

Token-2022's native transfer fee extension withholds a percentage of every transfer at the protocol level, before the recipient's balance is credited, up to a configured maximum absolute amount so that a single very large transfer does not withhold an unbounded sum. The fee rate is 350 basis points, or 3.5 percent of the transfer amount.

### 13.2 Fee Allocation

The withheld fee divides as follows: 96.5 percent of every transfer reaches the recipient net of the fee; of the 3.5 percent withheld, 2.0 percentage points (approximately 57.1 percent of the withheld amount) fund the catalyst fund, 1.0 percentage point (approximately 28.6 percent of the withheld amount) funds liquidity, and 0.5 percentage points (approximately 14.3 percent of the withheld amount) fund protocol management. The aggregate withheld rate is the property enforced by the mint's on-chain configuration, the distinction this paper draws in Section 2.4 against tokens whose charitable commitments are policy rather than code. The destination split above is the treasury's own harvest-and-route procedure, applied consistently every time withheld fees are harvested, but is not itself a second on-chain-enforced ratio; Section 14 discusses the custody arrangement under which that procedure is carried out.

### 13.3 The Two-Phase Withhold-and-Harvest Design

A withheld amount does not move to its destination automatically at transfer time. Instead, the mechanism operates in two phases. In the first phase, at the moment of every transfer, the withheld amount accumulates inside the recipient's own token account as a running balance, publicly readable by any observer. In the second phase, an authorized party periodically executes a separate "harvest" instruction that sweeps accumulated withheld amounts, across every account where they have built up, into the treasury. This two-phase design (withhold locally at the moment of transfer, then harvest periodically in a separate step) is what allows every wallet, exchange, and routing aggregator already supporting Token-2022 to handle ACT correctly with no protocol-specific integration whatsoever. The complexity of routing the fee to its final destination is confined entirely to the harvest step, which only the treasury multisig executes (that is, which only takes effect once a sufficient number of the treasury's independent, designated signers have separately approved it, per the custody model described in Section 14) rather than being distributed across every individual transfer.

### 13.4 Management-Fee Delivery and the Gross-Up Problem

The management fee wallet is held separately from the treasury multisig (see Appendix A for its address), so that operational compensation to the protocol's operating entity can never be commingled with catalyst fund capital structurally, rather than merely by reporting convention. Delivering that compensation requires a second transfer, from the treasury vault to the management wallet, and that second transfer itself incurs the same withholding described in Section 13.1, since the fee applies to every transfer of the token without exception. To land a net amount N in the management wallet after that second transfer's own fee is deducted, the treasury must send a gross amount G satisfying:

    G − fee(G) = N
    G × (1 − b) = N     [when fee(G) < M]
    G = N / (1 − b) = N / 0.965

where b is the fee rate defined in Section 13.1 and M is the mint's configured maximum fee. For example, to deliver a net N of 1,000 ACT to the management wallet, the treasury must send a gross G of 1,000 divided by 0.965, approximately 1,036.27 ACT, of which approximately 36.27 ACT is withheld on that second transfer and re-enters the fee-split pool described in Section 13.2. This recursive fee-on-internal-transfer problem does not appear to have been treated explicitly in prior public documentation of comparable mechanisms, and is included here because a treasury operator who failed to account for it would systematically underdeliver the intended management compensation on every occasion the calculation was performed.

## 14. Treasury Custody

### 14.1 Multisignature Custody Model

Harvested fees settle into a Solana multisig, using the Squads protocol, live on mainnet (see Appendix A for its address). The multisig defines a signer set of three designated parties and a threshold of two: a transaction executes only once at least two of the three have independently approved it. No single key, including any key held by this protocol's operating entity or by any individual associated with it, can move catalyst fund capital unilaterally.

### 14.2 Threshold Selection: Why Two of Three

A threshold of two of three was selected as the smallest configuration that eliminates unilateral control while remaining operationally practical for an entity of this size. A larger signer set with a proportionally larger threshold would reduce the marginal influence of any single compromised or unavailable signer further, at the cost of requiring coordination among a larger group for every routine transaction. Two of three is treated here as an appropriate starting point given the treasury's current scale; Section 17's governance architecture provides the mechanism by which this parameter, like others, could be revisited as the system matures.

### 14.3 Operational Verification

The propose, review, approve, and execute cycle has been tested end to end with a real transaction on mainnet, approved independently by two of the three signers, rather than verified only in principle. The distinction between a custody model that has been exercised and one that has merely been configured is treated here as material enough to state explicitly.

---

## Part V. Project Selection and Governance

## 15. Milestone-Verified Disbursement

### 15.1 Forms of Disbursement

Capital leaves the catalyst fund primarily as a grant to a vetted climate project partner not itself tokenized, such as a reforestation cooperative or a community solar developer. A second form (an on-chain retirement of tokenized carbon credits sourced from an established registry, which would produce a quantified tonnes-of-carbon-dioxide-equivalent figure tied to a specific transaction hash) is not implemented in the current design and is not available as a disbursement path today. It is recorded here as a form the protocol may adopt in the future, should tokenized-credit infrastructure and registry practice develop to a point that makes it a workable second approach, rather than as a mechanism presently in use alongside direct project grants.

### 15.2 Tranche Structure and the Sequencing Problem

Disbursement does not release as a single lump sum against an initial approval. An approved project's total commitment is instead divided into a series of tranches, with each tranche releasing only after independent verification confirms that the preceding milestone was actually met. This sequencing is the structural mechanism that prevents the statement "the fund financed a project" from silently coming to mean, in a given instance, "the fund sent money to a project that subsequently failed to complete its work," a failure mode this paper argued in Section 2.2 is endemic to disbursement processes in which verification and payment are not architecturally coupled.

### 15.3 On-Chain Auditability of Disbursements

Every disbursement is a public on-chain transaction originating from the known treasury address (see Appendix A). No disbursement is representable, to any observer, as anything other than what the underlying chain state shows it to be, a property that holds regardless of what any party subsequently claims about it. The criteria used to determine which projects reach this disbursement process in the first place are given in Section 16.

## 16. Project Selection and Diligence

### 16.1 Category Taxonomy

The catalyst fund finances five categories of climate work: renewable energy, waste-to-energy management, carbon reduction, technical assistance, and flood management and reforestation. Each category admits a structurally different kind of verifiable claim, and each is accordingly held to a diligence standard appropriate to that specific claim, applied by the technical committee described in Section 17 before a project is admitted to the funding slate.

### 16.2 Category-Specific Diligence Standards

| Category | Verified output | Diligence standard |
|---|---|---|
| Renewable energy | Metered generation capacity added | Independent engineering certification of installed and operating capacity; interconnection or off-take documentation |
| Waste-to-energy management | Waste diverted and energy generated | Facility operating permits, throughput metering, emissions monitored against a stated baseline |
| Carbon reduction | Emissions avoided or removed | Registry-issued credits, from Verra, Gold Standard, or a comparable standard, or an equivalent third-party MRV protocol |
| Technical assistance | Capacity delivered: studies, training, MRV systems built | Deliverable-based milestones; independent review of the technical work product itself, since there is no physical asset to inspect |
| Flood management and reforestation | Hectares restored; flood-risk reduction achieved | Remote-sensing canopy verification for reforestation; hydrological modeling or post-event impact assessment for flood management |

### 16.3 The Special Case of Technical Assistance

Technical assistance differs from the other four categories in kind rather than merely in degree. Where renewable energy, waste-to-energy, carbon reduction, and flood management and reforestation projects each produce a physical or registry-verifiable output that exists independently of any narrative account of it, technical assistance instead funds the capacity that makes a future project bankable in the first place: a feasibility study, an MRV system a smaller developer could not otherwise afford to build on its own, or training delivered to a local partner's own monitoring staff. Its diligence standard is accordingly oriented around the work product actually delivered against a defined scope of engagement, rather than a physical inspection of an asset in the field, since in this category no such asset yet exists to inspect.

### 16.4 Portfolio Weighting as a Governance Parameter

A project's category determines which diligence standard from Section 16.2 applies to it. It does not alter the milestone-verified release mechanism defined in Section 15, which governs every category identically regardless of the nature of the underlying claim. The relative weighting of categories within the overall portfolio is a Layer 1 governance parameter under Section 17, revised through the same procedure that sets any other funding priority, and is accordingly not fixed by this document.

## 17. Governance

### 17.1 The Failure Mode of Flat Token-Holder Voting

A flat, one-holder-one-vote system governing individual disbursements fails once a treasury is large enough to be worth attacking, because a well-organized proposal can extract funds from a naively administered vote regardless of that vote's formal legitimacy. This is not a hypothetical concern specific to this protocol; it is a general property of governance systems in which the entire decision authority over a valuable resource is concentrated in a single voting mechanism with no independent check on the substance of what is being voted upon.

### 17.2 A Four-Layer Architecture

Governance under this protocol is layered instead of flat, across four distinct functions. The first layer is community governance, exercised by token holders through Realms, which sets funding priorities, project categories, and treasury allocation weights, but does not vote on individual disbursements. The second layer is a technical committee, which screens individual project applications for climate-science credibility, MRV soundness, and financial feasibility before a project can be admitted to the process described in Section 15. The third layer is independent verification, which confirms, at each milestone, that a party independent of both the protocol's own team and the project developer has verified the claimed progress actually occurred. The fourth layer is smart-contract execution, which releases funds only once the second and third layers have both signed off on a given milestone, with no human discretion exercised at the point of transfer itself.

### 17.3 Phased Activation

Governance is phased in against real participation rather than switched on in full at launch. Layer 1 activates once the holder base is large enough for a vote to carry genuine information content rather than being symbolic in practice. Layers 2 through 4 build out across subsequent phases of the protocol's roadmap. Until Layer 1 is live, the treasury operates on team-curated grants under the identical milestone-verification discipline described in Section 15, meaning the sequencing guarantee described there does not depend on governance being fully activated to hold.

### 17.4 Comparison to Single-Signer and DAO-Only Models

It is worth situating this architecture against the two more common alternatives. A single-signer model, in which one founder or entity retains full discretion over disbursements, offers speed and simplicity at the cost of the exact non-discretionary property this paper has emphasized throughout; it is a system whose good behavior depends entirely on the continued good faith of one party. A DAO-only model, in which token holders vote directly on every disbursement with no intervening technical or verification layer, addresses the concentration-of-discretion problem but reintroduces the failure mode described in Section 17.1: a majority or a well-coordinated plurality of token holders can, in principle, vote to disburse the treasury to itself. The four-layer architecture described in Section 17.2 is designed to occupy neither extreme, distributing discretion across community priority-setting, technical screening, independent verification, and mechanical execution such that no single layer, including a hypothetical majority of token holders, can unilaterally move funds.

---

## Part VI. Economic and Social Analysis

## 18. Network Selection

### 18.1 Requirements for the Underlying Ledger

The mechanism described in this paper requires a ledger with three properties: transaction costs low enough that routine harvest and disbursement operations remain economical at the scale this treasury is likely to operate at; a native, protocol-level fee-on-transfer primitive, so that the withholding described in Section 13.1 is a property of the token standard rather than of custom program logic that would otherwise need to be written and maintained; and sufficient liquidity in USDT or an equivalent stable asset to support the trading pair described in Section 12.

### 18.2 Comparative Analysis

| Network | Fee per transfer | Native fee-on-transfer support | USDT liquidity |
|---|---|---|---|
| Solana | approximately $0.0003 | Yes, via the Token-2022 extension | Native SPL USDT, deep on Raydium and Orca |
| Base | approximately $0.01 to $0.05 | No, requires custom contract logic | Bridged USDT |
| BNB Chain | approximately $0.10 to $0.30 | No, requires custom contract logic | Deep, but with more centralized custody risk |
| Ethereum L1 | $2 to $30 or more | No, requires custom contract logic | Deepest overall, but expensive to disburse from frequently |

### 18.3 The Cost of Bespoke Fee Logic

The deciding factor in Section 18.2 is the third column, native fee-on-transfer support, rather than the first. On every chain lacking a native primitive of this kind, the withholding and routing mechanism specified in Part IV would have to be implemented as bespoke program logic written and maintained specifically for this project, introducing an additional attack surface with its own potential defects, one that would need to be reviewed separately from, and in addition to, the underlying token standard itself. Token-2022's transfer fee extension is instead a property of shared infrastructure that every Solana wallet, exchange, and routing aggregator already implements correctly, having been built once and used by the entire ecosystem rather than once per project. Building the equivalent mechanism on a chain without this primitive would mean asking every counterparty to trust this protocol's own custom code for a function the token standard otherwise guarantees at the infrastructure level.

## 19. Economic Analysis

### 19.1 Fee Incidence and Trading Behavior

A transfer fee of 350 basis points is a real cost borne by anyone transacting the token, and it is fair to ask whether a fee of this magnitude meaningfully deters the trading activity the mechanism depends upon in the first place. Two considerations are relevant to this question without resolving it empirically, since no trading history yet exists to measure against. First, transfer fees in this general range are not unusual among comparable Solana Token-2022 assets that have achieved meaningful trading volume, suggesting the fee alone is not prohibitive at this scale. Second, and more specific to this design, the fee is fixed and fully disclosed prior to any transaction, which distinguishes it from slippage or price impact, both of which vary with trade size and pool depth and are frequently larger in absolute terms for a given trade than the fee itself. A rational trader prices the fee into their decision the same way they price any other known, fixed transaction cost.

### 19.2 Credible Commitment Through Mechanism Design

The distinction drawn in Section 2.4, between a policy commitment and a code-enforced property, has a formal name in economics: the difference between cheap talk and a credible commitment device. A statement of intent that the issuer could costlessly reverse without technical consequence is cheap talk, regardless of the sincerity with which it is made. A property enforced by an immutable, permissionless token standard, verifiable by any party without trusting the issuer's account of it, is a credible commitment in the technical sense: the cost of reneging is not merely reputational but architectural, since reneging would require rewriting a mint configuration that no longer has an authority capable of rewriting it. Sections 10 and 11 describe the specific mechanism, permanent revocation of mint authority, by which this commitment is made costly to break, and the cost that this same irrevocability imposes elsewhere.

### 19.3 Liquidity Provision Incentives and Impermanent Loss

A separate incentive question concerns the party or parties who eventually supply the other side of the ACT-USDT trading pair described in Section 12, since a liquidity provider to an automated market maker pool bears a distinct risk, commonly termed impermanent loss, in which a divergence between the pool's two assets can leave a liquidity position worth less, in dollar terms, than simply holding the two assets separately outside the pool. This risk is a standard, well-documented property of automated market making rather than a feature specific to this token. It is noted here because an economic analysis of the fee mechanism that omitted the liquidity side of the market would be incomplete: the catalyst fund's continuous replenishment, described in Section 6, depends on trading volume, and trading volume depends on liquidity existing in the first place, which in turn depends on some party accepting impermanent loss risk in exchange for a share of trading fees.

## 20. Social Dimensions of Project Selection

An economic analysis of this mechanism is incomplete without a corresponding account of who it is designed to reach. The five-category taxonomy in Section 16.1 was chosen deliberately to include technical assistance, described in Section 16.3, precisely because that category serves a population conventional project financing tends to overlook: developers with a credible technical approach but insufficient resources to produce the feasibility studies, MRV systems, or training infrastructure that would make a subsequent capital request bankable elsewhere. A diligence framework calibrated only to well-resourced applicants (one requiring extensive documentation, formal certifications, and administrative capacity as a precondition of consideration) would systematically exclude exactly the applicants a catalyst fund of this kind is best positioned to serve. The category-specific diligence standards in Section 16.2 are accordingly scoped to what each category can actually produce as evidence, rather than to a single uniform documentation burden applied regardless of an applicant's size or resources. This is stated as a design intention rather than a guarantee; whether the diligence process in practice remains accessible to smaller and less-resourced developers, as opposed to only the applicants most able to navigate a formal review process, is a question this paper does not consider settled and returns to as an open item for future evaluation.

---

## Part VII. Impact Documentation and Management

## 21. Transparency and Independent Verifiability

### 21.1 On-Chain Verifiability of Every Claim

Every factual claim this document depends upon is independently verifiable by any party, without requiring that party to trust this protocol's own representation of it. The mint's fixed supply and revoked authorities, described in Section 10, are on-chain state. The transfer fee configuration described in Section 13.2 is on-chain state. The treasury's multisig threshold and signer set described in Section 14.1 are on-chain state. Every disbursement described in Section 15.3 is a discrete, permanent transaction originating from a known address. In each case, the claim in this document is a description of chain state that already exists, not an assertion this document is itself responsible for making true.

### 21.2 The Transparency Dashboard

A public transparency dashboard, currently in development and not yet live, is intended to index this activity as a running ledger (inflow, disbursement, recipient, and running total), presented continuously rather than as a periodic report published when convenient for the operator. It is not yet complete; it is noted here only to distinguish it from the mechanism already described in Section 21.3, which is complete and live today.

### 21.3 Client-Side Self-Verification

In addition to the dashboard described above, a client-side verification tool has already been deployed at this protocol's public website. This tool queries Solana mainnet directly from the visitor's own browser, with no intervening server in the request path at any point, and independently recomputes each of the claims made in Sections 10 and 13.2 (namely the mint's authorities, its supply and decimal configuration, the transfer fee rate, the fee authorities, and the treasury's token balance), displaying the live, on-chain result beside the documented claim for direct comparison. The tool's own source is visible in the page from which it runs, so that a skeptical visitor is not asked to trust the verification tool either. This is treated here as a partial but genuine answer to the immutability cost described in Section 11: because the token cannot display a verified identity on-chain, the mitigation instead makes the underlying facts trivially checkable by anyone who arrives skeptical of them.

## 22. Illustrative Calculation

The mechanism's output is arithmetic, not a forecast, and this section presents that arithmetic under several illustrative volumes chosen for round numbers rather than as a projection of what volume will actually occur. For any aggregate ACT transfer volume V occurring between harvests, and before the maximum-fee cap described in Section 13.1 applies to any individual transfer within that volume, the following table applies the fee-split proportions from Section 13.2 at three illustrative scales.

| Aggregate volume V | Catalyst fund (2.0%) | Liquidity (1.0%) | Management fee (0.5%) |
|---|---|---|---|
| $10,000 | $200 | $100 | $50 |
| $100,000 | $2,000 | $1,000 | $500 |
| $1,000,000 | $20,000 | $10,000 | $5,000 |

No step in this computation depends on price, sentiment, or continued attention to the protocol's mission. It is a fixed function of transfer volume, computed identically whether that volume reflects one large trade or ten thousand small ones. This document makes no representation about which, if any, of the three rows above will resemble actual future volume. Actual accrual to the catalyst fund is a direct, mechanical function of real trading volume, which is presently unknown and is not forecast anywhere in this paper.

---

## 23. Conclusion

This paper has described a mechanism that converts a fixed, protocol-enforced share of ordinary token-transfer activity into standing capital for climate mitigation and adaptation work, a catalyst fund that requires no renewed pledge to keep functioning, no trust in any single party's discretion to keep it honest, and no step, from fee withholding through milestone-verified disbursement, that cannot be independently checked against the public ledger by any party willing to do so. The mechanism, as distinct from its eventual scale, is live: ACT is deployed on Solana mainnet with its supply fixed and mint authority revoked, and the treasury multisig operates under tested, exercised, multi-party custody rather than merely configured custody. What remains is scale: real trading volume, a seeded liquidity pool, an independent program review, a live transparency dashboard, and a first slate of verified project partners. None of these remaining items requires trusting a new promise to complete; each is a specific, named piece of work whose completion will itself be as verifiable, once done, as everything described in the sections above already is.

---

## Appendix A: On-Chain Reference Addresses

The following on-chain addresses are referenced throughout this paper by description rather than repeated inline; they are collected here for readers who wish to verify any claim directly against the Solana ledger.

| Reference | Address / Identifier |
|---|---|
| ACT mint address | `BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT` |
| Token-2022 program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Treasury multisig (Squads) | `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg` |
| Management fee wallet | `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2` |

## Notes

[1] Corporate climate commitment growth and 2025 voluntary carbon credit retirement figures per the Science Based Targets initiative (SBTi), as reported in Carbon Direct, "Key Trends in the 2026 Voluntary Carbon Market" (2026).

[2] First-half 2026 voluntary carbon market issuance and retirement volumes per Sylvera, "Q2 2026 Carbon Data Snapshot," and Climate Focus, "Carbon Markets 2026 H1: Review and Outlook" (2026).

[3] This description of tokens and smart contracts is a general, simplified account for readers unfamiliar with blockchain terminology and is not intended as a technical or legal definition.

[4] This paper does not name specific charitable or environmental tokens for comparison, since the point made is structural (policy versus code-enforced commitment) rather than an evaluation of any named project's conduct; a reader interested in specific examples can find them by searching for tokens self-described as "cause-linked" or "green" cryptocurrencies.

[5] Solana permissionless-token category market capitalization and daily volume, and Solana decentralized-exchange 24-hour volume, as of mid-2026, per CoinGecko-sourced reporting.

[6] BNB Chain decentralized-exchange volume, and July 2026 trading-volume and active-address growth figures for BNB Chain and Solana respectively, per CryptoRank.io, "Meme Coin Trading Lifts Solana Addresses 38%, BNB Chain Volume 45%" (2026).

[7] Ethereum-based permissionless-token market capitalizations (Shiba Inu, Pepe) and aggregate cross-chain category market capitalization, as of September 2026, per CoinGecko and CoinMarketCap-sourced reporting.

*The comparative trading-volume and market-capitalization figures in Notes 5 through 7 are drawn from third-party market-data aggregators currently accessible at the time of writing, are subject to constant change, and have not been independently re-verified against primary on-chain data by this paper's authors. They are included to illustrate the general scale and cross-chain distribution of permissionless trading activity, not as precise or current figures to be relied upon.*

---

*This whitepaper is preliminary and subject to change. It does not constitute an offer or solicitation to buy or sell any security, token, or other financial instrument in any jurisdiction where such offer or solicitation would be unlawful. This protocol has not been registered under the securities laws of any jurisdiction. Prospective holders should conduct their own research and consult independent advisors before making any decision related to ACT.*
