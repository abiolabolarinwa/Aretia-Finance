# Milestone status

## Direction change (read this first)
The target is now a **standalone, Aretia-owned engine** (direct DEX integrations, Aretia routing, Aretia transaction construction), not an aggregator client. The earlier work (Jupiter and 0x providers, `AretiaRouter` over provider quotes) is kept as **non-core**: benchmarking and migration only. See `ARETIA_SWINGS_ARCHITECTURE_AUDIT.md`.

### Competing with aggregators: what was added after the first pass
| Area | State |
|---|---|
| Shadow mode | Aretia versus the best aggregator for the same request is recorded anonymously (chain, winner, rival, difference in basis points). Migration 0003 adds the columns and the `swings_shadow_summary` view. The better route is the one executed either way |
| More Solana venues | **Meteora DLMM** (pools derived from the program's own preset list; bin arrays by swap direction), **PumpSwap** (pump.fun's AMM, canonical pools; needed three trailing accounts the on-chain IDL does not list yet, found from real swaps), alongside Orca, Raydium CPMM and DAMM v2. All priced by the program itself and accepted by the real programs in simulation |
| More chains | **Arbitrum, Optimism, Avalanche** (migration 0004 widens the database checks) |
| More EVM venues | SushiSwap V2 (Ethereum, Polygon, Base, Arbitrum), Pangolin and Trader Joe V1 (Avalanche, which names its native-coin calls after AVAX), Velodrome (Optimism), Uniswap V3 on BNB, Arbitrum, Optimism and Avalanche, PancakeSwap V2 and V3 on Ethereum, Base and Arbitrum, more Curve pools. Every entry was run against the real contracts; wrong addresses from memory (Optimism Curve, PancakeSwap on Base and Arbitrum) were caught and fixed that way |
| Safety by default | Before buying a token the swap screen runs the risk engine against the chain and says plainly what was found, what passed and what could not be checked. High-risk and restricted tokens need an explicit acknowledgement. Unchecked signals are never counted as passed |
| Protected sending (Solana) | Optional Jito sending: the tip is inside the transaction the user signs and is paid only if the swap succeeds; a relay (`/api/swings-submit`) refuses anything unsigned, untipped, over the tip cap, or tipped by someone other than the signer. Fail-closed: if the private send fails nothing goes out the public way. Off unless `SWINGS_PROTECTED_SUBMIT=on` |
| Public quote API | `/api/swings-quote`: Aretia's own routing as a read-only API for other apps (route, unsigned transaction, simulation). Off unless `SWINGS_PUBLIC_API=on`, rate limited. Fees and referral splits are **not** built |
| Staged rollout | `SWINGS_CANARY_WALLETS` limits who can review and sign while real swaps are proven (hashes only reach the page). Runbook: `real-swap-runbook.md` |

**Benchmark against Jupiter after these additions (quotes only):** 1 SOL to USDC -0.01%; 100 SOL to USDC 0.00%; 100 USDT to SOL -0.05%; 0.5 SOL to ACT 0.00%; 100 USDC to ACT -0.15%. What remains is liquidity on proprietary AMMs (Kipseli, HumidiFi, Scorch, Manifest and others) that Aretia does not read.

**Not built from the competitive plan, and why**
- *Real swaps and the external audit:* they need your wallet, funds and an auditor. See `real-swap-runbook.md`.
- *Raydium AMM v4 and CLMM, Manifest, the proprietary AMMs:* not yet. AMM v4 and CLMM have no on-chain IDL and need their layouts verified against the chain; Manifest is an open order book that needs its own adapter; the proprietary AMMs are largely closed.
- *Uniswap V4, Aerodrome Slipstream, Camelot, Trader Joe Liquidity Book, Maverick, Fluid:* separate interfaces, not yet.
- *Private transactions on EVM:* a page cannot submit a signed EVM transaction to a private relay, because wallets sign and send in one step. The practical option is for the user to add a protected RPC to their wallet; Aretia can only say so.
- *ACT and climate routing:* the buyback and ACT pools are in. A safer path for climate and ESG tokens needs your curated list of which tokens count; the registry's `verified` flag exists for it and discovery never sets it.
- *Limit orders, recurring buys, price alerts, cross-chain:* limit orders and recurring buys need either an on-chain program or a keeper that holds permissions over user funds; both are security-critical and not built. Cross-chain needs bridge integrations.
- *Referral and integrator fees:* a money-moving design that needs your decision and legal review.
- *Making Swings the default swap:* deliberately not done until real swaps have succeeded.

