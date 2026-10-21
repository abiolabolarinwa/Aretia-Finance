# ADR 0007: Aretia Order Program (limit buy and limit sell)

Status: **Proposed, specification only. No code exists. Nothing is deployed.**

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
- **Pairs.** Only pairs with a pool are listed. A SOL-paired token cannot take USDC orders in v1.
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

1. Fee recipient wallet for each chain.
2. Program upgradeability (immutable vs multisig upgradeable). Recommended: upgradeable behind a multisig with a timelock,
   because there will be no audit.
3. Whether the Aretia keeper should exist at launch.
4. Legal review of fees and public order books.

## 10. Milestones (proposal)

O0 spec sign-off (this document) -> O1 Solana program + LiteSVM tests -> O2 backend order index and per-user API ->
O3 web wallet UI -> O4 keeper reference implementation -> O5 EVM contract -> O6 devnet/testnet runs -> O7 mainnet only on
explicit authorisation.
