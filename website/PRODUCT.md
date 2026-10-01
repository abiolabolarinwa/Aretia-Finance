# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, deliberately equal priority (confirmed by the user — no single lead audience):
1. **Crypto-native / DeFi users** evaluating tokenomics, self-custody mechanics, on-chain verifiability, and chain support.
2. **Climate-conscious mainstream visitors** evaluating whether "using a wallet / moving money through Aretia" translates into real climate impact, without needing prior crypto fluency.

Copy and hierarchy must work for both without gatekeeping either: plain-language framing up front, with on-chain/technical depth available immediately adjacent for the reader who wants it, not hidden behind separate pages only.

## Product Purpose

Aretia Finance is a Solana-based climate-finance protocol. Its token, ACT, carries a 1.5% transfer fee withheld on-chain by the Token-2022 program: 1% funds a multisig-held Climate Treasury that finances real-world climate projects against independently verified milestones, 0.5% covers treasury operations (verification, reporting, monitoring). There is no presale; ACT is acquired by trading.

Beyond the token, Aretia is building a wider product suite around self-custody and payments: **Aretia Wallet** (multichain self-custody, Solana + 4 EVM networks, in development), **Aretia Pay**, **Aretia Intent**, **Aretia Shield**, and **Aretia SafeSend** — named directly by the user as current evidence of "what we're building," to be shown on the site as an ecosystem rather than a single-product pitch. Per-product build status (Live / Built / Testnet / In development / Roadmap) is already tracked as a single source of truth in `src/data/site.ts`; do not mark any of these products "live" on a redesigned surface without checking that file first.

## Positioning

The mechanism a neighboring wallet or fintech product could not truthfully copy: every ACT transfer automatically funds a climate treasury, and the fee mechanism plus mint-authority revocation are independently verifiable on-chain ("Verify the mint"). The wider product suite (wallet, pay, intent, shield, safesend) is the vehicle; the live, checkable climate-finance mechanism is the differentiated claim and should anchor the site's proof, not sit beneath it.

## Operating Context

- ACT is live on Solana mainnet today; the transfer fee and treasury split are active.
- Website is live at `aretiafinance.org`, built on Astro, deployed via Vercel with auto-deploy from `main`.
- Wallet and the other named sub-products are pre-release (in development / roadmap) as of this writing — confirm current status per-product in `site.ts` before any copy claims otherwise.
- Legal entity: Aretia Finance LLC; a Delaware entity amendment was, as of the last checklist pass, still unconfirmed as filed/effective (`LAUNCH_CHECKLIST.md` step 6) — do not imply it is resolved.

## Capabilities and Constraints

- ACT is an SPL Token-2022 mint; mint authority has been revoked (name/metadata are now immutable on-chain).
- Treasury multisig (2-of-3): `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`, collects withheld fees and splits them 2% climate / 1% liquidity / 0.5% ops.
- Cross-chain transfer uses Wormhole Native Token Transfers — testnet only at present, not production-ready for EVM chains yet.
- Aretia Wallet is a Chrome-extension build in development, not yet published to the Chrome Web Store; mobile is roadmap-only.
- **No public, live treasury-balance figure is currently surfaced anywhere on the site.** Any redesigned proof section should link out to the multisig on Solscan rather than state a specific balance, unless the user supplies a current, confirmed number.
- **No confirmed count of climate projects funded or verified to date.** Do not fabricate project examples, funded amounts, or before/after outcomes; the treasury mechanism is live and accruing, not yet shown as having completed funding rounds.

## Brand Commitments

- Legal/brand name: "Aretia Finance LLC" (legal), "Aretia" (product/nav), ticker "ACT", wordmark "ARETIA", domain `aretiafinance.org`.
- Voice: deliberately candid, non-overclaiming — the status-badge system and disclosures like "Illustrative photos, not Aretia-funded projects" and "Version 1: a deterministic phrase parser, not an AI model" are an established, intentional brand trait, not incidental copy. Preserve this voice; do not soften it into generic marketing language.
- Visual reference supplied by the user for this round of work: [arm.com.ng](https://www.arm.com.ng) — not for its color (magenta) or industry fit, but for its compositional confidence: a serif display headline paired with a clean sans body, one saturated brand color used generously rather than as a thin accent, black pill CTAs with an arrow-nudge, numbered feature cards, and a full-bleed proof band showing real, specific app data rather than an abstract mockup. Aretia's existing forest-green/mint palette and established `.dhero` pill/arrow-CTA pattern remain the visual authority; the ARM reference informs boldness and proof-density, not a palette swap.

## Evidence on Hand

- `WHITEPAPER.md`, `PROTOCOL.md`, `TOKENOMICS.md`, `MINT.md` at the repo root — protocol mechanics and legal/regulatory framing.
- `src/data/site.ts` — single source of truth for per-product status badges, fee splits, and copy already in use across the live site.
- Treasury multisig address is real and Solscan-verifiable today; no other quantitative "impact" evidence (funded projects, dollar amounts, beneficiaries) currently exists and none should be invented.

## Product Principles

1. **Say what's real plainly, mark what's not.** The status-badge honesty pattern is the brand's core trust mechanic — preserve and lean into it, don't treat it as incidental.
2. **Lead with the mechanism, not the roadmap.** The live, checkable climate-treasury fee flow is the primary claim; pre-release products (wallet, pay, intent, shield, safesend) support that claim, they don't replace it as the headline.
3. **Serve both audiences without gatekeeping either.** Plain language up front; on-chain/technical depth adjacent, not hidden.
4. **Never imply completed impact that hasn't happened.** No fabricated project examples, funded-amount claims, or outcome imagery beyond what's explicitly marked illustrative.

## Accessibility & Inclusion

No product-specific requirement beyond general WCAG AA, carried forward as a known gap from the 2026-09-30 `/impeccable critique` run on the homepage (missing focus-visible states on the dark hero, sub-AA contrast on disclosure copy, sub-44px touch targets on mobile Architecture pills). Treat as a binding constraint for this and later work rather than reopening it as a new question.
