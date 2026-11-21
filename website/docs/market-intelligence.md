# Market intelligence: the mood, rising or falling, and busiest venues

Three cards at the top of the all-networks Markets page are worked out by one engine, `src/swings/market/intel/`, from one set of pools. The engine is pure (no network, no clock), so the public endpoint, the worker and the page all use the same formulas.

```
index (mi_pools)  ->  readIntelPools  ->  IntelPool[]  ->  ARF / AMMI / ADV  ->  /api/swings-market?src=intel  ->  the three cards
                                              |
worker (every 5 min)  ->  buildSnapshot  ->  mi_market_snapshots  ->  historyFrom  ->  the history AMMI and ADV growth read
```

## Which pools and tokens count

Every figure uses the same checks (`common.ts`):

| Check | Rule |
| --- | --- |
| Valid price | a USD price above zero |
| Valid change | a change over that very window. A pool that did not trade in the window has none (the index stores no number, never zero), so a stale pool is out |
| Liquidity | at least $1,000 |
| Not new | older than the window (at least 15 minutes). A token younger than the window has no price from before it opened and must not read as "rising" because its first price is above zero |
| Not suspicious | none of: 24-hour volume above 100 times liquidity; 20+ transactions from 10 or fewer accounts; 100+ transactions at an average of 40 or more per account (a bot looping the pool, however many accounts it uses); a few accounts each turning the pool's liquidity over more than 5 times a day (volume / accounts / liquidity). The last rule catches a day-old token that did $220M on $2.7M of liquidity from five accounts, which the first two missed |
| One pool per token | the most liquid pool stands for the token. The same address on two networks is two tokens |
| One entry per pool | the same pool listed twice counts once |

Pools are read from the index: active, not paused, traded in the last 24 hours, liquidity between the floor and $100 million, busiest first, at most 10,000 of them.

## ARF: rising, falling, neutral (`arf.ts`)

For each window (5M, 1H, 6H, 24H) separately: return > +0.5% is rising, < -0.5% falling, otherwise (the threshold included) neutral. Every eligible token is in exactly one group, so rising + falling + neutral = eligible and the three percentages add to 100. Net market breadth = (rising − falling) / eligible × 100. The card shows how many pools were left out and why.

## AMMI: the market mood index (`ammi.ts`)

`AMMI = 0.30 T + 0.25 B + 0.20 V + 0.15 M + 0.10 L`, each part 0 to 100.

| Part | Worked out as |
| --- | --- |
| T trend | `r = ln(1 + change/100)` per eligible token, winsorized at the 2.5th and 97.5th percentile (20+ tokens), liquidity-weighted with weight `min(sqrt(liquidity), cap)` where the cap is the 90th percentile of `sqrt(liquidity)`. `T = 100 · sigmoid(R / 0.05)`. A flat market is exactly 50 |
| B breadth | `100 · (rising + 0.5 · neutral) / eligible` |
| V volume | the 24-hour volume of the eligible pools against the average of the same figure 1 to 7 days ago (stored snapshots, at least 3 days). `V = 100 · sigmoid(ln ratio)`. Normal = 50 |
| M momentum | RSI(14) of the hourly changes of the market index (the liquidity-weighted 1-hour return, stored every hour in snapshots, plus the current hour). Needs 14 |
| L liquidity | `0.6 D + 0.4 S`. D (depth): for each pool the price impact of a $1,000 trade, `s / (liquidity/2 + s)`, mapped from 0% (score 100) to 5% (score 0), weighted by the pool's volume. S (stability): `100 · (1 − CV / 0.25)` of the total liquidity over the last 24 hours (at least 6 samples) |

Labels: 80–100 Very bullish, 65–79 Bullish, 45–64 Neutral, 25–44 Bearish, 0–24 Very bearish.

**What it does when data is missing.** T and B come from the tokens alone. V, M and stability need stored history, which builds up only after the worker has been storing snapshots (stability a few hours, M about 15 hours, V 3 days). Until then:

* with T and B present the index is **provisional**: the parts that exist are used with their weights scaled to add to 1, the card says "Provisional", and each part shows whether it counted and why not (hover);
* with fewer than 20 eligible tokens, or T or B missing, there is **no index**: the card says "Insufficient market data". A score is never made up, and a part that cannot be worked out is shown as "–", not zero.

## ADV: busiest venues (`adv.ts`)

