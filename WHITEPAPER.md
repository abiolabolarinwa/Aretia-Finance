# Aretia Finance

*A plain-language guide to how it works*

`aretiafinance.org`

---

## In short

Climate projects usually can't get funded at the exact moment they need it most: early, unproven, and too small or risky for a bank or investor to take a chance on. Aretia Finance is built to close that gap. Every time people trade its token, ACT, a small fee is automatically taken out and set aside. Part of that fee builds into a fund that pays real climate projects, in stages, and only after someone independent confirms the work actually happened. Nothing here requires trusting a promise: the fee is enforced by the token's own code, the money is held where no single person can move it alone, and anyone can check the real numbers themselves on Solana's public blockchain. This document explains all of it without the technical jargon, in about ten minutes of reading.

---

## 1. The problem this is trying to solve

Say a small team wants to build a solar farm, restore a mangrove forest, or turn a town's waste into electricity. The plan is solid. The people are capable. But no bank or investor will fund it yet, because nobody has proven it works. And nobody can prove it works without money to actually build it.

That's the trap. It isn't that the world lacks money for climate projects overall — climate-finance researchers estimate trillions of dollars move through climate investment every year. It's that almost none of that money is willing to go first, into the riskiest, least-proven stage, where a project most needs it. The gap is worst exactly where good ideas die: too early, too small, too unproven for anyone else to take the first risk.

The people who try to fill that gap today mostly do it through grants and pledges. Both have the same weak point: the money moves first, and the proof that it was used well comes later, if it comes at all, usually written by the same people who received it. Nobody is required to check.

The same weak point shows up in the voluntary carbon market too. A company can buy a carbon credit to offset its emissions, and that purchase looks good in an annual report whether or not the credit is ever actually "retired," the final step that proves it was used rather than quietly banked and forgotten. In recent years, corporate climate pledges have grown much faster than the number of credits actually being retired. That gap between what's promised and what's proven is exactly the pattern Aretia is built to avoid.

## 2. What Aretia does differently

Aretia turns an activity that has nothing to do with climate work, people simply trading a token, into a steady source of funding for projects that do.

Here's the chain, in order:

1. People trade ACT, the token behind Aretia, for whatever reason people trade any token.
2. Every trade automatically sets aside a small fee. This isn't a request or a suggestion — it's built into the token itself, the same way a vending machine won't give you a snack without the coin.
3. Part of that fee flows into a fund, growing continuously as trading happens, with no need to run a new fundraiser each time.
4. That fund pays real climate projects, but never all at once. Payments are split into stages, and each stage only unlocks after someone independent of both Aretia and the project confirms the previous stage was actually completed.

The result: a fund that grows on its own as long as people trade the token, and that can't quietly send money to a project that never delivered.

### Why does this need a blockchain at all?

A fair question. The honest answer: it doesn't *have* to, in theory, but a blockchain makes two specific things easy that would otherwise require a lot of trust. First, the fee isn't something Aretia promises to collect and set aside honestly, it's built directly into the token, the same way a soda machine physically won't dispense a can without a coin going in first. Nobody has to trust that a person remembered to do it correctly, or did it at all. Second, everything the fund does, every fee collected and every payment made, is recorded on a public ledger anyone can look up, forever, with nothing hidden in a private spreadsheet. A blockchain isn't magic here; it's just a public, tamper-resistant record book that also happens to enforce a simple rule automatically.

### A worked example

None of this depends on ACT's price. It depends only on how much gets traded. Here's what the fund would collect at different levels of trading activity, before anything else happens:

| If this much ACT trades in a year | The climate fund collects roughly |
|---|---|
| $1,000,000 | $20,000 |
| $10,000,000 | $200,000 |
| $100,000,000 | $2,000,000 |
| $1,000,000,000 | $20,000,000 |

These are illustrations of the math, not a prediction of what will actually happen. Nobody knows in advance how much ACT will be traded; the table just shows that the fund's growth is a fixed, predictable share of activity, whatever that activity turns out to be.

## 3. The token: ACT

ACT is Aretia's token, built on Solana, a fast, low-cost blockchain. A few facts about it are fixed and cannot be changed by anyone, including the team that built it:

- **There will only ever be 1,000,000,000 ACT.** The ability to create more was permanently switched off right after they were made. Nobody, ever, can print more.
- **Nobody can freeze your ACT.** That ability was never turned on in the first place, so it can't be misused later.

One thing is deliberately *not* fixed forever, and it's worth being upfront about: the exact fee percentage. Right now it's set at **3.5% of every transfer**. That rate can only change if the three people who jointly control the treasury agree (more on that below), and any change is public and delayed, never instant or hidden. As proof this isn't just a claim, the rate has already been changed once for real, from an earlier 4.1% down to the current 3.5%, using that exact process.

Here's where that 3.5% goes:

| Share of every transfer | Where it goes |
|---|---|
| 96.5% | The person receiving the transfer, as normal |
| 2.0% | The climate fund |
| 1.0% | Keeping trading smooth (liquidity) |
| 0.5% | Running costs |

