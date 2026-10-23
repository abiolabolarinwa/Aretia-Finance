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
| O5  | EVM contract `AretiaOrders.sol` (21 tests on a real EVM)                          | Built, with client, keeper and a web card (**off**: `PUBLIC_ORDERS_EVM_ENABLED`, no deployment); pooled escrow (section 7) |
| O6  | Devnet / testnet runs                                                             | **Not done** (no network access from the build environment)               |
| O7  | Mainnet                                                                           | **Not authorised.** Needs the owner's explicit go-ahead                   |

Meteora pool (graduated tokens): no adapter program is needed; the order program calls Meteora itself, proved against the real Meteora binary.
Not built: the multisig and 72-hour timelock around the upgrade authority; the fee-paying keeper wallet.

## 11. Where the source is, and what remains before launch (updated 2026-10-23)

**Source location.** It was built by cloud sessions and lives on GitHub in `abiolabolarinwa/aretia-wallet` (`main`, plus the branch
`claude/orders-mainnet-runbook`, which adds the mainnet runbook and the admin instruction builders). An earlier version of this section
said the source could not be found; that was wrong, because the local Wallet checkout was stale. The source is now **copied into this
repository** so it can be read and built here:

| Path here | What | Origin |
| --- | --- | --- |
| `program/aretia-orders/` | Solana program (Anchor 1.2.0) with its LiteSVM tests, golden instruction files and the Meteora and curve fixture binaries (with sha-256 files) | `programs/aretia-orders` |
| `program/aretia-orders-web-curve-venue/` | Adapter that fills SOL orders against the web wallet's curve | `programs/aretia-orders-web-curve-venue` |
| `program/aretia-orders-mock-venue/` | Test-only venue | `programs/aretia-orders-mock-venue` |
| `contracts-evm/orders/AretiaOrders.sol`, `MockOrderVenue.sol` | EVM contract and its test venue | `packages/launch-evm/contracts` |
| `docs/order-program/` | Wallet repo's spec, keeper notes and the Solana mainnet runbook | `docs/aretia-launch` |

The keeper (`apps/order-keeper`), the order API and the TypeScript clients stay in the Wallet repository only. No program binary is committed
and no sha-256 of a build exists yet: building needs Anchor, which this change did not run. Test results quoted in section 10 are the other
sessions' reports unless section 11a says otherwise.

**What the site shows now.** The Launch page's "Give it a market" step, under the curve tab, always shows a "Limit orders" card with the
status "Not live yet", the fees, the minimum and the limits. It has no form, button or script. The working card still needs
`PUBLIC_ORDERS_ENABLED=1` (Solana) or `PUBLIC_ORDERS_EVM_ENABLED=1` (EVM) at build time; both stay off. Even then, with no program address
in `walletOrdersCore.ts` and no EVM deployment, the card shows a notice and no form.

**What remains before it can go live.** None of this is done. The owner gave a general go-ahead for mainnet on 2026-10-23; it is
recorded here, and each step below still needs the people and keys named.

1. **The curve comes first.** Orders fill against `aretia-curve`, which is unaudited and not deployed on Solana mainnet. Until it is, orders have nothing to fill against (see `docs/order-program/mainnet-runbook-orders.md`, step 0).
2. **Build and hash.** Run `anchor build` (Anchor 1.2.0) from a clean checkout, record the `.so` sha-256, and commit it.
3. **Devnet / testnet runs (O6).** Deploy to Solana devnet and one EVM testnet and run create, fill by a keeper, cancel. Test funds only. Not done.
4. **Multisig and 72-hour timelock.** Two multisig addresses were supplied (`4DoV9F…hdjG`, `CAyPkS…cB5r`) but the roles (upgrade authority vs admin) are not assigned. Set the Squads time lock (259200 s) **before** handing over the upgrade authority.
5. **Deployer and keeper keys.** A person with a funded deployer key runs the deploy on their own machine (rent is about 3 x the `.so` size in SOL; confirm on devnet). The keeper needs a new Solana hot wallet, run dry-run first. Nobody in these sessions holds or should hold these keys.
6. **EVM deployment steps are not written.** The constructor takes the admin multisig, fee wallet, token factory, wrapped native token and four fee numbers; the admin then whitelists the router and enables assets. One deployment per chain: BNB Chain, Ethereum, Polygon.
7. **Audit.** None requested. Describe it as unaudited everywhere. It holds user funds and is open to everyone on day one.
8. **Go live.** Only after steps 1 to 6 pass the read-back check: set the program address in `walletOrdersCore.ts` (or the EVM address), then turn that network's flag on.
9. **Known limits to keep on the page:** orders are public on-chain; frozen USDC/USDT can strand an escrow; the USD minimum is imprecise without an oracle; fills depend on a keeper.

