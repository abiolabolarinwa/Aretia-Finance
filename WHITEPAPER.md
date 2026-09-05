# Aretia: A Protocol-Enforced Climate Catalyst Fund

**Aretia Finance LLC** (Delaware)
`aretiafinance.org` (domain registered; site not yet deployed there)

**Version 1.0: expanded edition, drafted 4 Sept 2026.** Issued by Aretia Finance LLC (Delaware), renamed from Aretia Climate Coin LLC. The Delaware Certificate of Amendment is in progress, and this document should be read as reflecting the entity's operating name going forward, not as a claim that the amendment has already been confirmed effective. The token's ticker changes correspondingly from ACC to ACT. No on-chain metadata existed under the old symbol, so nothing on-chain requires alteration. This edition expands the technical specification into a fuller treatment, adding theoretical grounding, comparative analysis, and an economic treatment of the fee mechanism, while leaving the underlying mechanism unchanged from the version reviewed by counsel on 1 September 2026 and 4 September 2026. Because this expansion is itself a further revision of previously approved public language, it has not been reviewed by counsel and should not be treated as final until it is. This document is not an offer to sell securities in any jurisdiction, makes no promise of profit or price appreciation, and should not be treated as investment advice.

---

## Abstract

Climate finance suffers from a verification problem rather than a capital problem in the narrow sense. Pledges accelerate faster than verified action, and capital that does move often does so slowly, opaquely, and without proof that it accomplished what it claimed. At the same time, permissionless token trading on networks such as Solana generates enormous, continuous transaction volume with no purpose beyond the trade itself, a volume that exists independent of any climate objective and would exist whether or not Aretia did. This paper describes Aretia, a protocol that converts a fixed share of ordinary token transfer activity into standing, continuously replenished capital, which we term a climate catalyst fund, without requiring any party to trust a promise at any stage. The mechanism is enforced by the token's own transfer fee extension rather than by policy, meaning the property holds by construction rather than by the good conduct of any operator. Capital leaves the fund only against independently verified project milestones, with every step, from fee withholding through final disbursement, visible on a public ledger and independently reproducible by any observer with an internet connection. We present the token design, the fee mechanism and its arithmetic, the custody and governance architecture, the diligence framework applied to funded projects, a comparative analysis against alternative approaches, and an honest accounting of what remains unbuilt. The result is not a pledge and not a one-time grant, but a self-replenishing source of catalytic capital engineered to keep operating whether or not anyone continues to advocate for it.

## 1. Introduction

### 1.1 The Verification Problem in Climate Finance

Trust in climate finance breaks down at a specific and identifiable point: the gap between a pledge and its verification. Corporate climate commitments rose 227 percent in 2025, a figure that on its own would suggest the field is accelerating. Yet voluntary carbon credit retirements, the step in the lifecycle of a credit that proves it was actually used rather than purchased and left unclaimed, fell 7 percent over the same period. Commitment is outpacing proof, and the divergence between the two figures is itself the diagnostic. The mechanisms conventionally available to close this gap, grant programs, offset purchases, and corporate pledges among them, share a common structural weakness: each depends on a promise being honored after the money or the stated intent has already moved, with verification, where it occurs at all, taking place after the fact and frequently being conducted by a party with an interest in a favorable outcome. A grantor rarely audits its own grantee with the same rigor an adversary would apply. A corporation announcing a pledge has every reason to publicize the announcement and comparatively little operational incentive to publicize a shortfall against it years later.

This is not a claim that actors in climate finance are acting in bad faith as a rule. It is a claim about incentive structure. Any system in which verification is optional, delayed, and self-administered will tend, in aggregate and over time, toward the outcome the data already shows: pledges that outpace proof. The correction implied by this diagnosis is not moral exhortation but mechanism design. If verification cannot be reliably supplied by voluntary conduct, it must be supplied by structure.

### 1.2 Permissionless Trading as an Untapped Capital Source

Separately from the climate finance question, permissionless token trading on Solana moves substantial real capital every day, for reasons entirely unrelated to climate objectives. Aggregate market capitalization in this category of asset is estimated at roughly 3.7 billion dollars, with daily trading volume near 961 million dollars. A single trading ecosystem within that category processed 19.69 billion dollars of volume within a thirty day window. This volume is not raised, solicited, or persuaded into existence. It is a byproduct of ordinary, permission-free markets functioning exactly as they are designed to function, and it would continue to exist in the complete absence of any climate-linked project, exactly as it did before one existed.

