# Markets from Aretia's own index

The Markets page lists tokens from Aretia's Market Indexer first. GeckoTerminal is only a fallback and a gap-filler, and every row says which source it came from (beside the token name: "Aretia index, PancakeSwap V2" or "GeckoTerminal").

## Where it comes from

- Read path: `GET /api/swings-market?src=index&kind=&chain=&window=&sort=&dir=&page=&size=&minLiq=&maxAgeHours=` (code: `src/swings/mi/marketList.ts`, handler `api/_swingsMarketIndex.ts`, no new function file).
- It reads `mi_pools` and `mi_tokens` on the data server with a narrow select (a few columns plus five fields picked out of the `stats` document in the database, never the whole document). It answers `{ rows, total, page, size, pages, note, source: 'index' }`; rows have the same shape as GeckoTerminal rows (`MarketRow`).
- Cache: 30 seconds in the function and at Vercel's edge (`s-maxage=30, stale-while-revalidate=600`). If the database fails, the last answer (up to an hour old) is returned marked stale; with none, `rows: []` and `error`, and the page uses its other source.
- Paging: `size` is 50 or 100, any page up to 10,000 rows deep. The chosen size is remembered in this browser (`aretia-market-page-size-v1`).

## Tabs

| Tab | Rows | Order | How it pages |
|---|---|---|---|
| Trending, 24H | pools with a stored trade in 24h | 24h volume | SQL (exact total) |
| Trending, 5M / 1H / 6H | pools with volume in that window | volume in the window | candidates |
| Top | pools with a stored trade in 24h | 24h volume | SQL (exact total) |
| Gainers | up in the window, $1,000+ liquidity, 5+ trades in 24h, older than 10 minutes | change in the window | candidates |
| New | every active pool, including pools with liquidity only | newest first | SQL |
| By liquidity | every active pool, including pools with liquidity only | liquidity | SQL |
| Rising | unchanged (still GeckoTerminal-fed) | | |
| Favourites | unchanged | | |

"Candidates" means the busiest 600 pools by 24h volume are read once, ranked in the function and paged; the total says how many of those qualify and the note says "of the 600 busiest". Column headers for liquidity, volume, age and the change windows sort the whole list on the server; other columns sort only the page on screen.

## Rules for every list

- Only active, unpaused pools. A pool the indexer holds as `awaiting_liquidity` (under its listing floor, $500, or unknown) is not active and is not listed.
- Liquidity must be known in dollars and at least the person's minimum (default $1,000, applied by the server so the totals are right) and never under $50.
- Trending, Top and Gainers need a stored trade. A pool with liquidity only (the indexer's `reservesOnly`) appears in New and By liquidity, with a dash for price, price change, volume and trades. A dash always means unknown, never zero.
- Dropped as dead or unsafe-looking: the price is down 99% or more in 1H, 6H and 24H at once (`isDeadMarket`); 20 or more buys and no sell in 24 hours (nobody could sell: the honeypot pattern); a name the safe-text rules hide.
- One row per token: if a token is in several pools, the best-ranked pool stays. On SQL-paged lists this is applied within each page, so a token may appear again on a far-away page and a page can hold a few rows fewer than its size; the total counts pools.
- The page falls back to GeckoTerminal (merged with the index's newest pools, as before) when the index has fewer than 25 pools for the list or cannot be reached.

## What this does not cover

- Rising still ranks by distinct buyers per window, which needs a per-window count from `mi_trades`. That is not a cheap read through PostgREST, so Rising stays on its current source.
- The list is only as deep as the index. On 8 November 2026 BNB Chain had 211 active pools at any liquidity (about 150 with $1,000+), because most of PancakeSwap V2's pools sit under the indexer's listing floor. Thousands per network needs the indexer to hold more active pools (more adapters, a longer backfill, a lower `MI_MIN_LIQUIDITY_USD`), not a change to this page.
