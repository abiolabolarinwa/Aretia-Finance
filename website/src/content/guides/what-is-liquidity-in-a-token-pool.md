---
title: "What liquidity means in a token pool, with the arithmetic"
description: "Why a pool with little money in it moves the price a lot, shown with a worked example you can check yourself."
date: 2026-11-13
---

On a decentralised exchange there is no order book matching buyers with sellers. A token trades against a **pool**: a stored amount of the token and a stored amount of another asset, such as ETH, SOL or a dollar stablecoin. The size of that pool is its **liquidity**. The pool sets the price from the ratio between the two amounts, and every trade changes the ratio.

## A worked example

Take a simple pool that keeps the product of its two amounts constant (the design used by many pools, ignoring fees):

- The pool holds **10 ETH** and **1,000,000 TOKEN**. The price is 10 / 1,000,000 = **0.00001 ETH** per token.
- You buy with **1 ETH**. The pool now holds 11 ETH, so to keep the product at 10,000,000 it must hold 10,000,000 / 11 = 909,091 tokens. You receive 1,000,000 − 909,091 = **90,909 tokens**.
- You paid 1 ETH for 90,909 tokens, so your average price was 0.000011 ETH, which is **10% worse** than the starting price. The price after your trade is 11 / 909,091 = 0.0000121 ETH, **21% higher** than before.

Now take a pool ten times larger (100 ETH and 10,000,000 TOKEN) and the same 1 ETH purchase moves the price by about 2%. The trade did not change, the pool did.

## Why this matters to you

- **Price impact.** A small pool makes every trade expensive, and your own sale moves the price against you on the way out.
- **Exit.** Liquidity is what you sell into. A token you can buy but cannot sell without crashing its price has no real market.
- **Manipulation.** In a tiny pool, a few dollars can make a chart look like a rocket. That is why Aretia Markets hides pools below a small liquidity floor by default.
- **Withdrawal.** The people who added the money can usually take it out. Some projects lock or burn the tokens that represent their share of the pool, which stops that; you can check this on a block explorer or a lock service.

## Two things that look like liquidity and are not

- **Market cap or fully diluted value.** These multiply a price by a supply. They say nothing about how much money is in the pool. A token can show a "valuation" of millions with a pool of a few hundred dollars. Aretia labels its figure a fully diluted value (price times total supply) and never calls it market cap.
- **24-hour volume.** Volume counts trades, not money available. A pool can trade many times its own size in a day, which is a reason for caution rather than comfort. Aretia leaves out pools whose daily volume is more than a hundred times their liquidity from its network totals, because that pattern is wash trading or a broken price.

For the other checks worth making, see [how to check a token before you swap it](/learn/how-to-check-a-token-before-you-swap). This guide is general education, not financial advice.
