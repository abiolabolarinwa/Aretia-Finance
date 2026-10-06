# Milestone status

## Direction change (read this first)
The target is now a **standalone, Aretia-owned engine** (direct DEX integrations, Aretia routing, Aretia transaction construction), not an aggregator client. The earlier work (Jupiter and 0x providers, `AretiaRouter` over provider quotes) is kept as **non-core**: benchmarking and migration only. See `ARETIA_SWINGS_ARCHITECTURE_AUDIT.md`.

### Standalone engine: what exists (tests: 261 unit and property, about 50 live read-only)
| Milestone | State |
|---|---|
| 0 Audit | `ARETIA_SWINGS_ARCHITECTURE_AUDIT.md`. Secrets check repeated: nothing sensitive tracked |
| 2 Domain types | `engine/types.ts` (pool, liquidity, route, split, status, snapshots) |
| 5 Solana DEX adapters | **Raydium CPMM** (exact local maths, pools found by the program's own address derivation) and **Meteora DAMM v2** (ACT's real pools; the program itself is the quoter, by simulation). Orca, Meteora DLMM, Raydium AMM v4: not built |
| 6 EVM DEX adapters | **Uniswap V2 (Ethereum, Base), PancakeSwap V2 (BNB), QuickSwap V2 (Polygon)** with exact local maths; **Uniswap V3 (Ethereum, Polygon, Base)** quoted by the venue's own QuoterV2, one- and two-hop. PancakeSwap V3, Curve, Balancer, Aerodrome: not built |
| 7 DEX registry | Built (`ACTIVE/DEGRADED/DISABLED/MAINTENANCE`, removable venues, health-aware, known-pool lists) |
| 8 Indexers | **EVM factory-event indexer** (all four chains, confirmed blocks only, adaptive ranges, plugs into the shared discovery worker). Solana indexer: not built |
| 9 Token discovery | Aretia's own EVM feed runs alongside the third-party feed; first-pool time is the real block timestamp |
| 11 Liquidity engine | In-memory store with block and freshness; pools are read on demand by the providers |
| 12 Price engine | Spot, mid, liquidity-weighted, TWAP from Aretia's own pools |
| 13-15 Routing, optimisation, split | Built for exact-maths pools; deterministic scoring with stored reasons; V2 vs V3 compared per swap; split by replaying legs on evolving pool state (priced, not yet executable atomically) |
| 16-17 Transaction builders, simulation | **EVM V2, EVM V3 (SwapRouter02 multicall) and Solana (Raydium CPMM, Meteora DAMM v2)**: inspectable output, simulated on the real programs before signing |
| 18 Execution engine | Direct routes run through the same once-only, confirm-then-sign, track path as everything else, wired into the Swings screen |
| 22 Swings UI | Direct routes are the default on every chain; the screen labels who priced and built each quote |
| 23 Same-chain swaps | Solana, Ethereum, BNB, Polygon, Base all have a direct path. EVM chains are off until the operator enables them |
| 24 Provider health | Built and wired into every direct provider |
| 26 Security docs | `ARETIA_SWINGS_{SECURITY_MODEL,THREAT_MODEL,AUDIT_READINESS}.md` |

**Operator switches** (no code change): `SWINGS_EVM_CHAINS` enables EVM chains (no third-party key needed); `SWINGS_AGGREGATORS=off` removes Jupiter and 0x from quotes entirely.

**Proven live (read-only, no funds, nothing signed):**
- All four EVM chains: Aretia's V2 maths equals the venue router's own `getAmountsOut`; V3 quotes and Aretia-built `exactInputSingle` / `exactInput` calldata are accepted by the real SwapRouter02 and it pays exactly the quoter's amount (single-hop on Ethereum, Polygon, Base; two-hop on Ethereum and Polygon).
- `DirectEvmProvider` end to end on all four chains: picks the better of V2 and V3, builds, and the real router accepts the transaction.
- Solana: the real Raydium CPMM program accepts the Aretia-built transaction and pays exactly Aretia's local quote; a floor above it is refused. The real Meteora DAMM v2 program accepts Aretia-built swaps into ACT from both USDC (1 USDC buys 196.29 ACT) and SOL (0.01 SOL buys 233.15 ACT) in ACT's real launch pools.
- The EVM indexer decodes real `PairCreated` events: in one window 25 new pairs on Ethereum, about 160 on BNB, about 68 on Base, none on QuickSwap.

