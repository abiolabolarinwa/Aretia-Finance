---
title: "How to trade Solana tokens, step by step: wallet, SOL, swap, and what to check"
description: "How to swap tokens on Solana: what you need first, how a swap works through an aggregator, why a token account costs a little SOL, and the checks that matter most on Solana."
date: 2026-11-13
---

Solana is fast and cheap to use, which is why thousands of new tokens appear there every day, and why most of them are worthless. This guide covers the mechanics of trading a Solana token and the checks that are specific to Solana. It is general education, not financial advice.

## What you need

- **A Solana wallet** and its recovery phrase, written on paper and kept private.
- **Some SOL.** Every transaction costs a small network fee (the base fee is a fraction of a cent), and you need SOL to receive a new token.
- **A way to swap.** Most Solana swaps go through an aggregator, a service that splits an order across several pools to find a better price. Aretia's wallet uses Jupiter for swaps.

## How a swap works

1. Choose what you pay with (for example SOL or a dollar stablecoin) and the token you want.
2. The aggregator finds a route across pools and shows a quote: the amount you receive, the price impact, the fee and the minimum you will get after slippage.
3. You approve in your wallet. The swap either completes at that price or better, or fails and costs only the network fee.

## Things that are particular to Solana

- **Token accounts.** To hold a token, your wallet creates a small account for it. That costs a little SOL as a deposit (about 0.002 SOL), which you can get back by closing the account when the balance is zero. Do not be surprised by it.
- **Priority fees.** In busy moments you can add an optional tip so a transaction is processed sooner. It is not required for most swaps.
- **Slippage.** New tokens move fast. Set a limit so a bad price cancels the trade instead of filling it. A very high slippage setting invites sandwich bots to take part of your trade.
- **Mint and freeze authority.** On Solana a token's creator may keep the right to create more supply (mint authority) and the right to block a wallet from moving the token (freeze authority). A token where both have been given up cannot be inflated or frozen by its creator. Check this before you buy ([all seven checks](/learn/how-to-check-a-token-before-you-swap)).
- **Launchpad tokens.** Many new tokens start on a bonding curve and move to a regular pool when the curve fills ([how that works](/learn/how-a-bonding-curve-works)). Treat the first minutes as unknown.

## Seeing the market first

[Aretia Markets](/wallet) lists Solana pools from several venues (Raydium, Orca, Meteora, PumpSwap and others) with price, 24-hour volume, transactions, traders and liquidity. Pools with under about $100 of liquidity are hidden by default, and a dash means the data is not available. See [Solana markets on Aretia](/chains/solana) for the venues, and [how the numbers are made](/learn/how-aretia-markets-works) for what is thin.

Most people who trade new tokens lose money. Start with an amount you can lose completely, and read [how people make and lose money in crypto](/learn/how-people-make-and-lose-money-in-crypto).
