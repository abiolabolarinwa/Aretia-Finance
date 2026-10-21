# ADR 0007: Aretia Order Program (limit buy and limit sell)

Status: **Built through O5 and tested. NOT deployed. NOT audited.** See section 10 for what exists and what does not.

This file is a copy of the decision record kept in the Aretia Wallet repository (`docs/aretia-launch/adr/0007-order-program.md`); that one is the source of truth.

## 1. Decisions (from the owner)

| #   | Decision                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Applies only to tokens created on Aretia Launch.                                                                           |
| 2   | Orders are private **in the Aretia app and API**: a user sees only their own orders. They are **public on-chain** (see 6). |
| 3   | Assets: USDC, USDT, SOL, BNB, ETH, POL. Solana first, then EVM. Only pairs with a real pool are allowed.                   |
| 4   | Open to everyone on day one: anyone can run a keeper.                                                                      |
| 5   | Cancel fee: 0.58% of the escrowed amount.                                                                                  |
| 6   | Successful buy fee: 1.5%.                                                                                                  |
| 7   | Successful sell fee: 2%.                                                                                                   |
| 8   | Minimum order: USD 50 equivalent.                                                                                          |
| 9   | No independent audit requested. We will not call the program "audited".                                                    |

All fees go to Aretia fee-receiving wallets, supplied by the owner:

- Solana: `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`
- EVM (BNB Chain, Ethereum, Polygon): `0xd366cF21Ca17487fab4734A32a53c7a155D7Ec2A`

Owner decision: the program is **upgradeable behind a multisig** with a **72-hour timelock**. The owner also wants an **Aretia Keeper** run by Aretia from day one. Legal review is out of
scope by the owner's choice. The multisig members are still to be decided.

## 2. Scope

- **In:** limit buy ("get at least N tokens for at most X") and limit sell ("get at least Y for M tokens").
- **Out:** stop-loss, take-profit, market orders, cross-chain orders, orders on non-Aretia tokens, any price oracle.
- Both order types are a **minimum-output check**, so no oracle is needed.

## 3. Account model (Solana, v1)

- `Config` PDA: admin multisig, fee recipient, fee bps (cancel 58, buy 150, sell 200), min order, whitelisted swap programs.
- `Order` PDA per order: owner, token mint, quote asset, side, amount in, min amount out, filled so far, status.
- Escrow token account owned by the program, one per order. Only the owner can cancel or withdraw.

## 4. Instructions

- `create_order(side, amount_in, min_out)`: moves funds to escrow; rejects below the minimum order, unsupported tokens or pairs.
- `fill_order(route)`: callable by anyone. CPI into a whitelisted swap program. After the swap the program reads the owner's
  received amount and **aborts unless received >= amount_in_used * min_out / amount_in** (partial fills use the same rate).
  Sell fee (2%) is taken from the quote asset received; buy fee (1.5%) is taken from the payment asset up front, so Aretia always receives payment assets and never Launch tokens. The keeper receives the price improvement above the limit rate, capped at a configured share.
- `cancel_order`: returns the escrow minus the 0.58% fee. Owner only.
- `close_order`: reclaims rent after a full fill or cancel.

## 5. Invariants (each needs a test)

1. A fill never gives the owner less than the limit rate.
2. A fill never spends more than the escrowed amount.
3. Only the owner can cancel; only whitelisted swap programs can be called.
4. Fee is computed once, rounded in the owner's disfavour only by less than 1 base unit, and sent to the stored recipient.
5. The escrow is empty or the order is open; there is no third state.
6. A cancelled or filled order cannot be filled again.
7. Token-2022 transfer-fee tokens: the program uses the amount actually received, never the amount sent.
8. Mints with unsupported extensions (permanent delegate, transfer hook, default frozen) are refused.

## 6. Privacy (be honest in the UI)

The app and API return only the caller's orders (sign-in required). The chain cannot hide accounts, so anyone reading the
chain can see them. Real privacy would need commit-reveal or encrypted orders and is out of scope. The UI must say so.

## 7. Known risks and limits

