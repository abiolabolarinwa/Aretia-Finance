# Aretia Market Indexer: final report (2026-10-23)

> **2026-10-30: Optimism, Avalanche and Arbitrum were removed from Aretia Finance** (chains, venues, Arena launchpad, fixtures, environment variables). Mentions below are history and no longer describe the code.


Plain account of what exists, what is proven and how, and what is not. Architecture: [market-indexer-architecture.md](market-indexer-architecture.md).
Operations and environment: [market-indexer.md](market-indexer.md). API: [market-indexer-api.md](market-indexer-api.md).

## 1. Audit result (before building)

Aretia already had a token registry, a discovery worker, a V2-only EVM factory feed, a Solana creation feed for Raydium CPMM and
Orca, a Solana swap decoder, a Launch Box indexer, market lists read from GeckoTerminal, and a TradingView datafeed. Gaps: pools
were not first-class, no EVM swap decoding, prices were floats, no reorg handling, no pipeline from chain to charts, and the
market lists depended on an outside source. The project sits at 11 of the 12 serverless functions Vercel's Hobby plan allows, so
every new route went into `swings-data` (no new function). Details are in the architecture note.

## 2. What was built

A module `website/src/swings/mi/` (and `api/_marketIndexer.ts`), integrated with the existing Market:

- chain registry (eight networks), adapter catalogue with evidence levels, explicit lifecycle with configurable listing rules;
- decimal-safe maths (bigint amounts, fixed-point decimal-string prices, basis-point changes), stats and candles from stored trades only;
- EVM engine (V2 and V3 factories): checkpoints, block-hash reorg detection and rewind, finality depth, range halving, backfill jobs, retries with backoff and node failover, idempotent writes;
- Solana engine (Raydium CPMM, Orca Whirlpools, PumpSwap graduations): finalized transactions only, creation read from creation-only accounts, swaps decoded from the balance changes of each pool's token accounts, per-pool cursors;
- Supabase store and migrations 0017 and 0018; in-memory store for tests;
- Launch Box association (read only; EVM creation verified on chain);
- public read API v1, owner controls with an audit log, scheduled run, chart candles and trades for indexed pools, two new lists in the wallet's Market;
- trade retention, health and lag reporting.

Launch Box was not modified and nothing here creates a Launch Box record.

## 3. Status by claim

Levels: **live-verified** = the real engine ran end to end against a live public node and its output was checked; **fixture-tested**
= the decoders pass on real logs captured from that DEX's contracts; **address-verified** = only the contract address was confirmed
on chain.

### Live-verified (end to end on mainnet, 2026-10-23)

| Adapter | Observed |
|---|---|
| PancakeSwap V2, BNB Chain (first network) | 31 pools, 34 tokens from ~2,400 blocks; 371 real swaps decoded and priced; resume from the checkpoint and a repeated backfill changed nothing |
| Raydium CPMM, Solana | 5 pools, 6 tokens (4 named), 107 real swaps; SOL price read from Orca; second run duplicated nothing |
| Orca Whirlpools, Solana | 3 pools, 3 tokens, 58 real swaps; second run duplicated nothing |
| PumpSwap, Solana (graduations only) | 15 pools, 16 tokens (all named), 413 real swaps; second run duplicated nothing |

### Fixture-tested (decoders proven on real captured logs; the full engine was exercised on a simulated chain, not on that network)

PancakeSwap V2: Ethereum, Base. PancakeSwap V3: BNB, Ethereum, Base, Arbitrum. Uniswap V2: Ethereum, Base. Uniswap V3: Ethereum,
Polygon, Base, Arbitrum, Optimism, Avalanche, BNB. SushiSwap V2: Ethereum, Polygon, Base, Arbitrum.

### Address-verified only

PancakeSwap V2 Arbitrum (no recent swap to capture). ApeSwap V2 on BNB Chain, Polygon, Arbitrum and Ethereum: the factory addresses
were confirmed on chain (each answers `allPairsLength()` and its first pair is named "ApeSwapFinance LPs"); ApeSwap's own documentation
page could not be fetched, so the addresses are not confirmed from official documentation. On BNB Chain and Polygon a real ApeSwap swap decodes; no creation log was
captured, so they stay at this level.