**Honest findings from the live runs**
- *Jupiter currently beats Aretia direct for SOL to ACT by about 1.4%.* Jupiter's own transaction passes the same simulation judge, so its number is deliverable. The gap is liquidity Aretia cannot yet read: Jupiter routes SOL to USDC through deep pools on venues not integrated, then USDC to ACT. Raydium CPMM's SOL/USDC pools hold only about $100 each. Until Orca, Meteora DLMM and Raydium AMM v4 are integrated, the aggregator will often win on Solana majors. It can be switched off, at the cost of worse Solana prices.
- *Raydium CPMM is a correct but thin venue for majors.*
- *ACT/USDC holds about 13 USDC of liquidity today* (the launch pools are single-sided at the floor price), so only small trades can fill.
- One first-run live failure of the Solana provider (SOL to USDC) could not be explained and did not recur in 8 later runs. Public RPC rate limits also make the live suite occasionally flaky when run all at once.

### Standalone engine: not built yet
- **Solana majors liquidity:** Orca Whirlpools, Meteora DLMM, Raydium AMM v4; **Solana multi-hop** (SOL to USDC to ACT in one transaction) and a Solana indexer.
- **PancakeSwap V3 (BNB), Curve, Balancer, Aerodrome (Base)**; local concentrated-liquidity maths (V3 and DAMM v2 are quoted by the venues themselves).
- **Atomic split execution** (splits are priced but cannot yet run in one transaction), **buyback execution (19)**.
- **Real signed swaps on any chain.** Everything above is proven by simulation and read-only checks, never by moving funds.
- **Selling ACT directly** was not exercised live (the test wallet holds none); the builder is symmetric and unit-tested.
- Applying the database schema, running discovery against a real database, and the Trade-tab 1% fee decision.

Everything below this line is the earlier aggregator-client record, still accurate for that code.


Last updated after the third pass (everything that was still open and could be built without your keys or funds). "Done" means code, tests, typecheck, lint and build all pass. It does not mean production-ready: see "What is not done".

Checks at this point: `npm test` 168 passing, `npm run test:live` 12 read-only live checks passing, `npm run typecheck` 0 errors, `npm run lint` clean, `npm run build` passes.

| # | Milestone | Status |
|---|---|---|
| 0 | Repository security audit and architecture audit | Done |
| 1 | Testing foundation (Vitest) | Done |
| 2 | Core types (`src/swings/core`) | Done |
| 3 | Sidebar entry "Aretia Swings" | Done (browser-checked, wallet not connected) |
| 4 | `SolanaChainAdapter` | Done (unit-tested; not yet run against a real signed swap) |
| 5 | `SolanaJupiterProvider` | Done (wraps existing `walletSwap.ts`; not yet run against a real swap) |
| 6 | EVM foundation: `EvmWalletAdapter` (EIP-6963), `EvmChainAdapter`, `Evm0xProvider`, `/api/swings-0x` | Built and unit-tested. **Not enabled**: see below |
| 7 | `AretiaRouter` | Done (unit-tested with fake and mock providers) |
| 8 | Database foundation (Supabase schema, repository, service boundary) | Built. **Schema not yet applied to a database** |
| 9 | Token discovery worker (one shape, five chains, GeckoTerminal source) | Built and unit-tested. **Never run against a live database** |
| 10 | Token risk engine | Done (framework; EVM signals are bytecode heuristics) |
| 11 | New Tokens UI | Built. Shows an honest "unavailable" state until the API is configured |
| 12 | Swap UI | Done for Solana same-chain. Other chains show "not enabled yet" |
| 13 | Token registry | Done (as Milestone 8/9 service and schema) |
| 14 | Swap UI polish: four-part review, expiry countdown, alternatives, explicit fallback offer | Done for Solana |
| 15 | ACT integration (fee config and buyback policy) | Policy and config done; execution intentionally not built |
| 16-17 | Multichain UX and cross-chain interfaces | Network picker with honest status done; `crosschain/types.ts` interfaces done; no execution |
| 18 | Security review | Done as a design review (`security-model.md`); not independent |
| 19 | Testing: failure, property and fuzz tests (fast-check) | Done (122 tests). Integration tests for real chains not possible without keys and funds |
| 20 | Observability | Done, session-local |
| 21-22 | Performance and failover | Concurrency, timeouts, circuit breaker, explicit fallback done; no caching added on purpose (quotes must never be served stale) |
| 23 | Analytics | Done, aggregate and address-free, session-local |
| 24 | Final UX polish | Partial: Swap and New Tokens tabs exist; Markets and Activity tabs not built |
| 25 | Production readiness | Document written. **Verdict: not production ready** |
| 26 | Audit preparation | `docs/audit/*` written. Commit not frozen (nothing committed yet) |
| 27 | Final architecture report | Written |

