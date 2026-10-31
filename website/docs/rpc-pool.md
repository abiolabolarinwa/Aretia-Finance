# Aretia RPC Pool

Written 2026-10-31. Server-side code that reads blockchains (the Market Indexer, the Solana RPC proxy at `/api/rpc`) no longer depends on
one free node or on a paid plan. It shares its reads among many free public nodes, with manners. Code: `src/swings/rpc/pool.ts`, the node
lists in `src/swings/rpc/endpoints.ts`.

## What it does

| Part | Effect |
|---|---|
| Spreads load over every node, weighted by speed and health | Every free node's allowance is used, not just the first one's |
| Polite budget per node (requests per second, requests in flight) | A node is never asked faster than it allows; the pool waits instead |
| Cool-down on 429 (its own `Retry-After`, else a growing pause) | A node that said "slow down" is left alone, and the others carry the work |
| Learns per node and per method what it cannot do | A node that refuses `eth_getLogs`, or needs a key for a method, is not asked that again for ten minutes |
| Learns each node's widest `eth_getLogs` range | Wide log ranges go to the nodes that accept them; if none does, the refusal goes back to the caller, which halves the range as before |
| Answers identical requests once | Ten callers asking the same thing at the same moment cost one call |
| Keeps answers that cannot change or barely change | Old blocks, receipts and finished log ranges for minutes; the chain head and the latest blockhash for a second or so |
| Fails over within a time budget | 429, 5xx, timeouts and "try again" move to another node |
| Catch-up cap in the indexer (`maxLagBlocks`) | An adapter that is further behind than about six hours of blocks skips ahead instead of chasing days of history on a slow node; the skipped count is reported in the run |

It stays inside each node's limits. It does not rotate addresses or fake identities to get around anything.

## Measured on the live free nodes (2026-10-31)

60 distinct block reads, all at once, the same nodes with and without the pool:

| Network | One node | Pool | Result |
|---|---|---|---|
| Ethereum | 14.1 s | 3.5 s | 4x faster, load spread over six nodes |
| Base | 14.0 s | 2.6 s | 5x faster, four nodes |
| BNB Chain | 13.8 s | 14.2 s | no gain: the BNB nodes are slow, and one (`bsc-dataseed.binance.org`) timed out |

All requests succeeded in every case. Solana's free capacity is the tightest (see below).

## What it cannot do

- It cannot make free nodes keep more history or take bigger log ranges than they offer. Only some nodes serve wide `eth_getLogs`
  (publicnode, Tenderly, MEV Blocker on Ethereum; publicnode on BNB Chain). If those are the busy ones, the indexer is limited by them.
- It cannot beat the **combined** allowance of the free nodes. It raises the ceiling by using all of them well and by asking less often.
  A paid plan has a higher ceiling and a promise; if the indexer follows many pools on BNB Chain, a paid BNB node may still be worth it.
- Solana has few free nodes that serve indexed reads (the Solana Foundation's, strict; publicnode refuses those; Pocket is slow).
  Cached and shared answers help most there.
- Free nodes change their terms. Re-probe the lists in `endpoints.ts` now and then.

## Using a paid node later

Nothing needs undoing. Set `SOLANA_RPC_URL` or `MI_RPC_<CHAIN>`: that node is added to the pool with a higher weight and a higher
request rate, the free nodes stay behind it as the fallback, and a failing paid node costs the caller nothing.

## Seeing how it is doing

`GET /api/v1/status` carries `rpc`: for each pool in the serving process, every node by host name only (an address can carry a key), its state
(`ok`, `cooling`, `blocked-for-some-methods`), average latency, and counts of answers, refusals and failures. A failing adapter also shows its
`lastError`.

## Settings

| Name | Purpose | Default |
|---|---|---|
| `MI_MAX_LAG_BLOCKS_<CHAIN>` | how far behind an adapter may start a run before it skips ahead | about six hours of blocks |
| `MI_RPC_<CHAIN>`, `SOLANA_RPC_URL` | a configured node, tried first | none |
| `MI_ADDRESS_BATCH_<CHAIN>` | pool addresses per `getLogs` | 10 |

Still reading chains on their own, outside the pool (candidates for a later move): the token-risk checks (`api/_swingsTokens.ts`), referral
verification (`api/_referralVerify.ts`) and the Launch Box readers. The browser keeps its own node lists: each visitor has their own address
and allowance.
