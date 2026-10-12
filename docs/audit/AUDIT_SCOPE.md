# Audit Scope — Aretia Finance (proposed)

Status: **proposed, not frozen.** No tag has been cut. Before an external audit: merge, run the full checks, tag a commit, give auditors that tag only.

## In scope (Aretia-written)
- `program/act-staking/programs/act-staking/src/lib.rs` (+ `authority_handoff.rs`), its `Anchor.toml`/`Cargo.toml`. (`act-presale` was removed on 2026-10-12 — the presale is cancelled — and is out of scope.)
- `sdk/act-staking`, `sdk/idl/act_staking.json` (IDL must match deployed programs — unverified)
- Operator tooling: `mainnet/*.sh`, `devnet/*.sh`, `scripts/**` (incl. `scripts/devnet-amm`, the AMM/test-token tooling relocated from the presale tree) (key handling, Squads proposals, mint v2)
- `website/api/**` and `website/src/swings/**` (existing, narrower scope: `website/docs/audit/scope.md`)
- `website/supabase/migrations/**`, `.github/workflows/**`

## Out of scope
Third-party programs/services (Token-2022, Squads, Pyth, Jupiter, 0x, DEXs, Supabase, Vercel); the `aretia-wallet` repository (separate scope in that repo).

## Not yet existing / do not audit as if present
Stage Two gated access (staking does not gate anything), project financing, governance (PROTOCOL.md roadmap items).

## Unknown — must be established by an authorised human
Which program IDs are live on which cluster; upgrade authority and holder; mint/freeze/fee authorities and holders; Squads membership/threshold.

## Questions for auditors
1. Can buyers always exit (refund/claim) if the authority is unavailable? (F-15)
2. Is Pyth usage safe (staleness, confidence, feed id, exponent math)? (F-16)
3. Is Token-2022 transfer-fee gross-up (`claim`, `sweep_unsold_act`) correct under fee-rate changes and rounding?
4. Are all PDA seeds/`has_one` constraints sufficient against account substitution?
5. Is operator tooling safe against key leakage and mis-targeted cluster?
