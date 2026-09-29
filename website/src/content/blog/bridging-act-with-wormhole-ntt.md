---
title: Bridging ACT with Wormhole NTT, on testnet
description: What Aretia Universal does today, how the hub-and-spoke design works, and why an EVM transfer asks you to sign twice.
category: Interoperability
date: 2026-09-29
---

Aretia Universal moves ACT between Solana and Ethereum. It runs on testnet today: Solana devnet to Ethereum Sepolia. Here is how it works, and what is still left before mainnet.

## Hub and spoke

We use **Wormhole Native Token Transfers (NTT)**. Solana is the *hub*, running in **locking** mode: when you bridge out, your ACT is locked in the hub. Ethereum is a *spoke*, running in **burning** mode: an equivalent amount is minted there, and burned again when it comes back.

Total ACT across both chains never exceeds the fixed Solana supply. The Ethereum token is only ever minted against ACT locked on Solana.

## No manual claim step

Traditionally, bridging meant a second transaction on the destination chain to "redeem" your funds. Aretia uses Wormhole's **Executor** relay network instead: you pay the relay cost up front, in the source chain's native token, and delivery on the destination chain happens automatically once Wormhole's guardians attest the transfer.

## Why EVM transfers ask for two signatures

Bridging *from* Ethereum is two transactions. The first is a standard ERC-20 **approve** that lets the bridge contract move exactly the amount you are sending. The second is the transfer itself. The wallet builds each step fresh, after the previous one confirms, so every transaction gets a correct nonce, and you review each one separately.

## Keys never leave the wallet

The bridge integration only ever produces *unsigned* transactions. Signing and broadcasting happen through the same review-and-sign path as every other Aretia transaction. The integration code never touches a private key.

## Before mainnet

Moving to mainnet needs the same treatment as any system that holds funds: independent review, production signers for every admin role, and a controlled rollout. Until then, Universal stays on testnet and is labelled that way everywhere on this site.