## Milestone 0 findings
- `Wallets/` and `mainnet-deploy-keypair.json` are git-ignored, are not tracked, and appear nowhere in git history. Their contents were not opened.
- `website/.env.local` was untracked **and not ignored** (the old `*.env` rule does not match it). `.gitignore` now ignores `.env`, `.env.*` and keeps `!.env.example`.

## Third pass: what was built
- **EVM in the page:** EIP-6963 wallet discovery and connect, native coin and pasted-address token selection (symbol and decimals read from the contract on a public node, EIP-55 checksum enforced), gas and balance checks, per-chain explorer links. Chains stay **off** until the server lists them (`SWINGS_EVM_CHAINS`) and `ZEROX_API_KEY` is set (`/api/swings-status`).
- **0x trust list filled from 0x's documentation** (AllowanceHolder, one address for all four EVM chains, source and date in the code). Anything else 0x returns is refused. Token-tax data 0x reports is used to block (sell tax 50% or more) or warn.
- **Markets and Activity tabs.** Activity is local to the browser and tied to the wallet address.
- **MEV exposure** shown on the review screen (an estimate and a warning; there is still no protected submission).
- **Risk engine:** "Established" class; Solana concentration now excludes program-controlled accounts; EVM analysis follows proxies to their implementation (found by testing real USDC); optional contract-source verification (Etherscan v2) and 0x tax data.
- **Anonymous analytics sink** (`/api/swings-events`, migration 0002), off unless the server enables it; allow-listed fields only, no addresses or IPs.
- **EIP-55 checksum** verification with a hand-written, vector-tested keccak-256.
- **Dependencies:** `npm audit fix` applied (production advisories 13 to 11). The rest need breaking upgrades of existing wallet packages.
- **CI:** `.github/workflows/website-ci.yml` (tests, typecheck, lint, build, audit report, secret scan) and `codeql.yml` (SAST). Neither has run yet: they run on GitHub after you push.
- **Live read-only checks** (`npm run test:live`) against real Jupiter, GeckoTerminal on all five chains, the public Solana and four EVM nodes. They found two real defects, both fixed (proxy blindness, USDC mislabelled High risk).

## What is still open (cannot be done without you)
- **Real swaps.** No swap has been signed or sent through Swings on any chain. This needs your wallet and funds.
- **0x end to end.** No `ZEROX_API_KEY`, so no 0x quote has ever been fetched. The parser is tested against the documented shape only, and the claim that `transaction.to` is the AllowanceHolder in this flow is from documentation, not observation.
- **Database.** Schemas 0001 and 0002 have not been applied; discovery has never written a row.
- **ACT buyback.** Policy only, disabled, no executor. The economics need your decision and review.
- **Trade-tab 1% fee** still conflicts with the 87 bps model. I did not change production fee behaviour without your decision.
- **Dependency advisories** (11 in production): need major upgrades (`@solana/web3.js` 3.x; `@bonfida/spl-name-service`) that touch the whole existing wallet. Needs its own migration and testing.
- **CI and CodeQL** need a push to GitHub to run.
- **Optional services** untested live: Etherscan source check, 0x tax lookup (no keys).
- **Not built, by design:** protected (private) transaction submission, EVM holder concentration (needs an indexer), bridges and cross-chain execution, Aretia-owned liquidity.

## Files
- Core: `src/swings/core/{types,token,fee,summary}.ts`
- Chains: `src/swings/chains/{solana,evm,evmWallet}.ts`
- Providers: `src/swings/providers/{solanaJupiter,evm0x,mock}.ts`
- Router: `src/swings/router/router.ts`
- Tokens: `src/swings/tokens/{risk,registry,discovery,enrich,supabase}.ts`, `sources/geckoTerminal.ts`
- Live wiring: `src/swings/live.ts`; UI: `src/scripts/walletSwings.ts`; page: `src/pages/wallet/index.astro`
- Server: `api/{swings-0x,swings-tokens,swings-discover}.ts` and their `_` cores
- Schema: `supabase/migrations/0001_token_registry.sql`
- Changed existing files: `walletSwap.ts` (optional `feeBps`), `walletTools.ts` (`splitSwapFee` rate parameter), `walletApp.ts` (view wiring), `.gitignore`

## Next
1. Run a small real Solana swap through Swings with a connected wallet and check it end to end.
2. Apply the schema, set env vars, run discovery, and inspect real rows.
3. Decide the Trade tab fee question and review the buyback execution design.
4. Wire an EVM wallet connection and enable Base first (cheapest to test), once the 0x key and contract addresses exist.
