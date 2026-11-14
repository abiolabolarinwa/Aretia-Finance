---
title: "How to create a crypto token: what you decide, what it costs, and what to avoid"
description: "What creating a token involves on Solana and Ethereum-style networks: the decisions that matter, the powers you should give up, how a token gets a market, and the legal and trust questions to settle first."
date: 2026-11-13
---

Creating a token takes minutes and a small fee. Making one that anyone should trust, and that has a real market, takes decisions you cannot undo. This guide covers both. It is general education, not legal or financial advice.

## What a token is

A token is an entry in a contract or program on a blockchain that records who owns how many units. On Solana it is an SPL token; on Ethereum, BNB Chain, Base and Polygon it is usually an ERC-20 contract. Creating one means deploying that contract or program with a name, a symbol, a supply and a number of decimals.

## The decisions, in the order they bite

1. **Purpose.** Why does this token exist, in one sentence a stranger would understand? If you cannot write it, wait.
2. **Network.** Fees, tools and audience differ. Solana is cheap and fast; Ethereum has the most liquidity and the highest fees; the others sit between.
3. **Total supply and decimals.** Fixed or not, and how many units. These cannot usually be changed later.
4. **Who holds what at the start.** Every large allocation you keep for yourself is a reason for buyers to hesitate. Say it plainly and consider locking it.
5. **What powers you keep.** Minting more, freezing wallets, pausing trading, changing fees. Each is a power buyers must trust you with. Giving them up (on Solana, revoking the mint and freeze authorities) is the strongest signal you can send, and it is permanent.
6. **Name, symbol and artwork.** Do not copy a known token's name or logo. Impersonation gets tokens flagged and can be illegal.

## Giving the token a market

A token with no pool cannot be bought. You can open a pool yourself by adding the token and a quote asset (SOL, ETH or a stablecoin) to a decentralised exchange and choosing the starting price. Or you can sell along a bonding curve that fills and then moves into a pool ([how that works](/learn/how-a-bonding-curve-works)). Either way, think about:

- **How much liquidity** you add. A pool of a few hundred dollars makes every trade expensive and invites manipulation ([the arithmetic](/learn/what-is-liquidity-in-a-token-pool)).
- **Whether to lock the liquidity,** so buyers can see you cannot take it back.
- **The first minutes:** bots buy at launch. Do not assume early buyers are people.

## The costs

A network fee to create the token, a fee to open a pool, and the money you put into the pool. Aretia Launch lets you create a token and give it a market from one wallet, and shows the fees before you confirm.

## What to settle outside the code

- **Law.** Selling a token to the public can fall under securities, commodities or consumer-protection rules, and the rules differ by country. Ask a lawyer before you promise anyone a return, a share of profits or a role in a business.
- **Honesty.** Never promise price rises, guaranteed returns, or "partnerships" that do not exist. It is the fastest way to lose a community, and in many places to be liable.
- **Taxes and records.** Keep a record of what you created, sold and received.

## Before you launch

Run the same [seven checks](/learn/how-to-check-a-token-before-you-swap) on your own token that a buyer would run, and fix what fails. Aretia does not vouch for any token that appears on its pages, and its "Verified" and "Featured" labels explain what they do and do not mean.
