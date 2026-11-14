---
title: "How to trade tokens on Ethereum, step by step: gas, approvals, slippage and the checks that matter"
description: "How to swap tokens on Ethereum: what you need, why a first swap can take two transactions, what gas is, how to protect yourself from bad prices, and the checks specific to Ethereum tokens."
date: 2026-11-13
---

Ethereum has the most tokens, the deepest liquidity and the highest fees of the networks Aretia covers. Trading a token there is a few steps, and the surprises for beginners are mostly about fees and approvals. This is general education, not financial advice.

## What you need

- **An Ethereum wallet** and its recovery phrase on paper, kept private. The same address works on other EVM networks such as Base, BNB Chain and Polygon, but your balances are separate on each network.
- **ETH for gas.** Gas is the fee for any transaction, paid in ETH even when you trade other tokens. It changes with demand, so the same swap can cost very different amounts on different days. Check the estimate before you confirm.
- **A way to swap:** a decentralised exchange such as Uniswap, an aggregator that compares several, or a wallet with swaps built in.

## How a swap works, and why it can take two transactions

1. Choose the token you pay with and the token you want. The app shows a quote: the amount you receive, the price impact, the fee, and the minimum you will get after slippage.
2. **Approval.** Tokens other than ETH need your permission before a contract can spend them. The first time you swap a token, you may sign an approval and then a swap, which is two transactions and two gas fees. Approve only the amount you need if the app lets you. An "unlimited approval" stays active until you cancel it, so review and revoke old ones.
3. **The swap.** It either completes at your quote or better, or fails and costs only the gas.

## Protecting yourself on the way

- **Slippage limit.** Set the largest price move you accept. A very high setting invites sandwich attacks, where a bot trades around yours to take part of it.
- **Test with a small amount** and swap back a small amount to prove you can exit.
- **Check the token address.** Fake tokens copy real names. Take the address from a source you trust, not from a search result or a message.
- **Check the token itself:** liquidity, age, holders, and whether the contract can mint, pause trading or charge a tax on selling ([the seven checks](/learn/how-to-check-a-token-before-you-swap)).
- **Beware of approvals for things you did not ask for.** A site that asks to spend all of a token is asking for the right to take it.

## Cheaper networks

Layer-2 networks such as Base, and other networks such as Polygon and BNB Chain, have much lower fees and their own tokens. The steps are the same, but you need that network's coin for gas and tokens are not interchangeable between networks.

## Seeing the market first

[Aretia Markets](/wallet) lists Ethereum pools with price, 24-hour volume, transactions, traders and liquidity. On 13 November 2026, about 97% of the active Ethereum pools in Aretia's index held under $100 of liquidity, which is why checking comes before swapping. See [Ethereum markets on Aretia](/chains/ethereum) for the venues and [how the numbers are made](/learn/how-aretia-markets-works) for what is thin.

Most people who trade actively lose money. Read [how people make and lose money in crypto](/learn/how-people-make-and-lose-money-in-crypto) before you start.
