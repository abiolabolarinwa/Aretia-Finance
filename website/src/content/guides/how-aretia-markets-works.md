---
title: "How Aretia Markets works: where the numbers come from and where they are thin"
description: "A plain account of how Aretia builds its token markets from on-chain pool events, which rules it applies, and the limits you should know about before you rely on a number."
date: 2026-11-13
---

Aretia Markets lists tokens from six networks: Solana, Ethereum, BNB Chain, Base, Polygon and Robinhood Chain. This page says how the numbers are made, so you can judge them. It is written to be checked, and it lists what is incomplete.

## Where the data comes from

Aretia runs its own indexer. It reads the events that decentralised exchanges write to each chain: a pool being created, a swap happening, reserves changing. From those it keeps, for each pool, the trades, the liquidity and the statistics over 5 minutes, 1 hour, 6 hours and 24 hours. The Markets page is built from this index first. Where the index does not yet cover a list, the page can fall back to public aggregators, and it says when it does.

The indexer supports pools of Uniswap, PancakeSwap, SushiSwap, Aerodrome, QuickSwap and other venues on the EVM networks, and several venue types on Solana, including Raydium, Orca, Meteora and PumpSwap. Support is not the same as depth: how much of a network's history Aretia holds depends on the nodes it can read from.

## The rules applied to what you see

- **Liquidity floor.** Pools with less than about $100 of liquidity are hidden. A button shows them if you ask.
- **Risky tokens.** "Hide risky tokens" is on by default. It hides pools whose trades are only buys with no sells, which is the pattern of a token nobody can sell, and prices that cannot be trusted.
- **A dash is unknown, never zero.** If a number is not available, the cell shows a dash. A price change with no trade data for its window shows a grey 0.00% with a note.
- **Quiet pools.** If a pool has not traded within a window, that window shows no transactions and no volume. Stored figures from earlier are not carried forward.
- **Fully diluted value, not market cap.** The value shown on an indexed row is the price times the token's total supply read from the chain. It is labelled as fully diluted. It is hidden when the result is not plausible.
- **Price when there is no trade.** A pool with no stored trade shows a price read from its reserves, marked with a tilde (~) and a note.
- **Extreme changes.** A change above 1,000% is shown as "greater than 1,000%" and is kept out of the Gainers list. A change beyond one million percent is treated as unknown, because it comes from a first trade priced from a dust amount.
- **Network totals.** The volume and transaction totals at the top leave out any pool whose daily volume is more than 100 times its liquidity (wash trading or a broken price), and say how many pools they left out. A pool with more than 5,000 trades in a day shows "5,000+" and the totals say they are a floor.
- **Traders.** The traders column counts distinct accounts that received the output of a swap in 24 hours. It is the index's best count, not a count of people.

## How fresh it is

The worker writes a pool's statistics when the pool trades and refreshes reserves in passes. The page reloads its list periodically and, where the live stream is switched on, rows update in place at most once a second each. No update is faster than the chain: a number changes when a block containing the swap has been read.

## What is incomplete, stated plainly

- **Depth varies by network.** Ethereum and Solana have the deepest coverage. BNB Chain and Base are thinner because reading their full history needs a paid node that Aretia does not yet use. Robinhood Chain indexing is new.
- **History is short.** Trades are kept for 14 days. Older charts come from other sources where they exist.
- **Some pools are missing.** Pools created before the indexer started, or in venues not yet supported, may not appear until the indexer reaches them.
- **Not a rating.** Aretia does not say whether a token is a good investment, and a token appearing on Markets is not an endorsement. The "Verified" and "Featured" labels have their own pages explaining what they mean and do not mean.

If you find a number that looks wrong, the most useful report is the token link and what you expected. See also [how to check a token before you swap it](/learn/how-to-check-a-token-before-you-swap) and [what liquidity means](/learn/what-is-liquidity-in-a-token-pool).
