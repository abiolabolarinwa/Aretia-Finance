---
title: "How to check a token before you swap it"
description: "Seven checks that take a few minutes and filter out most of the avoidable losses: liquidity, age, holders, who can mint or freeze, whether you can sell, buyers against sellers, and a small test trade."
date: 2026-11-13
---

New tokens appear every minute on Solana, Ethereum, BNB Chain, Base, Polygon and other networks. Most are not scams, and most are not worth holding either. These checks do not predict price. They help you avoid the losses that come from things you could have seen in advance. Nothing here is financial advice.

## 1. Liquidity: how much money sits in the pool

A token trades against a pool of money. If the pool holds a few hundred dollars, a single purchase moves the price sharply and you may not be able to sell what you bought without moving it back down. Look at the pool's liquidity in dollars before anything else. As a rough habit, treat pools under a few thousand dollars as places to watch, not to put real money. Our guide on [what liquidity means](/learn/what-is-liquidity-in-a-token-pool) shows the arithmetic.

## 2. Age: how long the pool has existed

A pool that is twenty minutes old has no history. That is not bad or good; it is unknown. Prices in the first hour are dominated by the people who got in first. A grey or empty history is the honest picture, so do not fill it in with hope.

## 3. Holders: who owns the supply

If a handful of wallets hold most of the supply, they can sell into a small pool and the price falls through the floor. Open the token on a block explorer and look at the largest holders. Pools, exchanges and burn addresses appear in that list and are not "whales"; the pool itself should usually be one of the largest.

## 4. Who can change the token

On Solana, check whether the mint authority (the right to create more supply) and the freeze authority (the right to block a wallet from moving the token) have been given up. On EVM networks, look for owner functions that can mint, pause trading or change taxes. A token that still has these powers is not a scam by itself, but you are trusting whoever holds them.

## 5. Can you actually sell it

Some tokens let you buy and block selling, or charge a very large fee when you sell. A pool where every trade is a buy and no one has ever sold is a warning sign. Aretia Markets hides that pattern from its default lists for this reason, and says so on the page.

## 6. Buyers against sellers, and how many different wallets

A burst of buying from three wallets looks like activity but is not demand. Count the distinct traders, not only the number of transactions. A healthy small market has many wallets on both sides.

## 7. A small test trade

Before you commit an amount that matters, swap a small amount and try to swap it back. You learn the real fee, the real price impact and whether the exit works, for the cost of a few cents.

## What Aretia shows, and what it cannot

On every row, [Aretia Markets](/wallet) shows price, 24-hour volume, transactions, traders, liquidity and age. A dash means the data is not available, never zero. A grey 0.00% change means the pool has no trade data for that window yet. Pools with very little liquidity are hidden unless you ask for them. Aretia cannot tell you who owns a token, whether the team is honest, or whether the price will rise or fall. How the numbers are built, and where they are thin, is written out in [how Aretia Markets works](/learn/how-aretia-markets-works).
