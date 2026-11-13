# Where the Markets chart gets its candles

The TradingView chart on the Markets page and the token pages draws candles from the datafeed in `src/swings/charts/tvDatafeed.ts`, which asks Aretia's endpoint `/api/swings-ohlcv` (`api/_swingsOhlcv.ts`). The chart says which source it is using in a small badge at its top right; hover it for how the numbers were made.

## The order of sources

1. **Aretia's market index** (the Market Indexer's own stored on-chain trades). The datafeed asks it first for a pool it follows (`source=aretia`), with a short head start. A pool quoted in a dollar stablecoin is in dollars as stored. A pool quoted in WETH, WBNB, WSOL or WMATIC is converted to dollars candle by candle (below).
2. **GeckoTerminal**, read once by the server for everybody (with `COINGECKO_API_KEY` set it uses the paid on-chain API, whose allowance is the account's own). Answers are cached; when GeckoTerminal refuses (429) the last good answer, up to 15 minutes old, is served and marked `geckoterminal-stale`.
3. **Aretia's market index again, on the server**, when GeckoTerminal has nothing for the pool (404: a pool a few minutes old) or refuses and nothing was kept.
4. **Candles built in the browser from the Transactions table's trades**, the last resort, for the newest window only. Trades with no price in the unit asked for are skipped, never guessed. The badge says "Built from the latest trades".
5. **A message in the chart area** when no source has candles: "No candles yet for this market…" for a pool that is minutes old, or "No price service answered…" with a Try again button. The chart is told "no data", never given an error, so it carries no red warning icons.

An indexed pool (`source=aretia`) never falls back to an outside service: an outside source must not stand in for what the indexer read from the chain.

## Dollar prices for a WETH-quoted pool

`src/swings/mi/quoteReference.ts` finds the quote token's most liquid followed pool against a dollar stablecoin (for example WETH / USDC on Base) and reads that pool's stored trades. Each candle is priced with the newest reference trade at or before the **end** of that candle, never at today's rate. A reference trade more than two hours older than the candle is too old and the candle is dropped. With no reference pool or no recent reference trade the dollar list is empty (the chart then offers the quote token, or says there is nothing), not invented. The answer carries `unit: "usd-converted"` and `reference: { pool, label, price, at }`: the pool, and the price and time of the newest reference trade used. The badge's hover text shows them.

Approximation to know about: a candle's open, high, low and close share one reference price (the one at its end), so within a candle the dollar range reflects the token's own move, not the quote coin's move inside that period.

## New and rugged pools

- A pool minutes old: GeckoTerminal answers 404 and the index may have only a candle or two; the chart opens with what exists, or the message above, and the first candles appear on their own at the next poll.
- A pool that rugged (price to nearly zero, for example SPACEX / WETH on Base, -100%): candles whose price is zero are dropped, the price scale shows up to 15 decimals (it used to stop at 12, which drew a price of 0.00000000000017 as 0), and when the high is more than a thousand times the low the chart switches to its logarithmic axis so the candles stay readable.

## What each failure looks like

| Situation | What the visitor sees |
|---|---|
| GeckoTerminal 429, index has the pool | Candles from the index, badge "Aretia market index" |
| GeckoTerminal 429, nothing else | Candles from trades if there are any, else "No price service answered" and Try again |
| New pool, no source has trades yet | "No candles yet for this market" |
| Pool followed by the index, index unreachable | "No price service answered" and Try again (no outside source is asked) |

## Live updates (about once a second)

- The chart opens a stream connection for its pool (`liveSource` in the datafeed, `data.aretiafinance.org/stream`, the same stream the Markets rows use). Each price the index writes moves the last candle at once, at most once a second per pool. It carries the pool's dollar price, so it applies to the dollar view of the first token only.
- While the stream delivers, the one-second price poll of DexScreener stays quiet. When the stream is silent for three seconds (switched off, or the pool has not traded), the poll takes over, for index-served pools too, so the last candle still moves.
- A pool's candles (volume, corrections) are re-read every 5 seconds when the index serves them, and every 20 seconds for GeckoTerminal-served pools (its allowance is small).
- Nothing here is faster than the chain: a new price exists only once the worker has read the block with the swap (see market-stream.md).

## Attribution

The chart is TradingView's Advanced Charts library. A visible "Charts by TradingView" link to https://www.tradingview.com/ sits on every chart (`walletTvChart.ts`), beside the library's own logo.