No one has to remember to do this. It happens automatically, on every single transfer, whether the price is up, down, or flat, and whether anyone involved even knows the fund exists.

## 4. Who controls the money

Fees collected from trading settle into a shared treasury account. That account is set up so that **no single person can move money out of it alone** — it takes two of three trusted signers agreeing together. This isn't a policy anyone promised to follow; it's how the account is technically built, using a well-established multi-signature system already used across the Solana ecosystem.

This has been tested for real, not just set up and left untouched: the fee-rate change mentioned above was itself carried out through this exact two-of-three approval process, on Solana's live network, with real signatures.

Why two of three, and not just one person, or five? One person in control defeats the entire point, since a single signer could move funds unilaterally no matter what anyone else agreed to. Requiring every single signer to agree would make the treasury slow and fragile, since losing access to even one signer's key would freeze it completely. Two of three is the smallest setup that removes any one person's ability to act alone, while staying practical enough to actually operate day to day.

One thing we're not going to pretend is finished: full public details about who the three signers are, how independent they are from each other, and how they'd be replaced if needed, are still being prepared. Institutional partners will expect this in full, and it's coming — we'd rather leave it visibly open than paper over it with vague reassurance.

## 5. How a project actually gets paid

Money never leaves the fund in one lump sum. It's split into stages, and each stage has to clear a check before the next one is released:

1. A project applies and is reviewed.
2. If approved, it receives funding in stages, not all at once.
3. Before each new stage is released, someone independent of both Aretia and the project confirms the previous stage's work was genuinely completed.
4. Only then does the next payment go out. If the proof isn't there, it doesn't.

This is the part that stops "we funded a climate project" from quietly meaning "we sent money to a project that didn't deliver."

Aretia funds five kinds of projects today:

