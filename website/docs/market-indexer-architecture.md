# Aretia Market Indexer: repository audit and architecture

Written 2026-10-23 before the build. Everything under "Found" was read in this repository, not assumed.

## Found (what already exists)

| Area | Where | What it does today | Gap for this project |
|---|---|---|---|
| Token registry | `src/swings/tokens/registry.ts`, `supabase.ts`, migration 0001 | `chain:address` keyed tokens, discovery status `discovered`/`tradable`, pools as a JSON column, risk | No pool table, no trades, no lifecycle beyond two states, pools are not first-class |
| Discovery worker | `tokens/discovery.ts` | Cursor + idempotent ingest; `DiscoverySource` interface | Reports tokens, not pools; only the first pool; no reorg handling |
| EVM factory source | `indexer/evmIndexer.ts` | V2 `PairCreated`, confirmed blocks only, range halving | V2 only, no swaps, no block-hash check, no V3 |
| Solana source | `indexer/solanaIndexer.ts` | Decodes pool creation for CPMM and Orca | Not PumpSwap, DAMM v2, DLMM, DBC |
| Swap store | `store/swaps.ts`, `indexer/solanaSwaps.ts` | Solana vault-delta swap decoding, candles from swaps | Uses `number` for prices; no EVM decoder; not wired to a cron |
| Market lists | `api/_swingsMarket.ts`, `market/gecko.ts` | Lists from GeckoTerminal | External source of truth for prices |
| Candles | `api/_swingsOhlcv.ts` (GeckoTerminal), `charts/tvDatafeed.ts` | TradingView datafeed reading `/api/swings-ohlcv` rows `[t,o,h,l,c,v]` | Our own candles can be served in the same row shape |
| Launch Box | `launchbox/*`, migration 0012 | Own indexer, own cursors, `launchbox_tokens` | Owns Aretia launches. **Not modified.** Read only. |
| DEX catalogue | `dex/entries.ts` | Factories/routers/program ids for execution routing | Reused as the source of truth for addresses; ApeSwap missing |
| Cron | `api/launchbox-run` (CRON_SECRET), `supabase/cron/*.sql` | Pattern for Bearer-secret cron endpoints | Reused |
| Admin | `api/_adminStats.ts` | Wallet-session auth, `ADMIN_WALLETS` | Reused for the control actions |
| Limits | `api/_limits.ts`, `_rpcProxy.ts` | In-memory per-instance counters | Reused (per-instance, not global: stated in the API docs) |
| Function cap | `api/_functionCount.test.ts` | 11 of 12 functions used | New routes go through `swings-data.ts`, no new function |

## Decisions

1. **A new module, `src/swings/mi/`, integrated by reuse.** It reads DEX addresses from `dex/entries.ts`, uses `EvmRead`/`readErc20`, `keccak256`, the Supabase REST helper and the Launch Box *read* interface. It does not replace the registry or Launch Box.
2. **Pools and trades are first-class** (`mi_pools`, `mi_trades`); a token record (`mi_tokens`) links to many pools. Keys are `chain:address` for tokens and `chain:pool` for pools, trades are unique on `(chain, pool, tx, log_index)`.
3. **Integer maths everywhere.** Raw token amounts are `bigint`; price is a reduced rational turned into a fixed-point decimal string with explicit rounding. `number` appears only at the chart boundary.
4. **Block-hash chain for reorgs.** Each processed block's hash is stored; the next run compares the stored hash with the node's. A mismatch rewinds and deletes trades above the fork point. Logs are read only from blocks that are `confirmations` deep, so the check is a second line of defence.
5. **Polling is the source of truth.** Cursor per adapter, advanced only after the batch is written. A websocket is not used.
6. **Lifecycle** (Discovered, Validating, Awaiting liquidity, Active, Inactive, Suspended, Unsupported) is a pure state machine with configurable listing rules; transitions are recorded.
7. **External APIs never override chain facts.** GeckoTerminal is not used by the indexer at all; DEX Screener is not used.
8. **Honest support levels.** Each DEX/chain pair carries `evidence`: `live-verified` (run against a real node in this work), `fixture-tested`, `address-verified`, or `planned`. The API and docs print that value.

## Scope boundaries

- Launch Box is not touched. The indexer reads `launchbox_tokens` to *associate* a discovered token with its Launch Box record, never to create one.
- Solana program-level decoding for PumpSwap, Meteora (DAMM v2, DLMM, DBC), Raydium, Orca is a separate adapter family; what is and is not done is in the final report.