### Standalone engine: what exists (tests: 373 unit and property, about 90 live read-only)
| Milestone | State |
|---|---|
| 0 Audit | `ARETIA_SWINGS_ARCHITECTURE_AUDIT.md`. Secrets check repeated: nothing sensitive tracked |
| 2 Domain types | `engine/types.ts` (pool, liquidity, route, split, status, snapshots) |
| 5 Solana DEX adapters | **Raydium CPMM** (exact local maths, pools found by the program's own address derivation), **Orca Whirlpools** (the 9 tick spacings of the official config, priced by the program itself) and **Meteora DAMM v2** (ACT's real pools, priced by the program itself). Meteora DLMM, Raydium AMM v4, Raydium CLMM and the proprietary AMMs Jupiter uses: not built |
| 5b Solana routing | Direct, **two-hop** (through SOL, USDC or USDT, whole transaction simulated) and **atomic split** between two pools of a pair, all in ONE transaction. Venue interface in `solana/venues.ts` |
| 6 EVM DEX adapters | **Uniswap V2 (Ethereum, Base), PancakeSwap V2 (BNB), QuickSwap V2 (Polygon)** exact local maths; **Uniswap V3 (Ethereum, Polygon, Base)**, **PancakeSwap V3 (BNB)**, **Aerodrome (Base)**, **Balancer V2 (curated weighted pools)** and **Curve (plain stable pools)** priced by the venues themselves |
| 7 DEX registry | Built (`ACTIVE/DEGRADED/DISABLED/MAINTENANCE`, removable venues, health-aware, known-pool lists) |
| 8 Indexers | **EVM factory-event indexer** (four chains, confirmed blocks) and **Solana pool-creation indexer** (Raydium CPMM and Orca, finalized transactions, decoded instruction data). Meteora DAMM v2 is not indexed: no account only creation touches, so it needs a streaming provider |
| 9 Token discovery | Aretia's own EVM and Solana feeds run alongside the third-party feed; first-pool time is the real block timestamp |
| 11 Liquidity engine | In-memory store with block and freshness; pools are read on demand by the providers |
| 12 Price engine | Spot, mid, liquidity-weighted, TWAP from Aretia's own pools |
| 13-15 Routing, optimisation, split | Deterministic scoring with stored reasons; venues compared per swap; **splits execute atomically**: Solana (several swaps, one transaction, each leg with its own on-chain floor) and EVM (Uniswap V3 fee tiers of one pair in one router `multicall`). V2-style splits across routers need a contract and are not offered |
| 16-17 Transaction builders, simulation | EVM V2, V3 (single, path, split), Aerodrome, Balancer, Curve; Solana Raydium CPMM, Orca, Meteora DAMM v2: inspectable output, simulated on the real programs before signing |
| 18 Execution engine | Direct routes run through the same once-only, confirm-then-sign, track path as everything else |
| 19 ACT buyback | **Solana executor built, OFF by default and fail-closed**: an extra swap of 0.87% of the input into ACT, delivered to the configured address, in the SAME transaction (see below). EVM: not built (ACT has no EVM liquidity) |
| 22 Swings UI | Direct routes are the default on every chain; the screen labels who priced and built each quote |
| 23 Same-chain swaps | Solana, Ethereum, BNB, Polygon, Base all have a direct path. EVM chains are off until the operator enables them |
| 24 Provider health | Built and wired into every direct provider |
| 26 Security docs | `ARETIA_SWINGS_{SECURITY_MODEL,THREAT_MODEL,AUDIT_READINESS}.md` |
| DB Migrations | `src/swings/db/migrate.ts` + `npm run db:migrate`. **Validated on a real Postgres engine (PGlite); NOT applied to Aretia's Supabase project** |

**Operator switches** (no code change): `SWINGS_EVM_CHAINS` enables EVM chains (no third-party key needed); `SWINGS_AGGREGATORS=off` removes Jupiter and 0x from quotes entirely.