- **Renewable energy** (like solar and wind installations)
- **Waste-to-energy** (turning waste into usable power)
- **Carbon reduction** (projects that avoid or remove emissions)
- **Technical assistance** (helping smaller, capable teams become fundable in the first place, by paying for the studies and paperwork they can't otherwise afford)
- **Flood management and reforestation** (restoring land and reducing flood risk)

For anything involving a specific climate claim, like how much carbon was actually avoided, Aretia doesn't invent its own scoring system. It relies on the same independent, established standards and registries the wider climate industry already uses, so the numbers mean the same thing here as they do everywhere else.

### A simple example

Imagine a small cooperative wants to install solar panels for a rural community that isn't connected to reliable power. They apply, and their plan is approved for funding in three stages.

- **Stage one** pays for the panels and installation. Before stage two is released, an independent engineer confirms the panels are actually installed and generating power, not just that a check was written.
- **Stage two** pays for connecting the system to the community's grid. Again, independent confirmation is required before the next stage unlocks.
- **Stage three** covers the final handover and a few months of monitoring, confirmed the same way.

If the cooperative had instead disappeared after stage one with half-installed panels, no further money would ever go out, because there would be nothing for an independent party to confirm. That's the entire point of splitting funding into stages instead of handing it over all at once.

## 6. Who decides which projects get funded

Right now, while the community is still small, funding decisions are made by the Aretia team, under the exact same "prove it before you get paid" rule described above — no special treatment, no shortcuts.

As the community grows, the plan is to hand more of this over to ACT holders, but carefully. Token holders would help set overall funding priorities, like which categories of project deserve more attention, not vote on approving individual payments one by one. That distinction matters: letting any large group vote directly on individual payouts is exactly the kind of setup that can be captured by a coordinated group voting to send the treasury to themselves. Keeping "what to prioritize" and "did this specific payment actually earn its release" as two separate questions, answered by two different processes, is a deliberate safeguard, not an accident.

## 7. Getting involved: presale and staking

Two ways to get ACT are being built. As of this writing, both are fully built and tested on a practice network, but **neither is live for real money yet.**

**The presale** is a limited window where people can buy ACT directly, before it's available on the open market:

- Price: $0.01 per ACT
- Minimum purchase: $10. Maximum per person: $10,000
- Accepted currencies: USDC, USDT, or SOL
- If you buy in, 25% of what you bought is available right away, and the rest unlocks over the following 48 hours
- The sale only goes through if enough people join by the end of the window. If it falls short, the sale is cancelled automatically and everyone gets back exactly what they put in — nobody's money is ever at risk of just disappearing into a failed raise

**Staking** lets anyone already holding ACT lock it up for a set period in exchange for more ACT back later. The longer you're willing to lock it up, the bigger the bonus.

## 8. What's built today, and what's still ahead

Aretia is being built in stages, on purpose, so that each one is solid before the next begins.

1. **Foundation** *(mostly built)* — the token, the treasury, and the process for projects to apply for funding are live today. What's still missing at this stage: a public dashboard showing fund activity in real time, some form of community input into decisions, and a simple registry listing every project that's applied and where it stands.
2. **Climate finance** — turning applications into an actual funding pipeline. This means building out project scoring, a clear process for proposals, and making the independent-verification step described in Section 5 a routine, repeatable part of every funding decision rather than a one-off.
3. **Monitoring and verification** — better tools for actually measuring a funded project's real-world impact. This includes satellite and geospatial data for things like reforestation, and stronger independent verification infrastructure generally, so claims about impact keep getting easier to check, not harder.
4. **Going global** — expanding to more countries and more project types, and bringing in bigger institutional partners like development funds and larger NGOs. This phase may also involve making the system available on more than one blockchain, not just Solana.
5. **A future idea, not yet built** — projects that prove themselves through the process above could eventually be introduced to real outside investors, through a completely separate legal structure, never through the ACT token itself. This is explicitly just an idea today. It won't be built until several things are true first: Aretia's own operating company is properly and verifiably registered, ACT is actually trading with real liquidity, at least one project has been funded successfully from start to finish, and the whole system has been reviewed by independent outside experts. None of that is true yet, and we're saying so plainly rather than implying otherwise.

Each stage is meant to be genuinely finished before the next one begins in earnest. Building the fancier, later-stage tools before the foundation is solid would be building on sand: a public dashboard means nothing if the treasury behind it isn't real, and a global expansion means nothing if the verification step hasn't been proven at a small scale first.

## 9. Being honest about the risks

- **The fund's size depends entirely on trading activity.** If not enough people trade ACT, the fund grows slowly, no matter how sound the mechanism is.
- **ACT's price can rise or fall, sometimes sharply**, like any crypto asset. Nothing here protects against that.
- **The code hasn't yet been reviewed by an independent outside security firm.** That review is planned, not done.
- **Real-world projects can still fail**, even when funded honestly and in good faith. Funding well doesn't guarantee an outcome.
- **Crypto regulation is still evolving** in most countries, and future rules could affect how this works where you live.
- **Measuring real climate impact is genuinely hard.** Aretia relies on existing, independent measurement standards rather than claiming to have solved this itself.

None of this is a remote, hypothetical worry. Several of these are simply true of where the project stands right now.

## 10. Questions a friend would probably ask

**Is this just another crypto coin trying to sound good by mentioning climate change?**
Fair skepticism, given how common that's been. The difference Aretia is trying to prove out is that the "give a share to charity" part isn't a policy anyone could quietly ignore, it's built into the token's own code, checkable by anyone, at any time, without needing to trust a team's word for it.

**Can I get rich from this?**
Nobody should buy ACT expecting a guaranteed return. It's a real crypto asset, and its price can go up or down like any other. Section 9 lays out the risks plainly; please actually read it before buying anything.

**What happens if Aretia the company disappears one day?**
The token itself would keep working exactly as coded, since its supply and fee rules don't depend on any company existing. What would stop is anything that requires active human decisions, like approving new projects or updating the fee split. This is a real limitation worth naming honestly, not something the token's design alone solves.

**Why should I trust that the fund actually pays real projects, and doesn't just sit there?**
You don't have to take that on faith. Every fee collected and every payment made is a public transaction on Solana, and the verification step in Section 5 means a payment only goes out once someone independent has confirmed real progress. Section 11 shows you exactly where to check this yourself.

**Is my money safe if I join the presale?**
As safe as the design can make it: your funds sit untouched until the sale either succeeds or fails. If it fails, you get every cent back automatically. Nobody can spend presale funds on anything before the sale actually succeeds.

## 11. The legal part, in plain terms

Nothing in this document is financial or investment advice, and nothing here is an offer to sell a security anywhere that would be against the law. ACT has not been formally registered as a security in any country, and how it's treated legally can vary a lot from place to place. If you're thinking about buying or holding ACT, talk to your own independent advisor first, especially if you live somewhere with strict rules around crypto assets.

## 12. Don't take our word for it

Aretia's website has a built-in tool that checks Solana's real, public blockchain directly, live, while you watch. It shows the actual token supply, the actual fee configuration, and the actual treasury setup, straight from the source, not just numbers typed into a webpage. The full project code is also open source and publicly viewable, so nothing here depends on taking our description on faith.

If you want to verify things yourself, here's where to look:

| What | Address |
|---|---|
| ACT token | `7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG` |
| Treasury (shared account) | `5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr` |
| Treasury vault | `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` |

---

## A closing note

Aretia doesn't ask anyone to simply believe that climate funding will happen. It tries to build the funding mechanism directly into the infrastructure that generates the money, keep every step checkable, and say clearly where the guarantees end and the open questions begin.

For readers who want the full, heavily detailed version of this document, with academic citations, formulas, and a more technical breakdown of every mechanism, it's kept in the project's public GitHub repository as `WHITEPAPER_TECHNICAL.md`. This document is the everyday version, meant to be read in one sitting and shared with a friend without a glossary.

---

*This document is preliminary and subject to change. It does not constitute an offer or solicitation to buy or sell any security, token, or other financial instrument in any jurisdiction where such offer or solicitation would be unlawful. Aretia has not been registered under the securities laws of any jurisdiction. Prospective holders should conduct their own research and consult independent advisors before making any decision related to ACT.*