- **No audit.** The program holds user funds and is open to everyone on day one. Mitigation is the invariants above, property
  and fuzz tests, and a published threat model. Mainnet deployment needs a separate explicit authorisation from the owner.
- **No fill guarantee.** Fills only happen if a keeper runs. Aretia should run one. Cancel always works.
- **MEV.** The limit rate protects the minimum, not the price the user could otherwise have had.
- **Issuer freezes.** USDC and USDT can be frozen by their issuers. Funds in an escrow could be stuck.
- **Spam.** The USD 50 minimum plus the rent paid by the creator limits it. The price is read from the pool at creation, and an
  oracle-free check is imprecise, so the USD minimum is enforced by the app and re-checked on-chain only against a configured
  per-asset minimum amount that the admin multisig updates. Stale values are a known weakness.
- **Pairs.** Only pairs with a pool are listed. USDC and USDT orders open once a token has graduated to its Meteora pool; until then only SOL orders can fill.
- **Fee asset.** Owner decision: all fees are paid in the payment asset (USDC, USDT, SOL, BNB, ETH, POL). Buy fee is deducted from the amount escrowed; the cancel fee comes out of the refund.

## 7a. Which curve (decision recorded 2026-10-21)

Orders fill against the **web wallet's** bonding curve (Aretia-Finance `program/aretia-curve`), the one that product uses. The
Launch-token proof reads the curve account at an offset stored in the order program's config, so it is not tied to one curve. The
extension monorepo's own curve (`programs/aretia-launch-curve`) has no order adapter.

## 8. EVM (second stage)

One contract per chain (BNB Chain, Ethereum, Polygon), with BNB, ETH and POL wrapped (WBNB, WETH, WPOL) inside. Handle USDT's
missing return value and USDC/USDT decimals (6 vs 18 on BNB Chain). Same invariants and fee schedule. Router whitelist is
immutable per deployment.

## 9. Open items for the owner

1. ~~Fee recipient wallet for each chain.~~ Given for Solana and EVM (section 1).
2. ~~Program upgradeability.~~ Decided: upgradeable behind a multisig with a 72-hour timelock.
3. ~~Whether the Aretia keeper should exist.~~ Decided: yes.
4. ~~Legal review.~~ Owner chose to skip it.
5. **Still open:** who the multisig members are; who funds and holds the keeper's hot wallet; the BNB Chain, Ethereum and Polygon
   deployments (the one EVM fee address is used on all of them).

## 10. Milestones: where each stands (updated 2026-10-21)

|     | What                                                                              | State                                                                     |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| O0  | This record                                                                       | Done, owner decisions recorded                                            |
| O1  | Solana program `programs/aretia-orders` (24 + 5 tests)                            | Built, tested in LiteSVM, **not deployed**                                |
| O1b | Venue adapter for the web wallet's curve `programs/aretia-orders-web-curve-venue` | Built; tested against the curve's real binary (8 tests)                   |
| O2  | Order index and private per-user API (`apps/launch-api`)                          | Built, tested (privacy, idempotence, resume)                              |
| O3  | Web wallet "Limit orders" card (Aretia-Finance)                                   | Built, tested, **off**; pays in SOL, or USDC/USDT for graduated tokens    |
| O4  | Aretia Keeper `apps/order-keeper` (Solana curve and Meteora pool, and EVM)        | Built, tested on a fake chain, dry-run by default, never run on a network |
| O5  | EVM contract `AretiaOrders.sol` (21 tests on a real EVM)                          | Built, with client and keeper; **no EVM UI yet**; pooled escrow (section 7) |
| O6  | Devnet / testnet runs                                                             | **Not done** (no network access from the build environment)               |
| O7  | Mainnet                                                                           | **Not authorised.** Needs the owner's explicit go-ahead                   |

Meteora pool (graduated tokens): no adapter program is needed; the order program calls Meteora itself, proved against the real Meteora binary.
Not built: the EVM card; the multisig and 72-hour timelock around the upgrade authority; the fee-paying keeper wallet.
