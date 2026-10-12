# Changelog

Format: Keep a Changelog. Only user-visible, security-relevant or build-relevant changes.

## Unreleased
### Removed
- The repository's on-chain programs, their TypeScript SDKs and IDLs, devnet exercise scripts, the on-chain test crate, design documents and the CI that covered them (the products they supported were cancelled). The last commit containing them is `7f08c9b`. The repository now contains no on-chain programs.
- Website: one page together with its navigation, search and token-page utilities entries (its old URL now redirects, non-permanently, to `/token`); an unreferenced legacy home page; the unused `HomeHero.astro` component (333 lines, imported nowhere, not loaded by any glob). Build output, tests and typecheck unchanged.
### Changed
- Public wording updated to match the removals: `WHITEPAPER.md` (Section 7 now covers trading only; related FAQ entry removed); `WHITEPAPER_TECHNICAL.md` (one section deleted, later sections renumbered and every cross-reference fixed, one precedent sentence and its footnote removed, one Related Work sentence reworded, one legal sentence removed); the website's legacy pages (navigation items, footer links, buttons, roadmap items, and the HTML whitepaper's mirror of the markdown edits); the Help Center; the "1 Oct 2026 update" note in `TOKENOMICS.md`, `PROTOCOL.md` and `MINT_V2.md` (the fee cut 3.5% → 1.5%, the split, the liquidity-share removal and the execution record are unchanged); `website/PRODUCT.md`.
- Swings: Solana primitives (`SWAP_FEE_WALLET`, `KNOWN_TOKENS`, `isSolanaAddress`, `ataAddress`, `TOKEN_PROGRAM_ID`, …) moved from `src/scripts/walletTools.ts` to `src/swings/core/solanaTools.ts`; the old path re-exports them. No value or behaviour change; pinned by `solanaTools.test.ts`.
### Moved
- AMM transfer-fee compatibility proofs (Raydium / Orca / Meteora), real-ACT mainnet simulations, devnet test-token setup + JSON and `inspect-fee` → `scripts/devnet-amm` (own manifest, 9 dependencies).
### Security
- `mainnet/gen-deployer.sh` now refuses to overwrite an existing deployer key and creates new keys with `umask 077`.
- `convert-phantom-key.mjs` writes the keypair file with mode 0600.
- CI: `npm audit` for the website is now blocking at `high`; added `projects-ci` for the operator-script projects; added CODEOWNERS, SECURITY.md, PR template, dependabot.
### Notes
- Two functional leftovers remain on purpose and are not product references: the Shield scam-keyword list (it flags phishing sites that use common lure words) and the redirects for the removed pages' old URLs.
