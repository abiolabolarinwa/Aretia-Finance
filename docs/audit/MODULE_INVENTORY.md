# Module Inventory — Aretia Finance

Audit status for every row is **"internal review only / no external audit"** unless stated. Tests column lists what exists, not what is sufficient.

| Module | Responsibility | Public interface | Depends on | Owns | Security sensitivity | Key invariants | Tests | Limitations |
|---|---|---|---|---|---|---|---|---|
| `program/act-staking` | Time-locked ACT stake → deterministic tier | `initialize_config`, `update_tier_config`, `set_paused`, `propose_config_authority`, `accept_config_authority`, `cancel_config_authority`, `stake`, `unstake` | Token-2022 | `StakeConfig`, `UserStake` PDAs, vault | **High** | lock can be extended never shortened; unstake only after `unlock_at`; vault delta used for net amount | `tests/full-suite.mjs` (devnet); 0 Rust tests | F-17, F-18, F-19 |
| `sdk/act-staking` | Typed clients + IDL | exported TS | `@solana/web3.js`, `@solana/spl-token` | — | Medium (builds txs users sign) | IDL equals deployed program (unverified) | none | F-08 |
| `mainnet/`, `devnet/` | Operator shell | scripts | solana CLI | deployer key files outside repo | **Critical** | never run unreviewed | none | F-12, F-13 |
| `scripts/*` | Squads proposals, mint v2, pool launch | node scripts | web3.js, Squads SDK | signer keypair files outside repo | **Critical** | proposals verified before signing (`verify-proposal.mjs`) | none | F-14, F-08 |
| `website/api` | Serverless proxy/data endpoints | HTTP | providers, Supabase | — | High (secrets, abuse) | env injected; auth on cron/accounts | `api/*.test.ts` (Vitest) | see website/docs/audit |
| `website/src/swings` | Swap engine, router, shield, discovery, settlement | TS modules | providers via api | — | **High** (fees, tx construction) | fee wallet pinned; simulation judged before sign | 87 test files under `src/swings`; whole-website suite 1,290 tests pass | F-05 (fixed), F-09, boundary exceptions |
| `website/src/scripts` | UI glue for wallet pages | browser scripts | swings | — | Medium–High | non-custodial: signing delegated to user wallet (inspected) | partial | business logic still in UI scripts (2,108-line `walletSwings.ts`) |
| `website/supabase` | token registry, events | SQL migrations | Supabase | DB schema | Medium | service-role key server-only | `db` tests (PGlite) | never run against prod by this work |
