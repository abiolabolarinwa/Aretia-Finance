---
title: "How many token pools are real? A look at six chains on 13 November 2026"
description: "Most token pools on the big networks hold under $100 and never trade. Here are the numbers from Aretia's own index for Solana, Ethereum, BNB Chain, Base, Polygon and Robinhood Chain, how we measured them, and one mistake we caught on the way."
category: Development
date: 2026-11-13
---

Open any list of "new tokens" and it looks like a market. Look at the pools behind the names and it looks different. Aretia runs its own indexer that reads decentralised-exchange events from six networks, so we can count what is actually there. This is a snapshot from 13 November 2026, with the method, and with the places where the data is thin.

## The short version

- **Most pools are empty shells.** On Ethereum the index tracks about 82,800 active pools. Only about 2,700 of them (3.3%) hold $100 or more of liquidity, and only about 450 traded in the last 24 hours (0.5%).
- **BNB Chain, Base and Polygon tell the same story.** About 4.5% of BNB Chain's active pools hold $100 or more (605 of 13,513). On Base it is 0.6% (112 of 19,369) and on Polygon 0.8% (200 of 24,705).
- **Volume sits in a small number of pools.** Across the pools that hold $100 or more and traded in the last day, 24-hour volume was about $39.8M on Solana, $18.5M on Ethereum, $8.6M on Robinhood Chain, $7.3M on BNB Chain, $0.8M on Base and $35,000 on Polygon.

| Network | Pools counted for volume | 24-hour volume |
|---|---|---|
| Solana | 1,502 | $39.8M |
| Ethereum | 452 | $18.5M |
| Robinhood Chain | 217 | $8.6M |
| BNB Chain | 92 | $7.3M |
| Base | 13 | $0.8M |
| Polygon | 18 | $35,000 |

These are the index's numbers, not the whole market. The index follows the venues it supports, and how much of a network's history it holds depends on the nodes it can read from. Base and Polygon are the thinnest, so their small figures say as much about our coverage as about those networks. Solana is a discovered set (pools of supported venues quoted in SOL, USDC or USDT), which is why every counted pool there has traded.

## How we measured it

1. **Pools** are read from creation and swap events on each chain.
2. **Liquidity** is the dollar value of the quote side of the pool, doubled. Pools under $100 are hidden by default and not counted as markets.
3. **Volume** is the dollar value of swaps in the last 24 hours. We leave out any pool whose daily volume is more than 100 times its liquidity (a sign of wash trading or a broken price) and any pool claiming more than $100 million of liquidity (see below).
4. **Not financial advice, and not a ranking.** A chain with a bigger number is not a better place to invest. These figures describe what the index holds.

## A mistake we caught

Our first run showed Robinhood Chain at $358 million of daily volume, nine times Solana's, on a network that new. It did not look right, so we looked at the pools behind it. Seven Uniswap V4 pools claimed $400 million to $2.2 billion of liquidity, with between two and five traders each and about twenty trades. Uniswap V4 keeps every pool's tokens in one shared contract, so there is no per-pool balance to read, and our index estimates depth from a pool's liquidity setting. A pool of a worthless token can inflate that setting to billions.

We now leave out any pool claiming more than $100 million, and the Robinhood figure dropped from $358 million to $8.6 million. No genuine pool on these networks holds $100 million today. We think saying so is better than hiding the first number: the same effect can inflate a number anywhere, and you should know the filters behind the ones you read. The rule, and where it is applied, is on our page [How Aretia Markets works](/learn/how-aretia-markets-works).

## What this means if you trade

- A token appearing in a list is not evidence that anyone can sell it. Check liquidity first: [how to check a token before you swap](/learn/how-to-check-a-token-before-you-swap).
- Small pools move a lot on small trades. [What liquidity means, with the arithmetic](/learn/what-is-liquidity-in-a-token-pool).
- If a number looks too good, ask what is behind it. We did.

## Limits of this snapshot

One day, one index, six networks. History is kept for 14 days. Some pools are missing because they were created before the indexer started or in venues we do not yet support. If we repeat the measurement we will use the same method, so the numbers can be compared.

*Aretia Finance. Data from Aretia's index, 13 November 2026. If you find a number that looks wrong, tell us with the token link.*
