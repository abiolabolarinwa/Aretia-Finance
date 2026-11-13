# Live market stream

The Markets page used to reload its list every 30 seconds. The stream pushes each pool's new numbers to the page as the worker writes them, so the rows on screen move in step with the chain (at most once a second per row).

```
worker  --POST /publish (private network, secret)-->  stream service  --Server-Sent Events /stream?keys=...-->  open Markets pages
```

- **Worker** (`src/swings/mi/stream/publisher.ts`): when `MI_STREAM_URL` and `STREAM_SECRET` are set, every write of a pool's statistics is also announced. Updates are collected for half a second (the newest per pool wins) and sent in one request. If the stream service is down or slow, that batch is dropped and indexing carries on (the log says how many were sent, dropped and failed every ten minutes). The page catches up on its next refresh.
- **Stream service** (`src/swings/mi/stream/`, compose service `stream`, 256 MB limit): holds nothing and reads no database. A viewer names the pools on screen (at most 100) and is sent those pools only, each at most once a second (the newest state waits and replaces older ones, so the last word is never lost). A new viewer is first brought level with the latest update held for each of its pools. Caps: 2,000 viewers, 20 connections per address, 20,000 remembered updates.
- **Caddy** publishes `/stream` only. `/publish` is not routed from the internet and still needs the secret. The service answers only the sites in `STREAM_ORIGINS` (default the production site).
- **The numbers** come from `src/swings/market/liveFields.ts`, the same function the server list uses to build a row, so a row that was just pushed and the same row after a reload cannot disagree (a test builds both and compares them). Name, age, icon and risk are never touched by a live update. A fully diluted value moves with the price, from the row's own supply.

## Turning it on

In `/opt/aretia/server/.env`:

```
STREAM_SECRET=<openssl rand -hex 24>
MI_STREAM_URL=http://stream:8090
```

then `docker compose --profile worker up -d --build worker stream` and `docker compose up -d --force-recreate caddy` (to load the new route). Check `curl https://<data host>/stream?keys=bnb:0x<a pool>` streams (press Ctrl-C), and `docker compose logs stream` shows viewers and updates counted.

## The page

`src/scripts/walletLiveStream.ts` opens one connection for the pools on the Markets table (at most 100), applies each update to its row in place (`updateLiveCells` in `walletMarketTable.ts`: only a cell whose text changed is replaced, and a price that moved flashes green or red), closes while the tab is hidden, and waits longer after each failed connection (3, 6, 12, 30 seconds, then ten minutes after five failures in a row). If the stream is not running the page does nothing different: the list still refreshes every 30 seconds. The address is `https://data.aretiafinance.org/stream`; set `PUBLIC_MARKET_STREAM_URL` at build time to change it. The site's security policy (`vercel.json`, `connect-src`) allows that host.

## Watched pools get priority

The worker normally follows the newest pools and the most recently traded ones of each adapter, and the rest in a slow rotation, so a pool on a Markets page might not be read for hours. To make the rows people are looking at move, the worker asks the stream service (`GET /watched` on the private network, with the secret) which pools are on screen, every two seconds or so, and follows those pools first, on every chain:

- **Solana:** a task of its own (`solana:watched`, a lane of its own so the slow rotation never makes it wait) reads each watched pool's newest swaps and recomputes the statistics of the ones that traded. How often depends on how lively the pool is: one that traded in the last 5 minutes every `MI_WATCH_EVERY_SECONDS` (default 2), one that traded in the last hour every 5 times that, the others every 15 times that (and never faster than every 15 seconds). At most `MI_WATCH_MAX` (default 30) pools per pass. Any Solana venue is followed, not only the ones `MI_ADAPTERS` scans; a venue an administrator disabled is skipped. It reads at `confirmed` (`MI_WATCH_COMMITMENT`, default), 1 to 2 seconds behind the chain instead of about 13.
- **EVM chains:** the watched pools of an adapter are added to the pools its run follows, and while somebody watches one of them that adapter runs every `MI_WATCH_EVERY_SECONDS` instead of every 15 seconds.
- A pool is read only while somebody has it on screen, so a quiet site costs no node calls. A Solana pool read is one `getSignaturesForAddress` call (plus a `getTransaction` per new swap).

### Where the delay comes from

| Step | Delay | Setting |
| --- | --- | --- |
| The chain makes a block final enough | Solana: about 13 s finalized, 1 to 2 s confirmed (watched pools use confirmed) | `MI_WATCH_COMMITMENT` |
| The worker waits for enough blocks on top (EVM reorg safety) | Ethereum 12 blocks (about 2.5 minutes), Polygon 64 (about 2 minutes), Base 10 (about 20 s), BNB 15 (about 7 s), Robinhood 20 (about 5 s) | `MI_CONFIRMATIONS_<CHAIN>` |
| The worker reads the pool | every 2 s for a lively watched pool (Solana), every 2 s run for the adapter (EVM) | `MI_WATCH_EVERY_SECONDS` |
| The stream sends it | at most once a second per pool per viewer | |
| The page draws it | immediately | |

On Ethereum and Polygon the wait for blocks on top is by far the biggest part. Lowering it (for example `MI_CONFIRMATIONS_ETHEREUM=3`, `MI_CONFIRMATIONS_POLYGON=8`) makes those chains much quicker; if a block is replaced the run notices, rewinds the trades it had stored from it and reads them again, so the cost of a lower number is a brief wrong figure, not a lasting one.

## What it does not do

- It is not faster than the chain: a pool changes when a block with its swap is read (Ethereum about every 12 seconds, BNB 3, Polygon and Base 2, Solana under 1, Robinhood about 0.13 s), and the worker writes in slices, so a row moves when the worker next writes it, not at a fixed one-second beat.
- It does not add or remove rows: a token that becomes new or leaves the list appears on the next refresh.
- One service, one server: restarting it drops the viewers for a few seconds (the page reconnects by itself).
- **Not run against a live server yet.** Tested with a real HTTP server on a local port (`stream.test.ts`) and with the fake chain's data shape only.