The observation at the center of this paper is that these two facts, a verification problem in one domain and an untapped, purpose-agnostic capital flow in another, can be connected mechanically rather than rhetorically. A protocol-level fee, enforced the same way any Solana Token-2022 transfer fee extension is enforced, automatically, on every transfer, by the token standard itself rather than by the discretion of any operator, can convert a fixed share of trading activity that already exists into climate capital that does not depend on anyone continuing to believe in, advocate for, or even be aware of the underlying mission. The mechanism does not ask traders to care. It only asks the token standard to do arithmetic, which it does regardless of anyone's sentiment.

### 1.3 Contributions and Organization of This Paper

This paper makes the following contributions. First, it defines the climate catalyst fund as a specific structural object, distinguished from an ordinary treasury or grant pool by two properties, continuous replenishment and non-discretionary capitalization, and situates that definition within the existing vocabulary of blended and catalytic climate finance. Second, it specifies the token design and transfer fee mechanism in full, including the arithmetic of fee allocation and the gross-up computation required to deliver a net amount through a fee-bearing internal transfer, a detail we have not seen treated explicitly elsewhere. Third, it specifies a milestone-verified disbursement process and a category-specific diligence framework applied before any project reaches that process. Fourth, it presents a four-layer governance architecture designed to avoid the specific failure mode of flat, one-holder-one-vote systems once a treasury is large enough to be worth attacking. Fifth, it offers a comparative analysis against the network alternatives to Solana and against existing approaches to climate finance more broadly, on the grounds that a mechanism paper that does not explain why the alternatives were rejected has not fully explained its own design.

Sections 2 through 14 proceed as follows. Section 2 situates Aretia relative to existing approaches to climate finance and to token-based fundraising. Section 3 defines the catalyst fund formally. Section 4 specifies token design. Section 5 specifies the transfer fee mechanism. Section 6 specifies treasury custody. Section 7 specifies milestone-verified disbursement. Section 8 specifies project selection and diligence. Section 9 specifies governance. Section 10 compares candidate networks. Section 11 addresses transparency and independent verifiability, including a client-side verification tool that has already been deployed. Section 12 offers an economic analysis of the fee mechanism's incentive properties. Section 13 works through illustrative arithmetic under several volume scenarios. Section 14 concludes.

## 2. Related Approaches and Why They Fall Short

A mechanism paper is incomplete if it does not explain what it is not. This section situates Aretia against four existing categories of approach, each of which addresses part of the verification problem described in Section 1 but not, we argue, the whole of it.

### 2.1 Voluntary Carbon Markets and the Retirement Gap

The voluntary carbon market provides a registry-based mechanism for quantifying and transacting emissions reductions, and established registries such as Verra and Gold Standard supply real methodological rigor to the question of whether a given reduction occurred. The market's weakness is not measurement but follow-through: a credit can be purchased and never retired, sitting in an account as a purchased-but-unused asset that satisfies a buyer's internal accounting without ever completing the act, retirement, that actually proves use. The 7 percent decline in retirements cited in Section 1.1 is precisely this failure mode expressed as a statistic. Aretia does not replace carbon credit registries; Section 8 explicitly treats registry-issued credits as one valid form of verified output. What Aretia adds is a mechanism that does not depend on the purchaser's subsequent discretion to complete the retirement step, because the catalyst fund's own disbursement process, described in Section 7, is designed so that a grant of this kind is itself one of the milestone-verified outputs it can fund.

### 2.2 Traditional Grant-Based Climate Philanthropy

Grant-based philanthropy, whether from private foundations, corporate social responsibility budgets, or bilateral development finance, typically disburses in large tranches against a proposal and a narrative report, with verification occurring, if at all, through a final report authored substantially by the grantee itself. This is not a claim that grant-based philanthropy is ineffective; considerable expert judgment goes into grant selection, and program officers frequently possess deep domain expertise. The structural weakness is narrower: verification and disbursement are not architecturally coupled. A grant can be fully disbursed before the deliverable is confirmed, and the confirmation, when it occurs, is rarely independent of the party being evaluated. Section 7 of this paper describes a disbursement process in which that coupling is structural rather than aspirational: a tranche is an instruction that a smart contract will not execute until an independent verification event has already occurred on-chain.

