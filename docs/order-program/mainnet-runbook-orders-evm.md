# Runbook: Aretia Orders on BNB Chain, Ethereum and Polygon

**Status: prepared, never run on a mainnet.** The contract (`contracts-evm/orders/AretiaOrders.sol`) has run on Ethereum Sepolia with mock tokens
and a mock swap venue (`contracts-evm/orders/testnet/`, `docs/ORDER_PROGRAM.md` 11h). It is **unaudited**. Every step below is done by a person with the
keys, on their own machine; nothing here sends a transaction for you. Owner decisions are in `docs/ORDER_PROGRAM.md` section 1.

## 0. Stop-and-check before anything

- [ ] **The contract version.** Deploy the version in this repository (`proveLaunchToken`), **not** the Wallet repo's `main`, whose copy calls `factory.creatorOf`, which the live factories do not have. Once that fix is merged in the Wallet repo, compare the two files.
- [ ] **Compile reproducibly.** `contracts-evm/orders/testnet/compile.mjs` uses solc 0.8.28, optimizer 200 runs, EVM paris. Record the creation-bytecode sha-256 and publish the standard-input JSON for explorer verification. This has not been done yet.
- [ ] **Admin.** The constructor's `admin_` must be the **multisig** (Safe) with the **72-hour timelock** in front of it (for example a Safe plus a timelock controller contract that is the admin). A single key as admin can whitelist a hostile swap venue and drain the pooled escrow. Neither the multisig nor the timelock exists yet, and the members are not chosen. Do not deploy with a personal key as admin.
- [ ] **Fee wallet.** `0xd366cF21Ca17487fab4734A32a53c7a155D7Ec2A` (owner decision). Confirm it can receive each payment asset (a USDC or USDT blocklist entry would stop fees; the contract is built so a cancel still works then).
- [ ] **Fee numbers (basis points):** cancel 58, buy 150, sell 200, keeper share 2000. The contract caps each; read the caps in the source.
- [ ] **Deployer.** A throwaway wallet with enough native coin for one deployment and about eight configuration transactions per chain; keep it offline afterwards. Deploy cost has **not been measured on a mainnet**; take it from a Sepolia dry run (`ethSpent` in `sepolia-run.json` covers the whole mock run, about 0.005 ETH at Sepolia gas) and price it at the target chain's gas.

## 1. Constructor arguments, per chain

`AretiaOrders(admin, feeRecipient, factory, wrappedNative, 58, 150, 200, 2000)`

| Chain | Live token factory | Wrapped native token |
| --- | --- | --- |
| BNB Chain (56) | `0xc3eb98c45795cffb10b61178332cc6fcbbc0385c` | WBNB `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c` |
| Ethereum (1) | `0x951a22270faa7d1c25efad2356c414cbddaba324` | WETH `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` |
| Polygon (137) | `0xca1aa427ba5906d00377a835dd9b36b049034f0c` | WPOL `0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270` |

These come from `website/src/scripts/walletLaunchEvmCore.ts`; check them against the chain explorer before use. The factory must be the one that made the tokens people will trade: only tokens it created can be proved.

## 2. Deploy and read back

Deploy once per chain. Then read back `admin`, `feeRecipient`, `factory`, `wrappedNative`, `cancelBps`, `buyBps`, `sellBps`, `keeperBps` and compare every one with section 1; stop if any differs. Verify the source on the explorer.

## 3. Configure (the admin multisig, through the timelock)

1. `setVenue(router, true)` for **plain swap routers only** (for example the chain's Uniswap V2-style router the Launch pool uses). Never whitelist a token, an aggregator with arbitrary-call features, or anything that can make the contract call other functions: the escrow of all orders is pooled in this one contract.
2. `setQuote(token, minAmount)` for each payment asset, with the USD 50 floor in that token's base units (note USDC and USDT have 6 decimals on Ethereum and Polygon but 18 on BNB Chain). Wrapped native tokens need a floor in coin units that is about USD 50 on the day; it goes stale, so plan to update it.
3. Leave `paused` false. Pausing stops new orders and fills; owners can still cancel.

## 4. Prove each launch token

For every token orders should be allowed for, anyone calls `proveLaunchToken(token, factoryNonce)`, where `factoryNonce` is the factory's contract nonce when it made the token (its first token used 1; count the factory's creations in order, or read the `TokenCreated` events). The call reverts unless the token's address is exactly what the factory's CREATE produces at that nonce. Until a token is proved, orders on it revert. The site and the keeper must call this before offering orders on a new token (not built yet).

## 5. The EVM keeper

`apps/order-keeper/src/evmMain.ts` in the Wallet repo is built and tested on a fake chain only. Give it a **new** hot wallet funded with a little native coin, run it in dry-run first, and switch to live only after a clean day. Nothing fills without a keeper.

## 6. Day-one checks and rollback

- Place one minimum-size order from a test wallet, cancel it, and confirm the fee wallet received exactly 0.58% of the amount.
- Place one and let the keeper fill it; confirm the buy fee (1.5%), the owner's amount against the limit, and the keeper's share.
- First response to anything odd: `setConfig(..., paused = true)` from the multisig.
- Fee changes apply to new orders only; open orders keep the fees they were made with.

## What is not covered or not proved

A real swap venue on any chain, native-coin buys with a real wrapped token, USDT-style tokens on a real chain, the EVM keeper on a live RPC, the multisig and timelock, and any audit.