### Not built

- Solana: Meteora DAMM v2, DLMM and Dynamic Bonding Curve (no creation-only account is known; needs a streaming provider or a full program scan). PumpSwap pools created directly rather than by graduation.
- DEX/network pairs not in the catalogue were not claimed: for example PancakeSwap on Polygon, Optimism or Avalanche, Uniswap V2 on chains other than Ethereum and Base, SushiSwap V3, ApeSwap on Base, Optimism or Avalanche.
- Market capitalisation and fully diluted value (no reliable on-chain rule applied; the API does not return them).
- Websocket streaming (deliberately: polling with a checkpoint is the verified path).
- A block-range backfill for Solana adapters.
- Programmatic access keys for the API (it is open and rate limited).

### Network summary

| Network | Indexed DEXs | Highest evidence |
|---|---|---|
| BNB Chain | PancakeSwap V2 (live), PancakeSwap V3, Uniswap V3, ApeSwap V2 | live-verified |
| Solana | Raydium CPMM, Orca Whirlpools, PumpSwap (graduations) | live-verified |
| Ethereum | PancakeSwap V2/V3, Uniswap V2/V3, SushiSwap V2, ApeSwap V2 | fixture-tested |
| Base | PancakeSwap V2/V3, Uniswap V2/V3, SushiSwap V2 | fixture-tested |
| Polygon | Uniswap V3, SushiSwap V2, ApeSwap V2 | fixture-tested |
| Arbitrum | PancakeSwap V3, Uniswap V3, SushiSwap V2 (PancakeSwap V2, ApeSwap V2 address only) | fixture-tested |
| Optimism | Uniswap V3 | fixture-tested |
| Avalanche | Uniswap V3 | fixture-tested |

By default only `pancakeswap-v2-bnb` runs. Anything else is switched on by name (`MI_ADAPTERS`) once an operator has a node plan that can carry it.

## 4. Done-means checklist

| Requirement | Result |
|---|---|
| A token and pool created on a supported external DEX are discovered automatically | Yes on BNB Chain and Solana (live); other EVM chains on a simulated chain only |
| Real swaps update market data and the chart | Yes: stored trades feed stats and `GET /api/swings-ohlcv?source=aretia`, which the TradingView datafeed uses for indexed pools (tested; **not seen in a running app**, see risks) |
| An Aretia Launch Box token is recognised without duplication | Tested with fakes and Launch Box's own decoder for the on-chain check; **not run against real Launch Box rows** |
| Multiple pools link to one token record | Yes (tested; one token key, many pools) |
| A worker restart loses or duplicates nothing | Yes (tests: crash before the checkpoint, rerun of the same range, downtime recovery, repeated live runs) |
| Every claimed DEX/network has its own test evidence | Yes, at the level in section 3; address-verified entries are labelled as such |
| The first network is demonstrated before others are called supported | BNB Chain / PancakeSwap V2, then Solana |

## 5. Migrations

`0017_market_indexer.sql` (tokens, pools, trades, checkpoints, block hashes, health, controls, audit, jobs, two functions) and
`0018_market_indexer_solana.sql` (vault columns, pool kinds). Both run cleanly on a real Postgres engine in the tests (PGlite),
including row-level security (no ordinary role can read) and the reorg/job functions. **They have not been applied to Aretia's own Supabase project.**

## 6. Files changed