### 2.3 Blended and Catalytic Finance

The term catalytic capital, which this paper adopts and extends in Section 3, originates in blended finance practice, where it denotes capital placed specifically to unlock or de-risk activity that would not otherwise be financed on commercially reasonable terms, functioning as a first mover that makes a project bankable rather than as the entire bankroll for it. Existing catalytic capital vehicles are almost universally capitalized through discrete fundraising events, a foundation commits a sum, a development finance institution allocates a facility, and that sum, once deployed, requires a fresh fundraising cycle to replenish. Aretia's contribution here is narrow but, we think, meaningful: it asks whether a catalytic capital vehicle can be capitalized continuously, as a structural property of an unrelated economic activity, rather than periodically, as the product of a fundraising campaign. Section 3.2 makes this precise.

### 2.4 Token-Based Fundraising Without Enforcement

A number of existing tokens describe themselves as supporting a charitable or environmental cause, typically through a stated intention that some share of trading fees or treasury holdings will be donated to a cause at the team's discretion. The distinguishing weakness of this category, relative to Aretia, is that the commitment is a policy rather than a property of the code. A team that states an intention to donate a share of proceeds can, without violating any smart contract, simply not do so, and an external observer has no mechanism by which to detect the omission other than the team's own subsequent disclosure. Section 4 and Section 5 of this paper specify a token whose fee mechanism is a property of the mint's own on-chain configuration, verifiable by any party without trusting the issuing entity's representation of it, a distinction we consider load-bearing rather than cosmetic.

## 3. The Catalyst Fund

### 3.1 Definition and Structural Properties

We define the catalyst fund as the central object of this system: a treasury-held pool of capital that is, first, capitalized continuously by protocol-enforced transfer fees rather than by periodic fundraising; second, held under multi-party custody rather than any single controller; and third, disbursed only against independently verified project milestones rather than at the discretion of any one party. Each of these three properties is structural, meaning it is guaranteed by the design of the system rather than by the conduct of any party operating within it, a distinction elaborated further in Section 12.2.

### 3.2 Continuous Replenishment

Let F(t) denote the fund balance at time t. Then:

    F(t) = F(0) + Σ [0.02 × Vᵢ]   for every harvested transfer i occurring in (0, t]

where Vᵢ is the value of transfer i. F(t) is non-decreasing in trading activity and requires no discrete fundraising event to increase. This is the property that distinguishes a catalyst fund, as we use the term, from an ordinary grant pool of the kind discussed in Section 2.2 and Section 2.3. A grant pool's balance is a step function, flat between fundraising events and discontinuous at them. F(t) is instead a running sum over an activity, trading, that occurs continuously and independently of the fund's own fundraising calendar, because it has none.

### 3.3 Non-Discretionary Capitalization

No signer, founder, or committee decides whether a given transfer contributes to F(t). The transfer fee extension computes and withholds the fee at the protocol level, and there is no code path in which a transfer completes without it. This property matters independently of the replenishment property described above. A fund could in principle be replenished continuously by a party who nonetheless retained discretion over whether to honor that replenishment on any given day, and such a fund would not possess the property we describe here. Non-discretionary capitalization means the choice has already been made, once, at the level of the mint's configuration, and cannot be revisited transaction by transaction.

### 3.4 Relationship to Catalytic Capital in Blended Finance Theory

As noted in Section 2.3, the term catalytic capital is drawn from blended finance practice, where it denotes capital deployed specifically to de-risk or unlock activity that would not otherwise clear commercial financing thresholds. Aretia's catalyst fund occupies that same functional position within its own system, seeding and de-risking climate mitigation and adaptation work in verified tranches, described fully in Section 7, rather than functioning as a passive reserve awaiting a single large disbursement or as a lump-sum grant pool of the kind described in Section 2.2. The extension this paper proposes to that existing vocabulary is the substitution of a continuous, code-enforced capitalization process for the periodic, discretion-dependent capitalization process that characterizes catalytic capital vehicles as they are presently constituted.

## 4. Token Design

### 4.1 Supply and Authority Structure

ACT is issued as a Solana SPL Token-2022 asset with the following fixed parameters.

| Parameter | Value |
|---|---|
| Mint address | `BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT` |
| Program | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) |
| Total supply | 100,000,000, fixed |
| Decimals | 9 |
| Mint authority | Revoked |
| Freeze authority | Never granted |

