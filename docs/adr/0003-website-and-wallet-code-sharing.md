# ADR-0003: Website and wallet extension: share code, or keep two implementations? (F-06)
- Status: **proposed. Needs an owner decision; nothing in this ADR has been implemented.**
- Date: 2026-10-12

## Context
`Aretia-Finance/website` (Astro + `src/swings`) and `aretia-wallet` (TS monorepo + MV3 extension) each implement swap routing, chain adapters, Shield/scam checks, SafeSend-adjacent flows and the Aretia swap fee. There is no shared package. They use different stacks (website: `@solana/web3.js` 1.x; wallet: `@solana/kit` plus `web3.js` 1.x, `viem`) and different release channels (Vercel deploy vs extension store).

**Measured drift, not hypothetical.** The same fee is defined independently in each repo:

| | Website | Wallet |
|---|---|---|
| Rate constant | `ARETIA_FEE_BPS = 58` (`website/src/swings/core/fee.ts`) | `ARETIA_FEE_BPS = 29` (`packages/shared/src/aretiaFee.ts`) |
| When charged | only when paying with a network coin, wrapped coin or main stablecoin; **none when selling a token** (`core/feeAssets.ts`) | on every swap, in the asset sold |
| Solana fee wallet | `2tcBrd1J…VoZX2` (`core/solanaTools.ts`) | same address, copied by hand ("Verify against aretiafinance.org before changing") |
| Documented as | `website/docs/aretia-swings/production-readiness.md`: changed 10 Oct 2026 to 0.58% | wallet `docs/solana.md`, `docs/privacy-policy.md`: 0.29% |

The website moved to 0.58% on 10 October 2026; the wallet still states and charges 0.29% on every swap. **I could not tell from the code whether that difference is deliberate.** If it is not, it is exactly the failure this finding warned about, and it affects what users are told and charged.

Other duplication (inspected, not measured line-by-line): Shield checks (`website/src/swings/shield` vs `packages/chains/{ethereum,solana}/src/shield.ts`), Jupiter/Solana swap building, address validation.

## Options
**A. Keep two implementations; add a parity guard.** Define the shared policy values (fee bps, who pays, fee wallets) once in a small committed spec file, and add a test in each repo that fails when its constants differ from the spec. No runtime coupling, no new package.
**B. Extract a shared package** (e.g. `@aretia/swap-policy`) published to a registry or consumed by git reference, covering fee policy, address validation and token lists first; adapters and routing stay separate.
**C. Merge into one monorepo / move `src/swings` into a shared workspace package.** Largest consolidation; one source of truth for routing and Shield.

| | A | B | C |
|---|---|---|---|
| Removes fee/address drift | Detects it (CI fails) | Prevents it | Prevents it |
| Effort / churn | Low | Medium | High |
| Coupling of release cycles | None | Version bumps in both repos | Total |
| Supply-chain surface | None added | New published package to secure | None added, but extension and site share a build |
| Reversible | Yes | Mostly | Hard |
| Reviewable by an external auditor | Yes, small | Yes | Larger scope per audit |

## Recommendation (for the owner to accept or change)
1. **First, decide whether 0.29% (wallet) vs 0.58% / token-sale exemption (website) is intended.** If the wallet should match, that is a behaviour and user-facing-text change in `aretia-wallet` (code, `docs/solana.md`, `docs/privacy-policy.md`, tests) and needs its own review. It is not made by this ADR.
2. **Adopt A now.** It is cheap, reversible and would have caught the drift above. Parity covers fee bps, the fee-charging rule, and fee wallet addresses.
3. **Revisit B** only if a third consumer appears or Shield/token lists keep diverging after A is in place. **Do not do C** unless the team wants to own one release train for site and extension; the stacks and release channels differ, and the gain does not justify the audit-scope growth.

## Consequences
- With A: a fee change requires editing the spec and both repos in the same change window; CI fails in whichever repo is behind. Cross-repo CI needs either the spec vendored in both or a pinned cross-repo reference (a decision for the implementer).
- Without any action: drift continues silently; users of the extension and the website can be charged differently for the same swap.

## Security implications
Fee destinations and rates are funds-sensitive. Whichever option is chosen, address constants must stay byte-identical to the verified values, changed only with owner sign-off, with a test pinning them (the website already has one; the wallet's `aretiaFee.test.ts` should be checked to pin the address too).

## Migration implications
A: add one spec file and one test per repo, no runtime change. B/C: new package or repository restructuring, staged with compatibility re-exports, as in ADR-0002. Nothing here changes any deployed behaviour until the owner decides.

## Open questions for the owner
1. Is the wallet intentionally at 0.29% on all swaps?
2. Is a shared release train for site and extension desirable?
3. Should the verified fee wallet for each chain be recorded in a signed/owned location?