New: `website/src/swings/mi/**` (engine, Solana engine, decoders, store, API, runner, tests, fixtures), `website/api/_marketIndexer.ts`
and its test, `supabase/migrations/0017*.sql` and `0018*.sql`, `supabase/cron/market-indexer-every-minute.sql`,
`scripts/capture-mi-fixtures.mjs`, the four docs. Modified: `api/swings-data.ts`, `api/_swingsOhlcv.ts`, `api/_adminStats.ts`
(owner check extracted, behaviour unchanged), `vercel.json` (rewrites), `functions/api/[[path]].ts` (edge cache for `/api/v1`),
`src/swings/charts/tvDatafeed.ts`, `src/swings/charts/trades.ts`, `src/swings/market/types.ts`,
`src/scripts/walletSwings.ts`, `walletTvChart.ts`, `walletTxTable.ts`, `src/lib/featured.ts` and `src/data/featured.ts` (import
extensions only), `.gitleaks.toml` (public-address fixtures), `src/swings/db/migrate.test.ts` (migration list).

## 7. Test results

Full suite on Windows: 2,932 passed, 29 skipped, 2 failed. The two failures are `feeKeyMonitor.test.ts` and `cloudflare-config.test.ts`,
which fail on CRLF line endings only (they pass in CI on Linux). `eslint .`: clean. `astro check`: 0 errors. `tsc -p tsconfig.api.json`: clean.
Live runs: `npm run test:live` (`src/swings/mi/engine.live.ts`, `solana/engine.live.ts`, `solana/accounts.live.ts`) need the network
and are not part of `npm test`.

## 8. Environment variables and deployment

See [market-indexer.md](market-indexer.md). In short: apply the two migrations, set `CRON_SECRET`, optionally a dedicated node
(`MI_RPC_<CHAIN>`, `SOLANA_RPC_URL`), schedule `supabase/cron/market-indexer-every-minute.sql`, check `GET /api/v1/status`.

## 9. Provider cost (estimates, not quotes)

An EVM adapter following ~200 pools, run every minute: roughly 25 to 60 JSON-RPC calls a minute, about 35,000 to 85,000 a day.
A Solana adapter following ~80 pools: about one signature-list call per pool plus one transaction fetch per new swap, so the call
volume follows trading activity: on the live runs 30 to 70 calls for a run that decoded 100 to 400 swaps. Public nodes are free
but throttle (the BNB run needed ~150 s for 2,400 blocks), so a dedicated node plan is needed for lag to stay small on busy
chains; its price depends on the provider and plan and should be checked against the provider's current price sheet. Supabase:
tens of thousands of trade rows a day for a busy adapter (a few hundred bytes each), bounded by 30-day retention. None of this was
measured over a month.

## 10. Outstanding risks

1. **Not run against Aretia's Supabase or the deployed site.** The store is tested by request shape and by running the migration on PGlite, never against the real project. The first production run may expose differences (permissions, PostgREST limits).
2. **The new Market lists and the chart for indexed pools were not seen in a running browser.** They are covered by unit tests and a type check only.
3. **Public nodes.** They throttle and sometimes lag; catch-up after downtime can take many runs. Swap following is capped (100 newest + 100 recently traded pools per EVM adapter, ~80 per Solana adapter), so an older pool that revives is picked up only when it falls inside those sets.
4. **PumpSwap discovery** relies on an account found by observation, not documentation, and covers graduations only. Pump may change its migration path.
5. **Rate limiting** is per server instance (like the rest of the project), not global.
6. **Trending safeguards are heuristics.** On EVM the "account" is a swap's recipient, which a router can make identical for many users, so the distinct-account guard is weaker than it sounds. Wash trading with many accounts is not detected.
7. **V3 and concentrated-liquidity liquidity** is the quote-token balance held, which can overstate usable depth.
8. **Dollar figures** exist for dollar-stablecoin quotes and for native-coin quotes via a reference pool read from the chain (V2 pair, V3 slot, or Orca's SOL/USDC whirlpool); where that read fails they are `null`.
9. **Fee-on-transfer and rebasing tokens**: amounts are the pool's own, which is right for price but can differ from what a wallet sent.
10. **Admin jobs**: a backfill job whose worker died stays `running` until `requeue-job`.
11. **ApeSwap addresses** are confirmed on chain, not from official documentation.
12. Token names and symbols are untrusted chain text: control, zero-width and bidirectional characters are stripped, offensive names are hidden, lookalike and impersonating names are flagged. The browser draws them as text, never markup.
