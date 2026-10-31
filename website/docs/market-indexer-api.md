# Aretia Market Indexer: public read API, v1

Base: `https://aretiafinance.org/api/v1`. Read-only, no key, CORS open for `GET`. Everything is derived from trades and pool
state that Aretia's indexer read from the chain itself. No outside price feed is used, and an outside source never overrides an
on-chain fact.

## Conventions

- Every answer is `{ "data": ..., "meta": { "version": "v1", "generatedAt": "...", ... } }`.
- An error is `{ "error": { "code": "bad-limit", "message": "..." } }` with status 400, 404, 429, 501, 503 or 500.
- **Pagination**: `limit` (1 to 100, default 25) and an opaque `cursor`. `meta.nextCursor` is `null` on the last page. Do not
  parse or construct cursors; they can change.
- **Rate limit**: 120 requests a minute per client address (429 with `Retry-After`). The counter is kept per server instance, so
  it is a guard against abuse, not an exact quota.
- **Caching**: answers carry `Cache-Control: public, s-maxage=N` (5 to 15 seconds for market data) and are shared by the CDN.
- **Amounts**: raw token amounts are integer strings. Prices are decimal strings with up to 30 fractional digits (never floats),
  quote token per base token. Dollar values are JSON numbers, present only when the pool's quote is a dollar stablecoin or the
  chain's native-coin reference price could be read from the chain; otherwise `null`. A `null` means *not known*, never zero.
- **Evidence**: every market carries `evidence`: `live-verified` (the adapter ran end to end on a live node), `fixture-tested`
  (decoders pass on real logs captured from that DEX), `address-verified` (the factory address was confirmed on chain) or `planned`.

## Endpoints

| Method and path | What it returns |
|---|---|
| `GET /` | the list of endpoints |
| `GET /status` | chains, DEXs, evidence levels, per-adapter health (`ok`, `stale`, `failing`, `disabled`, `not-running`), lag in blocks |
| `GET /pools/new` | markets, newest first. Filters: `chain`, `dex` (family, for example `pancakeswap`), `state` (comma list, default `active`), `maxAgeHours`, `q` |
| `GET /pools/trending` | ranked markets plus `promoted` (paid placements, never ranked, always labelled) |
| `GET /pools/search?q=` | by symbol, name, token address or pool address. Filters: `chain`, `state` |
| `GET /pools/{chain}/{address}` | one market with numbers recomputed from stored trades, and the token's other markets |
| `GET /pools/{chain}/{address}/trades` | recent trades. `limit` (1 to 200), `before` (unix seconds) |
| `GET /pools/{chain}/{address}/candles` | OHLCV. `tf` = `1m 5m 15m 1h 4h 1d`, `limit` (1 to 1000), `before` |
| `GET /tokens/{chain}/{address}` | a token and every market it is in (several pools link to one token record) |

`chain` is one of `solana, ethereum, base, bnb, polygon, robinhood`. EVM addresses are matched case-insensitively;
Solana addresses are base58 and case-sensitive. A paused market answers 404 and is not listed. `GET /status` lists, per chain and
per DEX, whether it is supported and with what evidence, and under `notIndexed` the Solana programs that are not indexed.

### Market object (abridged)

```json
{
  "id": "bnb:0x...", "chain": "bnb", "address": "0x...", "dex": "pancakeswap", "dexName": "PancakeSwap V2", "kind": "v2",
  "state": "active", "stateReason": "liquidity present and recently active",
  "createdAt": "2026-10-23T20:00:00.000Z", "ageSeconds": 3600,
  "base":  { "address": "0x...", "symbol": "MEME", "name": "Meme", "decimals": 18, "launchbox": null, "nameFlags": [] },
  "quote": { "address": "0x...", "symbol": "WBNB", "decimals": 18, "launchbox": null, "nameFlags": [] },
  "price": { "quote": "0.000000308342448575816902344093", "usd": 0.000228 },
  "changePct": { "m5": 1.2, "h1": -3.4, "h6": null, "h24": 12.5 },
  "volume": { "quote": { "m5": 0, "h1": 4, "h6": 9, "h24": 81 }, "usd": { "m5": 0, "h1": 2400, "h6": 5400, "h24": 48000 } },
  "txns": { "buys": { "h24": 108 }, "sells": { "h24": 58 } },
  "liquidity": { "quote": 121, "usd": 72930 },
  "evidence": "live-verified", "quoteIsDollar": false,
  "links": { "swap": "/wallet#/swap/bnb/0x..." }
}
```

