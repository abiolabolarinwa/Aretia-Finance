# Audit Scope — Aretia Finance (proposed)

Status: **proposed, not frozen.** No tag has been cut. Before an external audit: merge, run the full checks, tag a commit, give auditors that tag only.

## In scope (Aretia-written)
- *(No on-chain programs or SDKs remain in this repository. The earlier ones were removed on 2026-10-12; the last commit containing them is `7f08c9b`.)*
- Operator tooling: `mainnet/*.sh`, `devnet/*.sh`, `scripts/**` (incl. `scripts/devnet-amm`, AMM / test-token tooling) (key handling, Squads proposals, mint v2)
- `website/api/**` and `website/src/swings/**` (existing, narrower scope: `website/docs/audit/scope.md`)
- `website/supabase/migrations/**`, `.github/workflows/**`

## Out of scope
Third-party programs/services (Token-2022, Squads, Pyth, Jupiter, 0x, DEXs, Supabase, Vercel); the `aretia-wallet` repository (separate scope in that repo).

## Not yet existing / do not audit as if present
Gated access tiers, project financing, governance (PROTOCOL.md roadmap items).

## Unknown — must be established by an authorised human
mint/freeze/fee/metadata authorities and holders; Squads membership/threshold. (An on-chain account from the removed programs may still exist on devnet — see RELEASE_VERIFICATION.md.)

## Questions for auditors
1. Is operator tooling safe against key leakage and mis-targeted cluster? (F-12/F-13/F-14)
2. Are the server endpoints safe against abuse and information leakage, and is provider data (quotes, token metadata) handled as untrusted?
3. Is the fee destination and fee maths in `swings/core` safe from silent change? (F-05)
