---
target: the Aretia homepage (new Astro site)
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:C:\\Users\\USER PC\\OneDrive - Furst Peak Solutions\\My Stuff\\Folders\\2026\\Aretia Climate App\\aretia-finance\\website\\src\\pages\\index.astro"
target_fingerprint: "sha256:c343184c8b7750623e9b7a6665beb4beb8adbe49e26087140a735640772233e7"
target_path: "C:\\Users\\USER PC\\OneDrive - Furst Peak Solutions\\My Stuff\\Folders\\2026\\Aretia Climate App\\aretia-finance\\website\\src\\pages\\index.astro"
timestamp: 2026-09-30T20-01-56Z
slug: src-pages-index-astro
---
Method: dual-agent (A: design review · B: detector + browser evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live/Built/Testnet/In development/Roadmap badges are excellent and used everywhere — undercut by the hero, where "Launch Aretia Wallet" is the loud action and "Wallet in development" is a 13px corner note. |
| 2 | Match System / Real World | 2 | Headline is plain, but the page moves fast into "EVM networks," "SPL Token-2022," "Mint authority: Revoked," "350 basis points," "MRV" — a climate-curious, non-crypto-native visitor loses the thread quickly. |
| 3 | User Control and Freedom | 2 | All three wallet CTAs (nav, hero, closing band) route to `/wallet/app`, a dead-end dialog whose only option is "Back to aretiafinance.org." No waitlist, no alternative. |
| 4 | Consistency and Standards | 2 | "Launch Aretia Wallet" vs. "Launch Wallet"; hero says 2% fee, body says 3.5%; iPhone mockup for a Chrome-extension-only, mobile-not-yet-shipped product; off-brand indigo icon on `/wallet/app`. |
| 5 | Error Prevention | 2 | The 2%-not-3.5% fee framing invites a "hidden fee" reaction; the primary CTA predictably dead-ends. |
| 6 | Recognition Rather Than Recall | 3 | Five sub-brands (Universal, Shield, Intent, Pay, ACT) is a lot to hold, but role labels ("Transaction safety," "Human-readable payments") help. |
| 7 | Flexibility and Efficiency of Use | 3 | Explore table's status filters and mega-menu descriptions genuinely serve a scanning, experienced visitor — applicable here, scored rather than n/a. |
| 8 | Aesthetic and Minimalist Design | 1 | The same four products are explained four separate times (Explore table, phone story, four ProductSections, Architecture map). Page runs ~16,600px desktop / ~19,800px mobile. |
| 9 | Error Recovery | 2 | The dead-end dialog explains why but offers no path forward. |
| 10 | Help and Documentation | 3 | Docs, Whitepaper, Support, "Verify the mint," and a risk disclosure are all easy to find. |
| **Total** | | **23/40** | **Acceptable — significant improvements needed before users are happy** |

## Design Specificity Verdict

**LLM assessment**: The hero is category-interchangeable — swap "Aretia" for "Phantom," "Rabby," or "Trust" and "Your money. Every chain. One wallet." still works unchanged. The stock photo (two friends taking a selfie in a park) could sell a bank, a phone carrier, or a dating app; most of the "climate" read comes from incidental trees in the background, not from any deliberate design choice. The surrounding UI is white / Apple-grey (#6e6e73, #86868b) with Geist, and green appears only as an accent. Where the page does get specific — the fee-flow diagram, the treasury allocation bars, the "Mint authority: Revoked" status line, "Verify the mint" — the work is genuinely good and clearly authored for this product. But it's all below the fold; the climate section doesn't start until roughly 77% of the way down the page.

**Deterministic scan**: `impeccable detect --json` against `src/pages/index.astro`, `src/layouts/Base.astro`, and `src/components` returned exit code 2 with 3 findings — `layout-transition` ×2 (quality) and `gradient-text` ×1 (slop):
- `src/components/ecosystem/Architecture.astro:87` — **false positive**. The detector's `layout-transition` rule pattern-matched the substring "width" inside `stroke-width` (an SVG line-thickness attribute, not a CSS box-model property); the actual line (`transition: stroke var(--duration-base), stroke-width var(--duration-base)`) never appears as "transition: width" and doesn't cause layout reflow.
- `src/components/ecosystem/EcosystemStory.astro:213` — **true positive**. `.pager li` animates `width` (6px → 18px via `.is-on`) to grow the active story-step dot. Works visually but triggers a layout-affecting property on every transition; `transform: scaleX()` would achieve the same growth without reflow cost.
- `src/components/footer/Footer.astro:108` — **true positive**, and it reinforces the specificity verdict above: the "ARETIA" wordmark uses `background-clip: text` with a gradient fill — a generic, brand-agnostic treatment the detector flags as visual cliché ("slop"), on exactly the one element that should feel most like this brand and nothing else.

**Visual overlays**: injection was genuinely attempted and failed for an environmental reason, not a tooling gap. Script-mutation preflight passed (Assessment B confirmed real DOM mutation via `document.title` and an injected `<script>`). The detector's local live-server started correctly, but loading `http://localhost:PORT/detect.js` into the HTTPS `aretiafinance.org` tab was blocked (`net::ERR_BLOCKED_BY_CLIENT`, confirmed independently via a same-context `fetch()` failing identically) — this is the browser's mixed-content policy blocking an active HTTP subresource on an HTTPS page, not an ad-blocker or a broken injection. **No user-visible overlay is available for this run.** In its place, Assessment B did a manual full-page scroll capture at desktop and 375×812 mobile widths, confirming the sections named above by direct visual inspection instead.

## Overall Impression

The page is well-engineered and the honesty mechanic (Live/Built/Testnet/Roadmap badges everywhere, "Illustrative photos, not Aretia-funded projects," "Version 1: a deterministic phrase parser, not an AI model") is a real, defensible differentiator in a space full of overclaiming. But the page leads with the wrong product: an unreleased, in-development multichain wallet gets the headline, the primary button, and three separate CTAs that all dead-end, while the thing that's actually live and actually differentiated — ACT on Solana mainnet, funding a real climate treasury on every transfer — is a footnote-sized pill in the hero and doesn't get its own section until roughly three-quarters of the way down a 16,600px page. The single biggest opportunity is inverting that: make the climate-finance mechanism the headline and the reason to care, and let the wallet be the (coming-soon) vehicle, not the pitch.

## What's Working

1. **Status honesty as a brand trait.** Every claim on the page is badged Live/Built/Testnet/In development/Roadmap from a single source of truth (`site.ts`), with unusually candid notes like "Demo balance" and "Not yet published to the Chrome Web Store." In a category where overclaiming is the norm, this builds trust faster than adjectives could — it should be promoted as a headline trait, not left as a component detail.
2. **The EcosystemStory phone walkthrough shows rather than tells.** A concrete flow — typing "send 0.05 ETH to vitalik.eth," the name resolving to an address, Shield's checks, a review screen — with copy like "Nothing is sent from the phrase alone" and "never on a website" speaks directly to a self-custody user's actual fear.
3. **The fee mechanism is shown and checkable, not just claimed.** The ActSection flow (transfer → 3.5% withheld by the Token-2022 program → multisig → 2/1/0.5 split), paired with "Mint authority: Revoked" and a live "Verify the mint" link, turns a trust claim into something a skeptic can confirm on-chain. This is the most product-specific, most persuasive material on the page — and it's also the material that's hardest to find.

## Priority Issues

- **[P0] The homepage leads with a product nobody can use, and every primary button dead-ends.**
  **Why it matters**: "Launch Aretia Wallet" (hero), "Launch Wallet" (nav, persistent), and "Launch Wallet" (closing band) all route to `/wallet/app`, which shows a blocking "coming soon" dialog with a single "Back to aretiafinance.org" button. A first-time visitor's five-second read is "another multichain wallet," and their first click confirms it isn't real yet — in a token project, that reads as vaporware. It also discards the one claim competitors can't copy (every transfer funds verified climate work) in favor of one they can (multichain, one wallet).
  **Fix**: Lead the hero with the mechanism, not the wallet — e.g. "A wallet where every transfer funds climate projects," subhead "ACT is live on Solana: 2% of its 3.5% transfer fee funds a milestone-gated Climate Treasury. Aretia Wallet, coming soon, brings it to five chains." Give the primary button to something real today ("See the Climate Treasury" / "Get ACT"); relabel the wallet CTA honestly ("Join the wallet waitlist"). Replace the `/wallet/app` dead-end dialog with an email-capture waitlist.
  **Suggested command**: `/impeccable shape` (replan the hero/CTA hierarchy before touching code)

- **[P1] Climate is buried, inconsistent, and missing from the page's own summary diagram.**
  **Why it matters**: `ClimateSection` doesn't start until ~12,900px of 16,600 desktop (~15,300 of 19,800 mobile); the closing band never mentions climate at all; and the `Architecture.astro` component defines a `'climate'` node kind that is never actually used in `defaultNodes` — the page's own systems diagram omits the climate treasury entirely. Separately, the hero says "2% of every ACT transfer" while the rest of the page says 3.5% (2% of the 3.5% total fee goes to climate) — stated without that context, it reads as selective disclosure on a site that's otherwise scrupulously honest.
  **Fix**: Move `ActSection`/`ClimateSection` to directly follow the hero and merge into one fee-to-impact story (shown once, not twice — see next issue). Add a `treasury`/`climate` node to the Architecture diagram, linked to `act`. State "3.5% transfer fee; 2% to the Climate Treasury" together in the hero. Close the page on the climate outcome, not a copy of the hero line.
  **Suggested command**: `/impeccable layout`

- **[P1] The same four products are explained four separate times, bloating the page to ~16,600–19,800px.**
  **Why it matters**: Universal, Shield, Intent, and Pay are each introduced in the Explore table, again in the 8-step phone story, again in four full-width ProductSections with stock photography, and again as Architecture nodes. Scroll fatigue sets in well before the one genuinely differentiated section (the fee/treasury story), and most mobile visitors never reach it.
  **Fix**: Cut the four ProductSections from the homepage — `/features` already covers them. Keep the phone story as the single product walkthrough. Move or relocate the Explore table so the hero leads into narrative, not a data grid. Target roughly half the current page length.
  **Suggested command**: `/impeccable distill`

- **[P2] The Explore table clips its own Status column at common laptop/tablet widths.**
  **Why it matters**: At 1024px, `.explore__grid` still reserves a 340px sidebar while `.box--table` is `overflow: hidden`, so the table renders ~680px wide inside a 571px box — the Status column (the table's entire point) gets clipped, and the "What it does" column shrinks to ~97px with 3–4-word-wrapped rows. It's correct again at 1280px, so this is specifically an iPad-landscape / small-laptop break, right after the hero.
  **Fix**: Raise the single-column breakpoint in `ExploreTable.astro` from `max-width: 1023px` to ~1200px, or hide `.etable__where` below 1200px; as a fallback, switch `.box--table` from `overflow: hidden` to `overflow-x: auto`.
  **Suggested command**: `/impeccable adapt`

- **[P2] Accessibility gaps concentrated on exactly the elements meant to build trust.**
  **Why it matters**: The 2px focus ring (`#0f6b4b`) is effectively invisible on the dark-green hero overlay — tabbing to either hero button produced no visible change. The honesty/disclosure copy that's central to the brand's credibility ("in development," "Illustrative photos, not Aretia-funded projects," "Works across") sits in `--color-faint` (#86868b on white, ~3.6:1) or the hero's 55%-opacity chain list (~3.3:1) — both fail WCAG AA for normal text. Inactive story steps sit at 30% opacity. On mobile, the pinned phone scales to 0.55 (its text ~7px) and Architecture pills run ~26px tall, under the 44px touch-target minimum.
  **Fix**: Add a visible `focus-visible` style for every control on the dark hero (e.g. white outline, 2–3px offset). Raise `--color-faint` to at least `--color-muted` wherever text is under 18px. Raise inactive-step opacity to ≥0.55. Give Architecture nodes a 44px minimum touch height.
  **Suggested command**: `/impeccable harden`

## Persona Red Flags

**Jordan (first-time visitor, climate-curious, not crypto-native)**
- Hero reads "Your money. Every chain. One wallet." and "four EVM networks, with a check before every signature" — neither "EVM" nor "signature" means anything to Jordan, and nothing signals climate until the final clause of the subhead.
- Clicking the white "Launch Aretia Wallet" button returns a "coming soon" dialog with only a "Back" button — reads as broken or unfinished; likely exit point.
- Scrolling instead, the first content after the hero is a ticker reading "Mint authority: Revoked" and "ACT supply 1,000,000,000," then a table explaining ACT as "SPL Token-2022 mint."
- The first plain-language account of the mission ("Finance that creates real-world impact.") doesn't appear until ~13,000px down the page.

**Casey (mobile, distracted)**
- At 390px, the hero headline starts at `opacity: 0` and only fades in once GSAP loads — the first capture at ~1.5s shows only the background photo and the 13px "Wallet in development. ACT live on Solana." line, no headline at all.
- The full-width "Launch Aretia Wallet" button leads to a desktop-extension dashboard behind a dead-end dialog. Mobile is roadmap-only, so nothing on the page is actually usable on the device Casey is holding.
- In the phone story, the sticky phone occupies ~45% of the viewport with ~7px text inside it — unreadable.
- The climate section sits at ~15,300 of 19,800px on mobile — well past where a distracted visitor has already left.

**Sam (keyboard / low-vision)**
- No visible focus indicator on either hero button (dark ring on a dark hero overlay).
- Every disclosure Sam would rely on to judge trust ("in development," "not yet on the Chrome Web Store," "Illustrative photos") is set in the lowest-contrast text on the page.
- Inactive story steps at 30% opacity are effectively unreadable until scrolled into the active band (reduced-motion users do get static screens correctly, which is a genuine plus).
- The Architecture map's connecting lines carry the actual relationships between nodes but are `aria-hidden` with no text equivalent; node focus/tap does work and uses `aria-live`, which is good as far as it goes.

## Minor Observations

- The closing band ("Your assets. Your chains. One wallet.") nearly repeats the hero verbatim — reads as recycled rather than an intentional echo, and spends the page's last impression on the same message as its first.
- The phone story's handset is a full iPhone chrome (status bar, Dynamic Island, tab bar) for a product that is currently Chrome-extension-only with mobile on the roadmap — the visual promises something that doesn't exist yet.
- "ACT is live on Solana mainnet" — the single most load-bearing trust fact on the page — is also its smallest hero text.
- Four of five hero-level images are interchangeable "happy person with phone" stock photography; none of them carry product-specific meaning.
- No live treasury figure anywhere (balance, fees collected to date, multisig link) — the mission section is asserted, not evidenced, despite the site's on-chain-verifiable ethos everywhere else.
- The Explore ticker's "Networks 5" overstates current reality: ACT runs on one chain today; cross-chain bridging is testnet only.
- Naming drifts across the site: "Aretia" (nav), "Aretia Finance" (footer/title), "Aretia (ACT)" (wallet page title).
- The meta description leads with "multichain financial infrastructure" — search snippets will read as generic as the hero does.
- `EcosystemStory.astro:213` animates a pager dot's `width` on activation (6px→18px); switching to `transform: scaleX()` gets the same effect without a layout-affecting transition (flagged by the deterministic scan as a true positive).
- `Footer.astro:108`'s gradient-clipped "ARETIA" wordmark is a generic treatment (flagged by the deterministic scan as visual cliché) on the one element that should feel most distinctly like this brand.

## Questions to Consider

1. If Aretia Wallet shipped tomorrow, why would anyone choose it over Phantom or Rabby? If the honest answer is "because every transfer funds verified climate work," why is that the last clause of the subheading instead of the headline?
2. How much is in the Climate Treasury right now, and what would the hero feel like if that live, Solscan-linked number were the biggest figure above the fold instead of a wallet CTA?
3. Who is this homepage actually for this quarter — someone who can act today (buy ACT, register a climate project) or someone who can only wait (the wallet)? What would the page look like if it were built only for the first group?