Supply is fixed by construction rather than by policy. With decimals d equal to 9, the smallest representable unit is 10 to the power of negative 9 ACT, and the total raw unit supply is:

    total_raw_units = 100,000,000 × 10⁹ = 10¹⁷

Mint authority was permanently revoked immediately following the single initial mint, which deposited the full supply into the treasury vault's associated token account. No wallet, including the treasury's own, has held newly created ACT outside that initial mint. The absence of freeze authority means no account holding ACT can be frozen by any party, including Aretia Finance LLC itself.

### 4.2 Immutability as a Design Choice, and Its Costs

It is worth stating plainly that the irrevocability described above is a deliberate tradeoff rather than a costless guarantee. Revoking mint authority forecloses, permanently and by the same mechanism that makes the fixed-supply claim verifiable, any future ability to attach on-chain metadata to the mint through the standard mechanisms available for doing so, since both the native Token-2022 metadata extension and the separate Metaplex Token Metadata program require an authority that this mint no longer possesses. The practical consequence is that ACT displays without a name, symbol, or logo in wallets, block explorers, and automated token-risk scanners, which in turn causes several of those scanners to flag the token using heuristics designed to detect a different failure mode, an active rug pull, than the one actually present, a fixed and immutable supply with no metadata. We consider this an honest cost of the commitment device rather than an oversight, and Section 11.3 describes the mitigation adopted in its place: since the token's own identity cannot be made self-evident on-chain, the burden shifts to making independent verification of its actual properties as easy as possible for anyone who encounters it as, apparently, unverified.

### 4.3 Market Access and Permissionless Trading

ACT trades on the open market against USDT, with no permission requirement and no gatekeeping of any kind. Any Solana wallet or exchange capable of handling a standard Token-2022 asset can transact it without integrating any Aretia-specific logic, a property inherited directly from the token standard rather than engineered specifically for this project.

## 5. The Transfer-Fee Mechanism

### 5.1 The Withholding Function

Token-2022's native transfer fee extension withholds a percentage of every transfer at the protocol level, before the recipient's balance is credited. For a transfer of amount A, the withheld fee is:

    fee(A) = min(A × b, M)

where b equals 0.041, or 410 basis points, is the fee rate, and M is the mint's configured maximum fee, included so that a single very large transfer does not withhold an unbounded absolute amount.

### 5.2 Fee Allocation

Aretia's split of the withheld fee is as follows.

| Destination | Share of transfer | Share of withheld fee |
|---|---|---|
| Recipient (net) | 95.9% | not applicable |
| Catalyst fund (treasury) | 2.0% | 20/41, approximately 0.4878 |
| Liquidity pool | 1.0% | 10/41, approximately 0.2439 |
| Burn | 1.0% | 10/41, approximately 0.2439 |
| Management fee | 0.1% | 1/41, approximately 0.0244 |

This split is a property of the mint's on-chain configuration, not a policy any party follows voluntarily, a distinction this paper has already drawn in Section 2.4 against tokens whose charitable commitments are policy rather than code.

### 5.3 The Two-Phase Withhold-and-Harvest Design

A withheld amount does not move to its destination automatically at transfer time. It accumulates inside the recipient's own token account as a TransferFeeAmount value, a field publicly readable by any observer, until an authorized party executes a harvest instruction that sweeps it to the treasury. This two-phase design, withhold locally at the moment of transfer, then harvest periodically in a separate instruction, is what allows every wallet, exchange, and routing aggregator already supporting Token-2022 to handle ACT correctly with no Aretia-specific integration whatsoever. The complexity of routing the fee to its final destination is confined entirely to the harvest step, which only the treasury multisig executes, rather than being distributed across every individual transfer, which would require every piece of Solana infrastructure that touches ACT to understand Aretia's specific fee-routing logic.

### 5.4 Management-Fee Delivery and the Gross-Up Problem

The management fee wallet, address `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`, is held separately from the treasury multisig, so that operational compensation to Aretia Finance LLC can never be commingled with catalyst fund capital structurally, rather than merely by reporting convention. Delivering that compensation requires a second transfer, from the treasury vault to the management wallet, and that second transfer itself incurs the same fee function fee(A) described in Section 5.1, since the fee applies to every transfer of the token without exception. To land a net amount N in the management wallet after that second transfer's own fee is deducted, the treasury must send a gross amount G satisfying:

    G − fee(G) = N
    G × (1 − b) = N     [when fee(G) < M]
    G = N / (1 − b) = N / 0.959

