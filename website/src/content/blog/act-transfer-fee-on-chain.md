---
title: How ACT's transfer fee works, on-chain
description: The 1.5% fee on every ACT transfer isn't custom code. It's a native Token-2022 extension, and you can read every parameter of it yourself.
category: ACT
date: 2026-09-29
---

*Updated October 2026: the treasury multisig lowered the fee from 3.5% to 1.5%, and the 1% liquidity share was removed.*

Every transfer of ACT has a 1.5% fee withheld from it. This post explains where that fee comes from, who controls it, and how you can check all of it without trusting us.

## A token-program feature, not custom logic

ACT is an SPL **Token-2022** mint on Solana. Token-2022 includes a native *transfer-fee extension*: when a mint is created with it, the token program itself withholds a fraction of every transfer. There is no separate contract skimming transfers, no transfer hook, and no way for a wallet to opt out.

ACT's configuration is 150 basis points (1.5%), with no maximum cap. It launched at 350 basis points (3.5%); the treasury multisig lowered it with a public, 2-of-3 approved proposal, which Solana applies two epochs after approval.

## Where the fee goes

Withheld fees accumulate on-chain until the treasury collects them. They are then split:

- **1%**: the Climate Treasury, a catalyst fund for climate mitigation and adaptation projects
- **0.5%**: treasury operations: verifying projects, reviewing impact reports, monitoring

The management share settles in its own wallet, separate from the treasury multisig, so project funds and operating costs can never be mixed.

## Who controls it

The mint's *transfer-fee config authority* and *withdraw-withheld authority* both belong to a 2-of-3 multisig. No single person can change the rate or move the withheld fees.

The mint authority is revoked, so the supply is fixed at 1,000,000,000 ACT forever. The freeze authority is also revoked, so no wallet can be frozen.

## Verify it yourself

Look up the mint `7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG` on any Solana explorer, or use the [Verify](/verify) page. The `transferFeeConfig` extension shows the basis points, the epoch they took effect and both authorities. Everything above is readable on-chain.