**Proven live (read-only, no funds, nothing signed or sent):**
- All four EVM chains: Aretia's V2 maths equals the venue router's own `getAmountsOut`; V3, PancakeSwap V3, Aerodrome, Balancer and Curve routers accept Aretia-built transactions and pay the quoted amount.
- **EVM split:** 10,000 ETH to USDC on Uniswap V3 (Ethereum): Aretia split it 50/50 between the 0.05% and 0.3% pools, the real router accepted the two-leg multicall and paid exactly the quoted amount.
- Solana: the real Raydium CPMM, Orca Whirlpool and Meteora DAMM v2 programs accept Aretia-built swaps. Whole routes (direct, two-hop USDC to SOL to ACT) are accepted when simulated from a funded account.
- **Solana buyback:** with a test configuration the router built the user's swap plus an 8,700,000-lamport (0.87% of 1 SOL) swap into ACT for a throwaway address, in one transaction, and the real programs accepted it.
- **Solana indexer:** against mainnet it found real Raydium CPMM pool creations and decoded them (21 tokens in one 6-hour window, with on-chain decimals and real block times).
- The EVM indexer decodes real `PairCreated` events on four chains.

**Benchmark against Jupiter (quotes only, 7 Oct 2026):** Aretia vs Jupiter output: 1 SOL to USDC -0.02%; 100 SOL to USDC -0.08%; 100 USDT to SOL -0.03%; 0.5 SOL to ACT 0.00% (same pool); 100 USDC to ACT -0.15% (Aretia two-hop through Orca and DAMM v2). The earlier 1.4% gap on SOL to ACT is closed. The remaining 0.02-0.15% is liquidity on proprietary AMMs that Jupiter reads and Aretia does not.

**Honest findings from the live runs**
- *Aretia is now within 0.15% of Jupiter on the pairs tested, not ahead of it.* The remaining gap is venues not integrated (Meteora DLMM, Raydium AMM v4 and CLMM, proprietary AMMs).
- *Price impact for program-priced venues is measured, not assumed:* it compares the fill with a trade 1/100th the size priced the same way. (An early version used pool reserves and reported nonsense for Orca; found by the live run and fixed.)
- Even 2,000 SOL to USDC moves Orca's best pool only 7 bps, so a Solana split rarely triggers on majors; it is covered by unit tests with two comparable pools, not by a mainnet case.
- *ACT/USDC holds about 13 USDC of liquidity today* (the launch pools are single-sided at the floor price), so only small trades can fill.
- Public RPC rate limits make the live suite occasionally flaky when run all at once.

### ACT buyback (Solana): how it works and what is still needed
- Rate: 87 bps of the swap's input amount (`planBuyback`, one place). It is **in addition to** the user's amount: the user's swap is never reduced, and the buyback is shown as its own line.
- Mechanism: the router prices a second swap of the same input token into ACT through its own routes (direct, two-hop or split) and puts it in the same transaction, BEFORE the user's swap, with its own on-chain floor. The ACT lands in the associated account of `buybackExecutorAddress`; the user pays that account's rent if it is new.
- Verification before signing: the whole transaction is simulated, the user's spend must equal amount plus buyback, and the simulation must show the ACT arriving at the configured address at no less than the floor. Otherwise the swap is blocked.
- **Off by default** (`DEFAULT_FEE_CONFIG`). Turning it on needs the owner to set `policy.enabled`, `chains.solana.enabled`, a treasury address and `buybackExecutorAddress` in `core/fee.ts` (code review, then deploy). If anything is missing, quotes fail with `config-missing`; nothing falls back to another address.
- Fail-closed rules: while the buyback is on, aggregator routes are rejected (they cannot carry it); a swap that SELLS ACT is not offered (no buyback route); no ACT route means no swap.
- Not decided here (owner's call): whether the Trade tab's existing 1% fee stays, the economics of charging on top of the swap, and whether to buy ACT or burn it.
- EVM: not built. ACT has no EVM liquidity to buy from.

### Standalone engine: not built yet
- **Meteora DLMM, Raydium AMM v4 and CLMM**, proprietary AMMs; local concentrated-liquidity maths (V3, Orca and DAMM v2 are priced by the venues themselves).
- Meteora DAMM v2 pool indexing (needs a streaming provider).
- Balancer V2 stable/composable pools and Curve crypto/lending pools (only plain pools are covered).
- **Real signed swaps on any chain.** Everything above is proven by simulation and read-only checks, never by moving funds.
- **Selling ACT directly** was not exercised live (the test wallet holds none); the builder is symmetric and unit-tested.
- **Applying the database schema** to Aretia's Supabase project (needs the project's database URL, which only the owner holds), running discovery against a real database, and the Trade-tab 1% fee decision.

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
