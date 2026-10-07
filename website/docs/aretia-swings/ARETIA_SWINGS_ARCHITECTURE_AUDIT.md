# ARETIA SWINGS: ARCHITECTURE AUDIT (Milestone 0, standalone direction)

Date: 2026-10-06. Everything below was read from the repository or checked against live services, not assumed.

## 1. Security pre-check (repeated before this phase)
- `Wallets/` and `mainnet-deploy-keypair.json`: git-ignored (`.gitignore` lines 3 and 8), **not tracked**, **absent from all git history**. Contents were not opened.
- `website/.env.local` is ignored (`.env.*` rule). `.env.example` lists variable names only.
- Nothing sensitive is tracked, so there is no stop condition.

## 2. What exists today

| Area | State | Where |
|---|---|---|
| Wallet | Web wallet page (Astro) that connects the user's own wallet through Wallet Standard (Solana) and EIP-6963 (EVM, built in the previous phase). No keys, no vault. | `public/assets/wallet/wallet.js`, `src/scripts/wallet*.ts`, `src/swings/chains/evmWallet.ts` |
| Sidebar / panes | `data-nav` + `data-pane` + `.wapp[data-view]`. Swings is one pane with Swap, New Tokens, Markets, Activity. | `src/pages/wallet/index.astro`, `walletApp.ts`, `walletSwings.ts` |
| Solana | Mature: holdings, simulate, sign, send, confirm via an allow-listed RPC proxy. Swap path calls **Jupiter** for quotes and instructions. | `walletSend.ts`, `walletSwap.ts`, `api/_rpcProxy.ts` |
| EVM | Wallet discovery, adapter, approvals, public-node reads. Quotes come from **0x** through a server proxy. | `src/swings/chains/`, `providers/evm0x.ts`, `api/_swings0x.ts` |
| Router | `AretiaRouter`: compares *quotes from providers*; never sees pools. | `src/swings/router/router.ts` |
| Token identity | `chain:address`, one `TokenRef`, EIP-55 verified. | `core/token.ts`, `core/keccak.ts` |
| Token registry / discovery / risk | Postgres schema, repository, service, one worker shape for five chains, GeckoTerminal source, on-chain enrichers, explainable risk engine with an "Established" class. | `src/swings/tokens/`, `supabase/migrations/` |
| ACT asset + fee | ACT mint `7Ut5njM9…` (Token-2022, 1.5% transfer fee, mint authority revoked); `AretiaBuybackPolicy` (55 bps) present, **disabled**, no executor. Trade tab still takes 1% (conflict, undecided). | `core/fee.ts`, `walletTools.ts` |
| Tests | Vitest: 168 unit/property/fuzz tests plus 12 read-only live checks. | `*.test.ts`, `*.live.ts` |
| Backend | Vercel functions only (stateless). Database: Supabase schema written, **not applied**. No long-running process, no indexer host. | `api/`, `supabase/` |
| Deployment | Vercel from `main`; CI workflows written, never run. | `vercel.json`, `.github/` |

## 3. The gap between today and the target

The target says Aretia owns discovery, liquidity, pricing, routing, transaction construction and simulation, with DEXs providing liquidity and aggregators providing none of the core. Today it is the opposite:

| Capability | Target | Today |
|---|---|---|
| Route discovery and optimisation | Aretia's, over its own indexed pools | **Jupiter's (Solana) and 0x's (EVM)**; the router only ranks their answers |
| Transaction construction | Aretia's, inspectable | Jupiter returns instructions; 0x returns calldata |
| Liquidity / pool knowledge | Aretia indexes pools and reserves | None |
| Prices | Derived from indexed liquidity | Jupiter / DexScreener / GeckoTerminal |
| Split routing | Aretia's optimiser | Whatever the aggregator returns |
| Token discovery | Aretia's | Partly Aretia's (on-chain enrichment), but the discovery *feed* is GeckoTerminal |

Honest summary: the current build is a well-guarded **aggregator client**. That is exactly the thing the target says must not be the architecture. It stays useful as a benchmark and migration bridge, and must be labelled non-core. Nothing built so far is wasted: identity, registry, risk, execution guards, telemetry, tests and the wallet layer carry over unchanged.

## 4. Feasibility of direct integrations (what is realistic, in what order)

