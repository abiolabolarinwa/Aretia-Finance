---
title: "How a bonding curve works, with a worked example you can check"
description: "A bonding curve sets a token's price from how much has been sold. This guide shows the arithmetic with real numbers, what happens when the curve fills, and the risks, including that Aretia's own curve is unaudited."
date: 2026-11-13
---

A **bonding curve** is a rule that sets a token's price from how many tokens have been sold. Nobody posts a price and nobody matches buyers with sellers. Buying pushes the price up along the curve; selling pushes it down. Many new tokens start this way, then move into an ordinary trading pool once the curve is full.

## The constant-product version, in numbers

A common curve keeps the product of two stored amounts constant (the same rule as many trading pools). The curve starts with a "virtual" amount of coin and of tokens, which set the starting price. Take simple numbers:

- Start: **30 SOL** and **1,000,000 tokens** held virtually. The product is 30 × 1,000,000 = 30,000,000. The starting price is 30 / 1,000,000 = **0.00003 SOL** per token.
- **Buyer A pays 10 SOL.** The coin side becomes 40, so the token side must fall to 30,000,000 / 40 = 750,000. Buyer A receives **250,000 tokens**. The average price paid was 0.00004 SOL, and the new price is 40 / 750,000 = **0.0000533 SOL**, which is 78% above the start.
- **Buyer B pays 10 SOL.** The coin side becomes 50 and the token side 600,000, so Buyer B receives only **150,000 tokens**. The average price was 0.0000667 and the price is now 50 / 600,000 = **0.0000833 SOL**.

The same 10 SOL bought 250,000 tokens for the first buyer and 150,000 for the second. That is the curve working as designed: earlier buyers get a lower price, and the price depends only on how much has been bought, not on how many people want it.

**Selling goes the other way.** If Buyer A sells all 250,000 back after Buyer B, the token side goes from 600,000 to 850,000 and the coin side falls to 30,000,000 / 850,000 = 35.3, so Buyer A receives about 14.7 SOL for the 10 SOL paid. The gain came from Buyer B's money, and a sale lowers the price for everyone who still holds.

## What happens when the curve fills

Each curve has a target: an amount of coin it is meant to raise. When enough tokens have been sold, the curve closes. The coin raised and the tokens kept back are put into a regular trading pool at the price where the curve stopped, and trading continues there. This step is called graduation. Some designs lock or burn the pool's liquidity tokens so the money cannot be taken out; check whether the one you use does.

## Risks, in plain words

- **Early and late are not equal.** The price rises with every buy, so late buyers need further buyers to come after them to profit. That is true of many tokens and it is why most late buyers lose.
- **Bots buy first.** At launch, automated buyers act within a block. Assume you are not early.
- **Thin curves are cheap to move.** A curve with a small target moves a lot on small trades.
- **A curve is a contract.** If its code has a flaw, money can be lost. Ask who audited it and read the report.
- **The creator's first buy and allocation matter.** Look at what the creator holds.

## Aretia's own curve

Aretia has built a bonding curve for tokens made on its Launch page, on Solana and on Ethereum-style networks. It charges a fee on each trade and moves into a regular pool when full. **It has not been independently audited**, and the review is in progress at the time of writing; Aretia's pages say so wherever it is offered. Treat it as you would any unaudited contract: with money you can afford to lose.

For checks you can run on any token, see [how to check a token before you swap](/learn/how-to-check-a-token-before-you-swap). This guide is general education, not financial advice.