For example, to deliver a net N of 1,000 ACT to the management wallet, the treasury must send a gross G of 1,000 divided by 0.959, approximately 1,042.75 ACT, of which approximately 42.75 ACT is withheld on that second transfer and re-enters the fee-split pool described in Section 5.2. We are not aware of this recursive fee-on-internal-transfer problem being treated explicitly in prior public documentation of comparable mechanisms, and include it here because a treasury operator who failed to account for it would systematically underdeliver the intended management compensation on every occasion the calculation was performed.

## 6. Treasury Custody

### 6.1 Multisignature Custody Model

Harvested fees settle into a Solana multisig, using the Squads protocol, live on mainnet at address `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg`. The multisig defines a signer set S with cardinality three and a threshold t of two. A transaction executes only if the number of independent approving signatures k satisfies:

    k ≥ t,  that is,  k ≥ 2 of 3

No single key, including any key held by Aretia Finance LLC or by any individual associated with it, can move catalyst fund capital unilaterally.

### 6.2 Threshold Selection: Why Two of Three

A threshold of two of three was selected as the smallest configuration that eliminates unilateral control while remaining operationally practical for an entity of this size. A larger signer set with a proportionally larger threshold would reduce the marginal influence of any single compromised or unavailable signer further, at the cost of requiring coordination among a larger group for every routine transaction. We regard two of three as an appropriate starting point given the treasury's current scale, and note that Section 9's governance architecture provides the mechanism by which this parameter, like others, could be revisited as the system matures.

### 6.3 Operational Verification

The propose, review, approve, and execute cycle has been tested end to end with a real transaction on mainnet, approved independently by two of the three signers, rather than verified only in principle. We consider this distinction, between a custody model that has been exercised and one that has merely been configured, material enough to state explicitly.

## 7. Milestone-Verified Disbursement

### 7.1 Forms of Disbursement

Capital leaves the catalyst fund in one of two forms. The first is a grant to a vetted climate project partner not itself tokenized, such as a reforestation cooperative or a community solar developer. The second is an on-chain retirement of tokenized carbon credits sourced from an established registry, producing a quantified tonnes of carbon dioxide equivalent figure tied to a specific transaction hash, which we characterize as a receipt rather than a claim, in the sense that the figure is a direct output of an on-chain event rather than an assertion requiring separate corroboration.

### 7.2 Tranche Structure and the Sequencing Problem

Neither form of disbursement releases as a single lump sum against an initial approval. An approved project's total commitment C is instead divided into n tranches, c₁ through cₙ, with:

    Σⱼ cⱼ = C,  for j = 1 to n

and tranche cⱼ releases only after independent verification confirms that milestone j minus 1 was actually met. This sequencing is the structural mechanism that prevents the statement "the fund financed a project" from silently coming to mean, in a given instance, "the fund sent money to a project that subsequently failed to complete its work," a failure mode this paper argued in Section 2.2 is endemic to disbursement processes in which verification and payment are not architecturally coupled. Full lifecycle detail beyond the scope of this paper is provided in the companion document `PROTOCOL.md`, Sections 8 and 9.

### 7.3 On-Chain Auditability of Disbursements

Every disbursement, of either form, is a public on-chain transaction originating from the known treasury address identified in Section 6.1. No disbursement is representable, to any observer, as anything other than what the underlying chain state shows it to be, a property that holds regardless of what any party, including Aretia Finance LLC, subsequently claims about it. The criteria used to determine which projects reach this disbursement process in the first place are given in Section 8.

## 8. Project Selection and Diligence

### 8.1 Category Taxonomy

The catalyst fund finances five categories of climate work: renewable energy, waste-to-energy management, carbon reduction, technical assistance, and flood management and reforestation. Each category admits a structurally different kind of verifiable claim, and each is accordingly held to a diligence standard appropriate to that specific claim, applied by the technical committee described in Section 9 before a project is admitted to the funding slate.

### 8.2 Category-Specific Diligence Standards