| Venue | What "direct" needs | Difficulty | Verifiable read-only today |
|---|---|---|---|
| Uniswap V2 family (Uniswap V2 on Ethereum, PancakeSwap V2 on BNB, QuickSwap V2 on Polygon) | factory `getPair`, pair `getReserves`, constant-product maths, router calldata | **Low.** Exact local maths, simple calldata | Yes: compare local quote to the router's own `getAmountsOut`, and simulate with `eth_call` |
| Uniswap V3 (Ethereum, Polygon, Base) | pool state, tick data or the on-chain QuoterV2, `exactInput` calldata | Medium. The on-chain quoter gives exact quotes; local concentrated-liquidity maths is more work | Yes (quoter `eth_call`) |
| PancakeSwap V3, Aerodrome, Curve, Balancer | Venue-specific pool and swap mechanisms | Medium to high each | Partly |
| Raydium, Orca, Meteora (Solana) | Parse each protocol's pool accounts (different layouts for CPMM, AMM v4, CLMM, Whirlpools, DLMM), compute swaps locally, encode each program's instruction, manage token accounts and compute budget | **High.** Weeks per venue, with nowhere to hide mistakes in money-moving instructions | Pool reads yes; instructions need devnet/mainnet test funds |
| Indexers (blocks, pools, swaps) | A long-running host with a database and reorg handling | High; needs infrastructure the repo does not have | No |

Consequence: a credible order is EVM V2 first (provable end to end offline and against live nodes), then V3, then Solana venues one at a time, each shipped only after a devnet or small mainnet test.

## 5. Plan and status

| Milestone | Status |
|---|---|
| 0 Audit | This document |
| 1 Testing foundation | Done (Vitest, unit, property, live) |
| 2 Core domain types | **This phase:** pool/liquidity/route/split types in `src/swings/engine/types.ts`. The older provider-world types stay until migrated |
| 3 Chain engine | Partial (Solana and EVM adapters exist for balances, signing, status). Capability matrix to follow |
| 4 Wallet adapters | Done for Solana and EIP-6963 |
| 5 Solana DEX adapters | **Not started.** Needs the account-layout work above |
| 6 EVM DEX adapters | **This phase:** direct V2 adapter (Uniswap V2, PancakeSwap V2, QuickSwap V2) |
| 7 DEX registry | **This phase** |
| 8 Indexers | Not started (needs a host); this phase reads pools on demand |
| 9–10 Discovery, registry | Existing pipeline (GeckoTerminal-fed); an Aretia-owned feed depends on indexers |
| 11–12 Liquidity and price engines | **This phase:** pool store with freshness, spot / mid / liquidity-weighted price |
| 13–15 Routing V1, optimisation, split routing | **This phase** over locally simulable pools |
| 16–17 Transaction builder, simulation | **This phase for EVM V2** (inspectable calldata, `eth_call` simulation) |
| 18 Execution engine | Existing router guards cover execution; direct-route execution not yet wired into the UI |
| 19 Buyback | Policy only, disabled |
| 20 Risk engine | Done (EVM and Solana signals) |
| 24 Provider health | **This phase** |
| 25 Observability | Done (telemetry); indexer metrics wait for indexers |
| 26–27 Security docs, readiness | Updated at the end of this phase; **not production ready** |

## 6. Rules for the existing aggregator code
`providers/solanaJupiter.ts`, `providers/evm0x.ts`, `src/swings/live.ts` wiring and `/api/swings-0x` are **non-core**: benchmarking and migration only. They are marked as such in their headers. Production routing must not require them. They remain off the critical path of every new module.

## 7. Risks to name now
- Direct integration moves the correctness burden onto Aretia: wrong maths, a wrong router address or a wrong calldata layout can lose user funds. Every adapter therefore needs (a) maths compared with the venue's own on-chain quote, (b) calldata simulated against the real router, (c) addresses verified on-chain before use.
- Indexing without a host is on-demand reading, which is slower and rate-limited by public nodes.
- Solana direct execution is the largest risk and the largest piece of work; it should not be rushed.

## 8. Update after the second implementation pass
The gap in section 3 has narrowed on every chain. Direct paths now exist for Solana (Raydium CPMM, Meteora DAMM v2 including ACT's own pools) and for the four EVM chains (V2 on all four, V3 on Ethereum, Polygon and Base), each proven by simulation against the real programs. See `milestone-status.md` for the exact state and the honest findings (notably that Jupiter still wins SOL to ACT today because of liquidity on venues not yet integrated). The aggregators are non-core and can be switched off by the operator (`SWINGS_AGGREGATORS=off`).