- `changePct` is the change from the price at the start of the window (the last trade at or before it). For a pool younger than a
  window it is measured from the pool's first trade; with a single trade it is `null`.
- `liquidity` is twice the quote-side balance of the pool. For **V3** pools that is the quote token the pool holds, which can
  overstate the depth that is usable at the current price.
- `nameFlags` warns about a token's *name only* (`impersonation` of a well-known symbol, `lookalike-letters`,
  `hidden-offensive`). It is not a rating of the project.
- `links.swap` opens the wallet's swap screen with the token selected. Nothing is executed by the API or by following the link;
  the person reviews and signs inside the wallet.

### Lifecycle states

`discovered` (creation event seen), `validating` (reading facts), `awaiting_liquidity` (the pool exists but holds no, or too
little, liquidity: **not a market yet**), `active`, `inactive` (no trade within the activity window, or liquidity removed),
`suspended` (paused by an administrator), `unsupported` (an unreadable token, or no recognised quote token). A token contract on
its own is never listed. Listing rules (minimum dollar liquidity, activity window) are configuration.

### Trending

Pools are ranked on one-hour dollar volume and trade count, discounted for one-sided flow, one trade dominating volume, few
distinct accounts, and volume far above liquidity. A pool is **not ranked** if it is under 10 minutes old, has fewer than 5
trades in the hour, fewer than 3 distinct accounts in 24 hours, under $1,000 of liquidity, or no known dollar value. The
`account` is the recipient of a swap's output, which a router can make the same for many users; this limits how much the
distinct-account guard can prove. Paid placements ("Featured") are returned only in `data.promoted`, with their label and the
standing note that a placement is not a rating or endorsement.

### Candles

`[unixSeconds, open, high, low, close, volumeInQuote]`, oldest first, one per period that had a trade. Periods with no trade have
no candle (none is invented). `meta.unit` is `usd` only when the quote token is a dollar stablecoin; for a pool quoted in the
native coin the unit is `quote` and history is **not** converted at today's rate.

### Example

```bash
curl 'https://aretiafinance.org/api/v1/pools/new?chain=bnb&limit=10'
curl 'https://aretiafinance.org/api/v1/pools/bnb/0x1483a9b4588ebe99839f20a3e55ddc29e2fdb9c6/candles?tf=5m'
```

## Owner controls (not public)

`POST /api/swings-mi-admin` with the owner's wallet-session `Authorization` header (the same sign-in and `ADMIN_WALLETS`
allow-list as the admin page; anything else gets the 404 of an unknown path). Body `{ "action": ... }`:
`overview`, `disable-adapter` / `enable-adapter` (`adapterId`, `reason`), `pause-pool` / `resume-pool` (`chain`, `pool`, `reason`),
`backfill` (`adapterId`, `fromBlock`, `toBlock`, at most 200,000 blocks), `requeue-job` (`jobId`). Every change appends an entry
(`at`, `actor`, `action`, `target`, `detail`) to the audit log, returned by `overview`.

## Chart source

`GET /api/swings-ohlcv?source=aretia&chain=&pool=&tf=&agg=&before=&limit=&currency=` returns the same candle list the TradingView
chart already reads (`data.attributes.ohlcv_list`, newest first), built from stored trades. The wallet's chart uses it for every
market from the index and asks no outside service for those pools.
