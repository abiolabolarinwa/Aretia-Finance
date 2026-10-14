# Changelog

Format: Keep a Changelog. Only user-visible, security-relevant or build-relevant changes.

## Unreleased
### Removed
- The repository's on-chain programs, their TypeScript SDKs and IDLs, devnet exercise scripts, the on-chain test crate, design documents and the CI that covered them (the products they supported were cancelled). The last commit containing them is `7f08c9b`. The repository now contains no on-chain programs.
- Website: one page together with its navigation, search and token-page utilities entries (its old URL now redirects, non-permanently, to `/token`); an unreferenced legacy home page; the unused `HomeHero.astro` component (333 lines, imported nowhere, not loaded by any glob). Build output, tests and typecheck unchanged.
### Changed
- Public wording updated to match the removals: `WHITEPAPER.md` (Section 7 now covers trading only; related FAQ entry removed); `WHITEPAPER_TECHNICAL.md` (one section deleted, later sections renumbered and every cross-reference fixed, one precedent sentence and its footnote removed, one Related Work sentence reworded, one legal sentence removed); the website's legacy pages (navigation items, footer links, buttons, roadmap items, and the HTML whitepaper's mirror of the markdown edits); the Help Center; the "1 Oct 2026 update" note in `TOKENOMICS.md`, `PROTOCOL.md` and `MINT_V2.md` (the fee cut 3.5% → 1.5%, the split, the liquidity-share removal and the execution record are unchanged); `website/PRODUCT.md`.
- Swings: Solana primitives (`SWAP_FEE_WALLET`, `KNOWN_TOKENS`, `isSolanaAddress`, `ataAddress`, `TOKEN_PROGRAM_ID`, …) moved from `src/scripts/walletTools.ts` to `src/swings/core/solanaTools.ts`; the old path re-exports them. No value or behaviour change; pinned by `solanaTools.test.ts`.
- CI: `shellcheck` workflow for the operator shell scripts; Dependabot (monthly, human-reviewed) for the five `scripts/*` projects.
- Docs: implementation-status banners on `PROTOCOL.md` and `TOKENOMICS.md`; stale cross-references fixed (`PROTOCOL.md` roadmap section number, `TOKENOMICS.md` mint record link).
- Swings fee: the 0.58% fee now applies to token sales as well (owner decision). `planAretiaFee` no longer takes the paying asset and no longer exempts any token; the fee is taken in the asset being sold. `core/feeAssets.ts` stays only to recognise major assets (Shield). Tests updated first; not yet proven on chain for a sale. Risks recorded in `website/docs/aretia-swings/production-readiness.md`.
- EVM: on wallets that cannot batch, the swap and the fee transfer are simulated (`eth_call` as the taker) after approvals are mined and before the Aretia fee is sent; a revert or an unreachable node sends nothing and takes no fee (F-21).
- Fee wiring: tests that build the web wallet's router and fail if the 0.58% fee is off for any network or provider (`liveFeeWiring.test.ts`); `PUBLIC_ARETIA_EVM_FEE_ADDRESS` documented in `.env.example`; stale "1%" comments on the legacy Trade-tab helper corrected.
- Solana token sales: the quote and the review screen now say when a sale opens the fee wallet's account for the token (one-time rent, about 0.002 SOL, paid by the seller) and when a Token-2022 token keeps part of every transfer, so the fee wallet receives less than 0.58% (F-22, partly). Who bears the rent is still an owner decision.
- Solana token sales (F-22, owner decision): a token other than SOL, USDC or USDT sold for one of them now pays the 0.58% fee from what is received, in that asset, after the swap in the same transaction, so the fee wallet only receives assets it already holds and the seller pays no account rent. Quoted amounts are net of the fee; the swap's on-chain floor is unchanged; the router's amount and slippage checks account for it. Everything else, and EVM, is unchanged. Not proven on chain.

### Moved
- AMM transfer-fee compatibility proofs (Raydium / Orca / Meteora), real-ACT mainnet simulations, devnet test-token setup + JSON and `inspect-fee` → `scripts/devnet-amm` (own manifest, 9 dependencies).
### Security
- `mainnet/gen-deployer.sh` now refuses to overwrite an existing deployer key and creates new keys with `umask 077`.
- `convert-phantom-key.mjs` writes the keypair file with mode 0600.
- CI: `npm audit` for the website is now blocking at `high`; added `projects-ci` for the operator-script projects; added CODEOWNERS, SECURITY.md, PR template, dependabot.
### Notes
- Two functional leftovers remain on purpose and are not product references: the Shield scam-keyword list (it flags phishing sites that use common lure words) and the redirects for the removed pages' old URLs.