| Category | Verified output | Diligence standard |
|---|---|---|
| Renewable energy | Metered generation capacity added | Independent engineering certification of installed and operating capacity; interconnection or off-take documentation |
| Waste-to-energy management | Waste diverted and energy generated | Facility operating permits, throughput metering, emissions monitored against a stated baseline |
| Carbon reduction | Emissions avoided or removed | Registry-issued credits, from Verra, Gold Standard, or a comparable standard, or an equivalent third-party MRV protocol |
| Technical assistance | Capacity delivered: studies, training, MRV systems built | Deliverable-based milestones; independent review of the technical work product itself, since there is no physical asset to inspect |
| Flood management and reforestation | Hectares restored; flood-risk reduction achieved | Remote-sensing canopy verification for reforestation; hydrological modeling or post-event impact assessment for flood management |

### 8.3 The Special Case of Technical Assistance

Technical assistance differs from the other four categories in kind rather than merely in degree. Where renewable energy, waste-to-energy, carbon reduction, and flood management and reforestation projects each produce a physical or registry-verifiable output that exists independently of any narrative account of it, technical assistance instead funds the capacity that makes a future project bankable in the first place: a feasibility study, an MRV system a smaller developer could not otherwise afford to build on its own, or training delivered to a local partner's own monitoring staff. Its diligence standard is accordingly oriented around the work product actually delivered against a defined scope of engagement, rather than a physical inspection of an asset in the field, since in this category no such asset yet exists to inspect.

### 8.4 Portfolio Weighting as a Governance Parameter

A project's category determines which diligence standard from Section 8.2 applies to it. It does not alter the milestone-verified release mechanism defined in Section 7, which governs every category identically regardless of the nature of the underlying claim. The relative weighting of categories within the overall portfolio is a Layer 1 governance parameter under Section 9, revised through the same procedure that sets any other funding priority, and is accordingly not fixed by this document.

## 9. Governance

### 9.1 The Failure Mode of Flat Token-Holder Voting

A flat, one-holder-one-vote system governing individual disbursements fails once a treasury is large enough to be worth attacking, because a well-organized proposal can extract funds from a naively administered vote regardless of that vote's formal legitimacy. This is not a hypothetical concern specific to Aretia; it is a general property of governance systems in which the entire decision authority over a valuable resource is concentrated in a single voting mechanism with no independent check on the substance of what is being voted upon.

### 9.2 A Four-Layer Architecture

Aretia's governance is layered instead of flat, across four distinct functions. The first layer is community governance, exercised by token holders through Realms, which sets funding priorities, project categories, and treasury allocation weights, but does not vote on individual disbursements. The second layer is a technical committee, which screens individual project applications for climate-science credibility, MRV soundness, and financial feasibility before a project can be admitted to the process described in Section 7. The third layer is independent verification, which confirms, at each milestone, that a party independent of both the protocol team and the project developer has verified the claimed progress actually occurred. The fourth layer is smart-contract execution, which releases funds only once the second and third layers have both signed off on a given milestone, with no human discretion exercised at the point of transfer itself.

### 9.3 Phased Activation

Governance is phased in against real participation rather than switched on in full at launch. Layer 1 activates once the holder base is large enough for a vote to carry genuine information content rather than being symbolic in practice. Layers 2 through 4 build out across the roadmap phases specified in the companion document `PROTOCOL.md`, Section 17. Until Layer 1 is live, the treasury operates on team-curated grants under the identical milestone-verification discipline described in Section 7, meaning the sequencing guarantee described there does not depend on governance being fully activated to hold.

### 9.4 Comparison to Single-Signer and DAO-Only Models

It is worth situating this architecture against the two more common alternatives. A single-signer model, in which one founder or entity retains full discretion over disbursements, offers speed and simplicity at the cost of the exact non-discretionary property this paper has emphasized throughout; it is a system whose good behavior depends entirely on the continued good faith of one party. A DAO-only model, in which token holders vote directly on every disbursement with no intervening technical or verification layer, addresses the concentration-of-discretion problem but reintroduces the failure mode described in Section 9.1: a majority or a well-coordinated plurality of token holders can, in principle, vote to disburse the treasury to itself. The four-layer architecture described in Section 9.2 is designed to occupy neither extreme, distributing discretion across community priority-setting, technical screening, independent verification, and mechanical execution such that no single layer, including a hypothetical majority of token holders, can unilaterally move funds.

## 10. Network Selection

### 10.1 Requirements for the Underlying Ledger

