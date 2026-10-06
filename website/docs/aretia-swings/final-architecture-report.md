# ARETIA SWINGS: FINAL ARCHITECTURE REPORT

State: Solana same-chain swap wired into the wallet page; EVM swap path (wallet discovery, 0x provider, approvals, simulation) built but off until the operator enables a chain and no EVM swap has ever been run; discovery, registry and risk engine built and checked live read-only but never written to a database. See `production-readiness.md`.

## 1. Architecture
Swings lives inside the existing web wallet (Astro site, `website/`). Pure TypeScript modules in `src/swings/` hold all logic; `src/scripts/walletSwings.ts` is the only UI; `src/swings/live.ts` is the only place that touches existing wallet code and registers providers.

```
UI (walletSwings.ts)
   -> AretiaRouter (quotes, ranking, build, execute, track)
        -> DexProvider:   SolanaJupiterProvider | Evm0xProvider | MockDexProvider
        -> ChainAdapter:  SolanaChainAdapter | EvmChainAdapter (EvmWalletAdapter)
   -> TokenRegistryService -> TokenRepository (Supabase | in-memory)
        <- TokenDiscoveryWorker <- DiscoverySource (GeckoTerminal) + TokenEnricher (Solana | EVM)
Cross-chain: interfaces only, execution hard-disabled.
```

## 2. Supported chains
Solana (enabled). Ethereum, BNB Chain, Polygon, Base: page, adapters and provider built; **off by default**, switched on per chain by the operator through `SWINGS_EVM_CHAINS` after the steps in `setup.md`. Adding another EVM chain is a `CHAINS` entry plus the provider's per-chain trust list.

## 3. Liquidity providers
Jupiter (Solana, existing integration, wrapped). 0x (EVM, via Aretia's server proxy, API key not yet supplied). A mock provider for tests. Future providers (1inch, ParaSwap, OpenOcean, KyberSwap, direct DEXs) implement `DexProvider`; neither the router nor the UI changes.

## 4. Routing
Concurrent quotes with timeouts; executability filter (fresh, consistent, right tokens and amount, within slippage and impact limits); ranking by expected output, then guaranteed minimum, then fewer legs, then freshness; a circuit breaker that reports skipped providers; a worse fallback is offered with its percentage, never used automatically. Details in `routing.md`.

## 5. Token discovery
One worker shape for all five chains. Source: GeckoTerminal new-pools (defensible pool-creation timestamp). At-least-once with a stored cursor. Records keep when Aretia first saw a token separate from creation and first-pool times. Needs the database and a scheduler to run. Details in `token-discovery.md`.

## 6. Token risk engine
Explainable weighted signals; unavailable signals listed and never guessed; no score when too few signals; statuses New, Unverified, Verified, Elevated, High, Restricted, Not enough data; no "safe". Solana checks authorities, extensions, concentration, liquidity, activity, age. EVM checks owner, proxy, mint/blacklist/pause by bytecode, plus the common signals; taxes and restrictions unavailable.

## 7. Token registry
`chain:address` identity, one record type (`TokenRecord`), validated and merged by `TokenRegistryService` (first detection never moves, on-chain facts beat API text, text cleaned). Postgres schema with RLS and service-role-only access. Reuses the wallet's existing Solana mint identity; no parallel system.

## 8. Transaction execution
Quote -> build -> simulate -> four-part review (swap, network, provider, Aretia) -> explicit confirmation naming the quote -> wallet signs -> broadcast once -> track. No automatic retry; declined signatures may retry, ambiguous failures may not.

## 9. ACT integration
`AretiaBuybackPolicy` (87 bps, ACT, BUYBACK) and per-chain `AretiaChainFeeConfig`, centrally in `core/fee.ts`, disabled, capped at 100 bps, failing closed on missing addresses, shown separately and never deducted silently from output. No executor exists. Existing ACT mint identity is reused. The Trade tab's 1% fee is unchanged pending a decision.

## 10. Security model
`security-model.md` (review table) and `docs/audit/`. Strong points: provider output untrusted and simulated; exact approvals; single execution; no secrets in the browser. Weak points: no MEV protection; EVM taxes undetected; EVM path never run live.

## 11. Cross-chain readiness
`crosschain/types.ts`: `CrossChainProvider`, quote, step and request types, `classifySwap`, and a router that refuses everything. Wormhole NTT is testnet-only.

## 12. Database architecture
`token_registry` (one row per `chain:address`, JSON for pools, metadata, risk) and `discovery_cursors`. Accessed through `TokenRepository`; the UI never sees the database.

## 13. API architecture
`POST /api/swings-0x` (key-holding 0x proxy), `GET /api/swings-tokens` (search and list), `GET /api/swings-discover` (cron-secret protected worker run), plus existing `/api/rpc`. Same pattern as existing functions: pure `_` core, thin handler, injected env and fetch, tested.

## 14. Monitoring
`observability/telemetry.ts`: typed events, redaction, counters, latency percentiles, address-free analytics (swaps, provider performance, route selection, execution time). In memory per session; an optional anonymous sink (`/api/swings-events`) stores allow-listed aggregates when the operator turns it on.

## 15. Known limitations
See `docs/audit/known-risks.md`. In short: EVM unproven end to end, no real swap run yet, no MEV protection, partial EVM risk signals, detection limited by the feed, analytics not persisted, dependency advisories.

## 16. Future roadmap
V2: cross-chain via reviewed bridges, intents, limit orders, DCA. V3: Aretia-owned routing and API, SDK. V4: Aretia Universal as a multichain execution layer. The provider, chain and cross-chain interfaces are the extension points; none of V2 to V4 is implemented.