### 11a. What was re-run here (2026-10-23)

- `program/aretia-orders` compiles with `cargo test --no-run`, and its **5 unit tests pass** (the math).
- The integration tests (`orders.rs`, `curve_venue.rs`, `meteora_venue.rs`) need the compiled programs from `cargo build-sbf` first and **were not run here**: they failed with "run `cargo build-sbf` before `cargo test`". So the 24 + 5 and 8 test figures are still the other sessions' reports, not re-verified.
- The EVM contract (`contracts-evm/orders/AretiaOrders.sol`) was copied, not compiled or tested here. Its 21 tests live in the Wallet repo.

### 11b. Build and tests re-run here (2026-10-23)

Built on Windows with `cargo build-sbf` (Agave 4.2.1 tools), **not** `anchor build` as the runbook says (Anchor is not installed here), so these hashes
are **not** proof of a reproducible build and must be redone with `anchor build` from a clean checkout before any deploy. They only identify what was tested.

| Program | sha-256 of the `.so` |
| --- | --- |
| `aretia_orders.so` (197,121 bytes) | `0deea5cce7e305689427c8363a215036b8d2dbc5bdea9983df280a2917549a63` |
| `aretia_orders_web_curve_venue.so` | `8cb41b64aca1eb66bdbef0bbc10a97196e6816b295fe4c91486141106fd17f1f` |
| `aretia_orders_mock_venue.so` (test only) | `46e5a482282ed2be1f15fb5cb0be3fd0887da75f177a59be215c7559b542b36b` |

With those built, `cargo test` in `program/aretia-orders` passes: **46 tests** (5 unit, 8 + 7 + 26 integration, in LiteSVM, including against the real Meteora and curve binaries), 0 failed. This replaces the "not run here" note in 11a for the Solana program. The binaries are not committed. Not run: the EVM contract tests, the keeper, any devnet or testnet run.

### 11c. Solana devnet deploy (2026-10-23)

The order program was deployed to **Solana devnet only**, from a throwaway key funded with devnet SOL (no real-money key). Because the committed `declare_id!`
(`Fnb5FELt…`) is a placeholder nobody holds a key for, the devnet build used a scratch copy with a fresh program id substituted. Everything else is the same source.

- Devnet program id: `AZ91hKcZWUHLGwGgoJvUp2do41DjQvMftJesrR6YmmhF` (throwaway deployer `9d66u3enEVBXbhjuiHDtgLVWVmLLNfEy2NkDiNvzFV3b`; keys kept outside the repo).
- The bytes read back from devnet (`solana program dump`) hash to the same sha-256 as the built file, `70560ba4…705b392` (differs from 11b only because the program id is compiled in).
- **Cost: about 2.13 SOL** left the deployer for this 197 KB program (rent plus transaction fees). That figure is on devnet, with the same rent rules as mainnet; mainnet also needs the config and asset accounts and the keeper's balance.
- **Not done on devnet:** `initialize_config`, `set_venues`, `set_asset`, creating, filling and cancelling an order. The admin instruction builders and the keeper live in the Wallet repo (`ordersAdmin.ts`, `apps/order-keeper`) and are not in this repo yet; creating an order also needs an Aretia-launched token with a curve account. So only deployment and read-back are proved here.
- **Mainnet implication:** the real program id must be decided and its keypair created before the final build, and the website, tests and docs then updated to it.

### 11d. Devnet configuration (2026-10-23)

On the devnet deployment from 11c, the deployer (throwaway, also acting as admin) sent three admin instructions, hand-encoded from the program's discriminators and checked against `golden-admin-instructions.json` for layout:

- `initialize_config`: admin = the deployer, fee recipient = `2tcBrd1J…VoZX2`, curve program = the devnet curve `9HVuUHU4…t5f4`, mint offset 43, fees 58 / 150 / 200 bps, keeper share 2000 bps.
- `set_venues`: Meteora DAMM v2 (`cpamdpZC…sGG`) only.
- `set_asset`: wrapped SOL enabled, minimum 0.25 SOL.

Read back from the chain: the config account (owned by the devnet program) holds the admin, fee recipient and curve program above, and fees 58 / 150 / 200 / 2000. Each instruction was accepted by the deployed program on devnet.

Still **not** exercised on devnet: creating, filling and cancelling an order (needs an Aretia-launched devnet token on the devnet curve, and the keeper), and any multisig or timelock. The EVM contract has not been deployed to any testnet.