The mechanism described in this paper requires a ledger with three properties: transaction costs low enough that routine harvest and disbursement operations remain economical at the scale this treasury is likely to operate at; a native, protocol-level fee-on-transfer primitive, so that the withholding described in Section 5.1 is a property of the token standard rather than of custom program logic Aretia would otherwise need to write and maintain; and sufficient liquidity in USDT or an equivalent stable asset to support the trading pair described in Section 4.3.

### 10.2 Comparative Analysis

| Network | Fee per transfer | Native fee-on-transfer support | USDT liquidity |
|---|---|---|---|
| Solana | approximately $0.0003 | Yes, via the Token-2022 extension | Native SPL USDT, deep on Raydium and Orca |
| Base | approximately $0.01 to $0.05 | No, requires custom contract logic | Bridged USDT |
| BNB Chain | approximately $0.10 to $0.30 | No, requires custom contract logic | Deep, but with more centralized custody risk |
| Ethereum L1 | $2 to $30 or more | No, requires custom contract logic | Deepest overall, but expensive to disburse from frequently |

### 10.3 The Cost of Bespoke Fee Logic

The deciding factor in Section 10.2 is the third column, native fee-on-transfer support, rather than the first. On every chain lacking a native primitive of this kind, the withholding and routing mechanism specified in Section 5 would have to be implemented as bespoke program logic written and maintained specifically for this project, introducing an additional attack surface with its own potential defects, one that would need to be reviewed separately from, and in addition to, the underlying token standard itself. Token-2022's transfer fee extension is instead a property of shared infrastructure that every Solana wallet, exchange, and routing aggregator already implements correctly, having been built once and used by the entire ecosystem rather than once per project. Building the equivalent mechanism on a chain without this primitive would mean asking every counterparty to trust Aretia's own custom code for a function the token standard otherwise guarantees at the infrastructure level.

## 11. Transparency and Independent Verifiability

### 11.1 On-Chain Verifiability of Every Claim

Every factual claim this document depends upon is independently verifiable by any party, without requiring that party to trust Aretia Finance LLC's representation of it. The mint's fixed supply and revoked authorities, described in Section 4.1, are on-chain state. The transfer fee configuration described in Section 5.2 is on-chain state. The treasury's multisig threshold and signer set described in Section 6.1 are on-chain state. Every disbursement described in Section 7.3 is a discrete, permanent transaction originating from a known address. In each case, the claim in this document is a description of chain state that already exists, not an assertion this document is itself responsible for making true.

### 11.2 The Transparency Dashboard

A public transparency dashboard, currently in development and not yet live, is intended to index this activity as a running ledger, inflow, disbursement, recipient, and running total, presented continuously rather than as a periodic report published when convenient for the operator. It is not yet complete; we note it here only to distinguish it from the mechanism already described in Section 11.3, which is complete and live today.

### 11.3 Client-Side Self-Verification

In addition to the dashboard described above, a client-side verification tool has already been deployed at the project's public website, under the path `verify.html`, or equivalently the anchor `#verify` on the site's primary page. This tool queries Solana mainnet directly from the visitor's own browser, with no server operated by Aretia Finance LLC in the request path at any point, and independently recomputes each of the claims made in Section 4.1 and Section 5.2, namely the mint's authorities, its supply and decimal configuration, the transfer fee rate, the fee authorities, and the treasury's token balance, displaying the live, on-chain result beside the documented claim for direct comparison. The tool's own source is visible in the page from which it runs, so that a skeptical visitor is not asked to trust the verification tool either; the same browser view-source mechanism that exposes any web page's implementation exposes this one. We regard this as a partial but genuine answer to the immutability cost described in Section 4.2: because the token cannot display a verified identity on-chain, the site instead makes the underlying facts trivially checkable by anyone who arrives skeptical of them.

## 12. Economic Analysis

### 12.1 Fee Incidence and Trading Behavior

A transfer fee of 410 basis points is a real cost borne by anyone transacting the token, and it is fair to ask whether a fee of this magnitude meaningfully deters the trading activity the mechanism depends upon in the first place. We note two considerations relevant to this question without claiming to resolve it empirically, since no trading history yet exists to measure against. First, transfer fees in this general range are not unusual among comparable Solana Token-2022 assets that have achieved meaningful trading volume, suggesting the fee alone is not prohibitive at this scale. Second, and more specific to this design, the fee is fixed and fully disclosed prior to any transaction, which distinguishes it from slippage or price impact, both of which vary with trade size and pool depth and are frequently larger in absolute terms for a given trade than the fee itself. A rational trader prices the fee into their decision the same way they price any other known, fixed transaction cost.

