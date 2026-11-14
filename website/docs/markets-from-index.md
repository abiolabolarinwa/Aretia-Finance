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
- Trending, Top and Gainers need a stored trade. A pool with liquidity only (the indexer's `reservesOnly`) appears in New and By liquidity, with a dash for price change, volume and trades. Its price is the pool's current price read from the chain (V2: the reserve ratio; V3: the pool's own price), shown with a tilde and a hover note ("Read from the pool's reserves"), and only when the quote token's dollar value is known. It is a state price, not a trade, and never replaces a traded price; market cap stays a dash (it needs the token supply). A dash always means unknown, never zero.
- Dropped as dead or unsafe-looking: the price is down 99% or more in 1H, 6H and 24H at once (`isDeadMarket`); 20 or more buys and no sell in 24 hours (nobody could sell: the honeypot pattern); a name the safe-text rules hide.
- One row per token: if a token is in several pools, the best-ranked pool stays. On SQL-paged lists this is applied within each page, so a token may appear again on a far-away page and a page can hold a few rows fewer than its size; the total counts pools.
- The page falls back to GeckoTerminal (merged with the index's newest pools, as before) when the index has fewer than 25 pools for the list or cannot be reached.

## Market cap and traders columns

- **Mcap is a fully diluted value (FDV), never a market cap.** The index reads each token's total supply from the chain (EVM `totalSupply()`, the Solana mint's supply) with a refresher task, and the list multiplies it by the price shown for the row (traded price, or the `~` reserve price): price x total supply in whole tokens. How much of that supply is circulating is not on the chain, so a true market cap cannot be stated. The cell's hover text says so, and rows carry `capIsFdv`. A value above $1 trillion is not shown (it comes from a price or supply that cannot be trusted). A token whose supply could not be read, or a row with no price, keeps a dash.
- **Traders** is the number of distinct accounts that received the output of a swap in the last 24 hours (the index's `makers24h`). A router or aggregator counts as one wallet, so it is a close count, not an exact one. Pools with no stored trade show a dash.
- **Needs migration 0022** (two columns on `mi_tokens`). Until it is applied the list still works: it asks for the supply once, falls back to a list without it, and does not ask again for five minutes.

## Bullish views (all opt-in and labelled)

The Markets page opens on **Gainers**, and none of its lists is filtered or reordered to look more positive than the data. Three views put rising tokens in front, each saying what it is:

- **Gainers is the first tab shown.** It is the index's own Gainers list (price up in the chosen window, $1,000+ of liquidity, 5+ trades in 24 hours, a pool older than ten minutes), drawn from real pools. Every other tab is one click away.
- **A "Top gainers · 24H" strip** above every list except Gainers: the five biggest 24-hour rises on the chosen network (or on all), with their change, liquidity in the hover text, and the line "Not a recommendation". It is the Gainers list's top five, nothing added or removed. If the index has none it is not shown (never an error).
- **A "Bullish only" checkbox**, off by default, with its rule written under the list while it is on and in its hover text: price up over **both** the last hour and the last 24 hours, with at least 10 trades, 5 wallets (where the source counts them) and $1,000 of liquidity in the last 24 hours. The server applies it (`bullish=1`) to the busiest 600 pools of the chosen network before paging, so it works on every tab and the count it shows is right; the page also applies it to a list that comes from the outside feed. Turning it off shows every token again. The note says how many of the busiest pools fit.

Quality first is the existing default, not a hidden ordering: a minimum liquidity of $1,000 (a visitor who chose a lower bar keeps theirs), "Hide risky tokens" on, and a note saying how many tokens each filter hides.

## The stats bar (24H volume, 24H transactions, latest block)

A three-cell bar sits above the Markets lists, for the chosen network or, with all networks chosen, for every network together. It refreshes every 20 seconds while the page is open, and is simply not shown when the index cannot be reached.

- **24H VOLUME** and **24H TXNS** are sums over the pools the index follows and holds a stored trade for in the last 24 hours (liquidity $100+, listed). They are *the index's* volume and transactions, not the whole market of a network, and the cell's hover text says how many pools it counts. Transactions are buys plus sells.
- **LATEST BLOCK** is the newest block (Solana: slot) the index has seen on the network, with how long ago it saw it. With all networks chosen it lists each network's block, busiest first. It is the index's own view: if a network's adapter is behind or stopped, its block is older, and that is shown.
- Code: `GET /api/swings-market?src=stats` (`api/_swingsMarketStats.ts`, no new function file), numbers built in `src/swings/mi/marketStats.ts`, the bar in `walletSwings.ts`. The answer is kept 30 seconds in the function and at the CDN (an older answer is served, marked stale, if the database fails). Pools with a trade are read 1,000 at a time (up to ten pages).

### What the bar leaves out, and what it can undercount

- **Implausible liquidity.** A pool claiming more than $100 million of liquidity is left out of every list and of these totals (`MAX_PLAUSIBLE_LIQUIDITY_USD`). Uniswap V4 keeps every pool's tokens in one shared contract, so there is no per-pool balance to read and the index estimates depth from the pool's liquidity setting; a pool of a worthless token can inflate that to billions. Seen on Robinhood Chain: seven pools of $400 million to $2.2 billion, each with two traders, about twenty trades and $50 million of volume, which alone made Robinhood's volume look nine times Solana's.

- **Outlier pools are left out.** A pool whose 24-hour volume is more than 100 times its own liquidity is wash trading or a broken price, and one such pool can outweigh a whole network, so it is not summed. The hover text says how many pools were left out and the volume they claimed.
- **A pool's day is read in full, newest trades first.** A pool's 24-hour figures are computed over its newest 5,000 trades of the day (`RECENT_TRADE_LIMIT`), read a page of 1,000 at a time because the database never answers more than 1,000 rows. A pool with more than 5,000 trades is marked `windowCapped`: its transactions show as "5,000+" and the bar's hover text says the totals are a floor. Before this, only the oldest 1,000 trades of the day were read, which left busy pools with a stale price and undercounted volume. Pools refresh as they next trade or are refreshed by the worker.

## What this does not cover

- Rising still ranks by distinct buyers per window, which needs a per-window count from `mi_trades`. That is not a cheap read through PostgREST, so Rising stays on its current source.
- The list is only as deep as the index. On 8 November 2026 BNB Chain had 211 active pools at any liquidity (about 150 with $1,000+), because most of PancakeSwap V2's pools sit under the indexer's listing floor. Thousands per network needs the indexer to hold more active pools (more adapters, a longer backfill, a lower `MI_MIN_LIQUIDITY_USD`), not a change to this page.
