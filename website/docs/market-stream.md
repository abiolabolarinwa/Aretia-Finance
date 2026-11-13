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

## What it does not do

- It is not faster than the chain: a pool changes when a block with its swap is read (Ethereum about every 12 seconds, BNB 3, Polygon and Base 2, Solana under 1, Robinhood about 0.13 s), and the worker writes in slices, so a row moves when the worker next writes it, not at a fixed one-second beat.
- It does not add or remove rows: a token that becomes new or leaves the list appears on the next refresh.
- One service, one server: restarting it drops the viewers for a few seconds (the page reconnects by itself).
- **Not run against a live server yet.** Tested with a real HTTP server on a local port (`stream.test.ts`) and with the fake chain's data shape only.