Venue volume is the sum of each eligible pool's 24-hour volume, grouped by venue (protocol and version as the index names it). Share = venue volume / total of **all** venues' eligible volume (not only the four shown), so the shares add to 100. Growth = volume against the same venue's 24-hour volume in the snapshot from about 24 hours ago (within 30 minutes); without one it is "–", not zero. Swaps = the sum of the pools' transaction counts (a floor when a pool traded more than the index keeps). Wash-trading pools are left out and their volume is reported.

**Deduplication.** The index keys every stored swap by chain, pool and transaction (EVM: transaction and log; Solana: signature), so a swap seen twice is one row. The engine counts each pool once.

**Known limit: pool-level volume.** The index reads pools, not whole transactions. A route through several pools counts in each pool it touched, so the figure is pool-level volume, not end-user volume. Unique traders are not shown: the index counts accounts per pool, and one account trading in two pools cannot be told from two.

## Confidence

Each card shows "Data confidence: High / Medium / Low", the number of eligible tokens or pools, and the age of the figure. It is a rule of thumb, **not a statistical probability** (nothing here is calibrated against outcomes):

* AMMI: High when complete and eligible tokens are at least 10% of the pools looked at; Medium when provisional with at least 55% of the weight and 50 tokens; otherwise Low; None without an index.
* ARF: High at 100+ eligible tokens, Medium at 30+, otherwise Low.
* ADV: High at 50+ eligible pools, Medium at 10+, otherwise Low.

Hover the line for the coverage and every limit.

## The stats bar and the venue card are one figure

The stats bar (24-hour volume and transactions, per network and in total) and the busiest-venues card read the same pools, once a minute, through one shared read (`api/_intelPools.ts`), and apply the same checks (`screenVenuePools`). So the bar's total equals the sum of all venues, and the volume each leaves out as wash trading is the same number. Before this the bar counted pools down to $100 of liquidity with one check and the venue card used a stricter set, so the two totals differed.

## Storage and API

* Table `mi_market_snapshots` (migration 0024): per scope (`all` or a network) and time, the inputs of the calculations, a methodology version (a stored row is only read with the formulas it was made with), and the per-venue volumes. Kept 8 days. Written by the worker task `market:intel` every 300 seconds (`MI_INTEL_EVERY_SECONDS`; `MI_INTEL=0` turns it off). The table is on Caddy's public allow-list for reading with the service key.
* `GET /api/swings-market?src=intel&chain=` returns AMMI, ARF for all four windows, ADV, the confidence notes and how much history it had. Kept a minute; an older answer is served while the database is down; a failure is `{ error }`, never a figure.
* Reproducible: the same pools and the same history give the same answer (`computeIntel` is a pure function, tested for it).

## Where this differs from the original specification, and what is not done

* **No external price sources.** "Validate prices against multiple independent sources" is not done: Aretia's index prices come from its own reading of the chains. There is no second source to compare with.
* **The wash-trading checks are heuristics.** They remove the obvious loops, not every one. A pool trading a lot among several dozen accounts still counts. Each card reports the volume it left out, so a reader can see how much was judged.
* **Executable depth** is estimated from pool liquidity with a constant-product formula. For concentrated-liquidity pools the index's liquidity is the quote-token balance, which can overstate usable depth.
* **Per-token seven-day volume** is not stored. V compares the whole eligible universe's 24-hour volume with its own earlier values.
* **USD conversion** uses the index's own references (stablecoins, the chain's coin from its reference pool); there is no second reference to validate against.
* **Cross-chain duplicate representations** (a bridged copy of a token) cannot be recognised from addresses; they count as separate tokens.
* **Networks:** the index covers Solana, Ethereum, Base, BNB Chain, Polygon and Robinhood Chain. The specification also names Arbitrum, Optimism and Avalanche, which Aretia has removed.
* **Single transactions** are not grouped across pools (see pool-level volume).

## Old and new

| | Before | Now |
| --- | --- | --- |
| Universe | up to 300 pools read by the browser | every eligible pool the index holds (up to 10,000), read once on the server |
| Mood | half share of tokens that rose, half the capped average move, weighted by `sqrt(volume)` | AMMI as above |
| Rising or falling | rising and falling shown, neutral not shown (157 tokens, 101 + 14 shown) | three groups that add to the eligible count; four windows; net breadth |
| Venues | sum of the sample's volumes, no wash checks at pool level, no growth, no total | checked pools, share of all venues, growth against 24 hours ago, eligible total |
| History | none | snapshots every 5 minutes |
