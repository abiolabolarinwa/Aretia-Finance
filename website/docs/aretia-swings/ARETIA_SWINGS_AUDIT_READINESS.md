# ARETIA SWINGS: AUDIT READINESS

**Not ready for an external audit.** This lists what would be handed over, what is missing, and the order to fix it.

## Ready to review now (Aretia-written, tested)
| Area | Files | Evidence |
|---|---|---|
| Constant-product maths (Uniswap V2 and Raydium CPMM roundings) | `engine/amm.ts` | Property tests; V2 equals the venue router bit for bit on four chains; CPMM equals the real program's output |
| Pool store, price engine, health, registry | `engine/{liquidity,price,health,registry}.ts` | Unit tests |
| Routing, scoring, split | `engine/routing.ts` | Unit and property tests; live agreement with the router on Ethereum |
| ABI encoding and calldata | `engine/abi.ts`, `execution/evmV2Builder.ts`, `dex/evmV3.ts` | Selectors checked against known values; round-trip property tests; real routers accept the output |
| EVM venues | `dex/{evmV2,evmV3,evmAerodrome,evmBalancer,evmCurve,directEvm,entries,hubs}.ts` | Live: contracts exist, pairs found, routers accept transactions and pay the quoted amount (V3, PancakeSwap V3, Aerodrome, Balancer, Curve); a 10,000 ETH V3 split is accepted as one multicall |
| Solana venues and routing | `solana/{raydiumCpmm,orcaWhirlpool,meteoraDamm,venues,builder,simulate,directSolana}.ts` | Live: real programs accept the transactions; CPMM pays exactly the local quote; Orca and DAMM v2 accept swaps; direct and two-hop routes are accepted whole; benchmark within 0.15% of Jupiter on five pairs |
| ACT buyback executor (Solana) | `solana/directSolana.ts`, `core/fee.ts`, `router/router.ts` | Unit tests for on, off, fail-closed and aggregator exclusion; one live simulation with a test configuration. Never enabled |
| Indexers | `indexer/{evmIndexer,solanaIndexer}.ts` | Unit tests; live decoding of real factory events on four chains and of real Raydium CPMM pool creations on Solana |
| Database migrations | `db/migrate.ts`, `scripts/apply-migrations.ts`, `supabase/migrations/*.sql` | Applied, re-applied, rolled back, drift-checked and row-level-security-checked on a real Postgres engine (PGlite). Not applied to Aretia's Supabase |
| Keccak and checksums | `core/keccak.ts` | Published vectors |

## Not ready or not built
- Meteora DLMM, Raydium AMM v4 and CLMM, proprietary AMMs (the remaining gap to Jupiter), Meteora DAMM v2 indexing, Balancer stable pools, Curve crypto/lending pools.
- ACT buyback: built for Solana but never enabled and never run with real funds; EVM buyback not built.
- Atomic splits: Solana (unit-tested only) and Uniswap V3 (live-proven). Cross-router EVM splits are not offered.
- **Any real signed swap on any chain.** All evidence is simulation and read-only; nothing has moved funds.
- Local concentrated-liquidity maths (V3 and DAMM v2 rely on the venue's own quoting).
- Outlier-pool warnings in routing; decoded EVM calldata on the review screen.
- The migrations applied to Aretia's Supabase project and discovery run against it; external audit.

## Freeze
The work is committed on branch `aretia-swings` (not yet merged). Before an audit: freeze a commit, run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:live`, then tag the commit and send auditors only that tag.

## Third-party versus Aretia code
Aretia wrote the engine, adapters and builders. Uniswap V2, PancakeSwap V2 and QuickSwap V2 contracts and every token are third-party and were not audited by Aretia. Jupiter and 0x code remains in the repository as non-core benchmarking and migration integrations and is out of scope for the standalone engine.

## Suggested order
1. Run small real swaps (your own wallet, small amounts) on each chain, one at a time, starting with Base and Solana. This is the evidence everything else lacks.
2. Show the decoded EVM calldata on the review screen.
3. Apply the database (`SUPABASE_DB_URL=... npm run db:migrate -- --dry-run`, then without the flag) and run discovery against it.
4. Review and configure the buyback (treasury and executor addresses) on a staging deployment before any real use.
5. Close the last 0.02-0.15% to Jupiter only if it matters: Meteora DLMM and Raydium AMM v4 are the next venues.
