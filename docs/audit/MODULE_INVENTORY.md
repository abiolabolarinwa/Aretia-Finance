# Module Inventory — Aretia Finance

Audit status for every row is **"internal review only / no external audit"** unless stated. Tests column lists what exists, not what is sufficient.

| Module | Responsibility | Public interface | Depends on | Owns | Security sensitivity | Key invariants | Tests | Limitations |
|---|---|---|---|---|---|---|---|---|
| `mainnet/`, `devnet/` | Operator shell | scripts | solana CLI | deployer key files outside repo | **Critical** | never run unreviewed | none | F-12, F-13 |
| `scripts/*` | Squads proposals, mint v2, pool launch | node scripts | web3.js, Squads SDK | signer keypair files outside repo | **Critical** | proposals verified before signing (`verify-proposal.mjs`) | none | F-14, F-08 |
| `website/api` | Serverless proxy/data endpoints | HTTP | providers, Supabase | — | High (secrets, abuse) | env injected; auth on cron/accounts | `api/*.test.ts` (Vitest) | see website/docs/audit |
| `website/src/swings` | Swap engine, router, shield, discovery, settlement | TS modules | providers via api | — | **High** (fees, tx construction) | fee wallet pinned; simulation judged before sign | 87 test files under `src/swings`; whole-website suite 1,290 tests pass | F-05 (fixed), F-09, boundary exceptions |
| `website/src/scripts` | UI glue for wallet pages | browser scripts | swings | — | Medium–High | non-custodial: signing delegated to user wallet (inspected) | partial | business logic still in UI scripts (2,108-line `walletSwings.ts`) |
| `website/supabase` | token registry, events | SQL migrations | Supabase | DB schema | Medium | service-role key server-only | `db` tests (PGlite) | never run against prod by this work |