### 12.2 Credible Commitment Through Mechanism Design

The distinction drawn in Section 2.4, between a policy commitment and a code-enforced property, has a formal name in economics: the difference between cheap talk and a credible commitment device. A statement of intent that the issuer could costlessly reverse without technical consequence is cheap talk, regardless of the sincerity with which it is made. A property enforced by an immutable, permissionless token standard, verifiable by any party without trusting the issuer's account of it, is a credible commitment in the technical sense: the cost of reneging is not merely reputational but architectural, since reneging would require rewriting a mint configuration that no longer has an authority capable of rewriting it. Sections 4.1 and 4.2 describe the specific mechanism, permanent revocation of mint authority, by which this commitment is made costly to break, and the cost, discussed in Section 4.2, that this same irrevocability imposes elsewhere.

### 12.3 Liquidity Provision Incentives and Impermanent Loss

A separate incentive question concerns the party or parties who eventually supply the other side of the ACT-USDT trading pair described in Section 4.3, since a liquidity provider to an automated market maker pool bears a distinct risk, commonly termed impermanent loss, in which a divergence between the pool's two assets can leave a liquidity position worth less, in dollar terms, than simply holding the two assets separately outside the pool. This risk is a standard, well-documented property of automated market making rather than a feature specific to this token. We flag it here because an economic analysis of the fee mechanism that omitted the liquidity side of the market would be incomplete: the catalyst fund's continuous replenishment, described in Section 3.2, depends on trading volume, and trading volume depends on liquidity existing in the first place, which in turn depends on some party accepting impermanent loss risk in exchange for a share of trading fees.

## 13. Illustrative Calculation

The mechanism's output is arithmetic, not a forecast, and this section presents that arithmetic under several illustrative volumes chosen for round numbers rather than as a projection of what volume will actually occur. For any aggregate ACT transfer volume V occurring between harvests, and before the maximum-fee cap described in Section 5.1 applies to any individual transfer within that volume, the allocation is:

    catalyst fund accrual   = 0.02  × V
    liquidity accrual       = 0.01  × V
    burn amount             = 0.01  × V
    management fee accrual  = 0.001 × V
    recipient net           = 0.959 × V

The following table applies this formula at three illustrative scales.

| Aggregate volume V | Catalyst fund (0.02 V) | Liquidity (0.01 V) | Burned (0.01 V) | Management fee (0.001 V) |
|---|---|---|---|---|
| $10,000 | $200 | $100 | $100 | $10 |
| $100,000 | $2,000 | $1,000 | $1,000 | $100 |
| $1,000,000 | $20,000 | $10,000 | $10,000 | $1,000 |

No step in this computation depends on price, sentiment, or continued attention to the protocol's mission. It is a fixed function of transfer volume, computed identically whether that volume reflects one large trade or ten thousand small ones. This document makes no representation about which, if any, of the three rows above will resemble actual future volume. Actual accrual to the catalyst fund is a direct, mechanical function of real trading volume, which is presently unknown and is not forecast anywhere in this paper.

## 14. Conclusion

This paper has described a mechanism that converts a fixed, protocol-enforced share of ordinary token-transfer activity into standing capital for climate mitigation and adaptation work, a catalyst fund that requires no renewed pledge to keep functioning, no trust in any single party's discretion to keep it honest, and no step, from fee withholding through milestone-verified disbursement, that cannot be independently checked against the public ledger by any party willing to do so. The mechanism, as distinct from its eventual scale, is live: ACT is deployed on Solana mainnet with its supply fixed and mint authority revoked, and the treasury multisig operates under tested, exercised, multi-party custody rather than merely configured custody. What remains is scale: real trading volume, a seeded liquidity pool, an independent program review, a live transparency dashboard, and a first slate of verified project partners. None of these remaining items requires trusting a new promise to complete; each is a specific, named piece of work whose completion will itself be as verifiable, once done, as everything described in the sections above already is.

---

*This whitepaper is preliminary and subject to change. It does not constitute an offer or solicitation to buy or sell any security, token, or other financial instrument in any jurisdiction where such offer or solicitation would be unlawful. Aretia has not been registered under the securities laws of any jurisdiction. Prospective holders should conduct their own research and consult independent advisors before making any decision related to ACT.*
