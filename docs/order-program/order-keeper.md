# Aretia Keeper (`apps/order-keeper`)

Fills limit orders. Specification: [ADR 0007](adr/0007-order-program.md). Program notes: [order-program.md](order-program.md).

**Status: built and unit tested with a fake chain (Solana and EVM). Never run against a real network. Not deployed.**

## What it does

Every few seconds it lists the open orders, reads each launch token's bonding curve (the web wallet's `aretia-curve`), and asks the shared planner
(`planFill` in `packages/launch-solana/src/orders.ts`) whether the curve can fill the order at the owner's limit. If so it
builds one transaction (compute budget, the token accounts the fill needs, the fill), **simulates it**, and, in live mode,
sends it. A fill that another keeper got to first, or a price that moved, fails in the simulation at no cost.
If the whole order is beyond the limit but a smaller slice is not, it fills the largest such slice (at least 5%).

### Graduated tokens (Meteora pool), any payment asset

Once a token's curve is `migrated`, its order is filled on the Meteora DAMM v2 pool for the order's own payment asset (USDC, USDT, SOL...)
instead. The program itself calls Meteora (`meteoraFill` in `packages/launch-solana/src/meteora.ts`); no adapter program is
involved, and the Meteora program must be on the program's venue whitelist. The pool is found by its address (`meteoraPoolAddress`).
There is no local quote: the order program is the only exact quoter, so the keeper **simulates slices, largest first** (the
whole order, then halves down to the 5% minimum) and sends the first that passes. For this reason `KEEPER_MIN_REWARD` does not apply
to pool fills: the reward is not known before the simulation. A token still on its curve is filled on the curve, which is SOL-only.

### EVM (`src/evmMain.ts`)

The same loop on an EVM chain: list orders, price each through the whitelisted Uniswap-V2-style router, build the fill, gas-estimate it
(which simulates it and reverts if the contract would refuse), and in live mode sign and send. Build with `npm run build:evm`, run with
`npm run start:evm`. It uses the same safety defaults: dry-run unless `KEEPER_MODE=live`, and it refuses a mainnet unless `KEEPER_ALLOW_MAINNET=yes`.

| Variable                                                               | Meaning                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `KEEPER_EVM_NETWORK`, `KEEPER_EVM_ORDERS`, `KEEPER_EVM_ROUTER`         | required: a wallet network id, the `AretiaOrders` contract, the whitelisted router |
| `KEEPER_EVM_FROM_BLOCK`                                                | the contract's deployment block; default 0                                         |
| `KEEPER_RPC_URL`                                                       | optional; replaces the network's public RPC endpoints                              |
| `KEEPER_KEY_FILE` or `KEEPER_SECRET_KEY`                               | the hot key, 0x-prefixed 32-byte hex. Never commit it                              |
| `KEEPER_MIN_BALANCE_WEI`                                               | live mode stops below this balance; default 0.005 of the coin                      |
| `KEEPER_INTERVAL_MS`, `KEEPER_MAX_FILLS_PER_TICK`, `KEEPER_MIN_REWARD` | default 12000, 3, 0                                                                |

Same hot-key advice as below: a dedicated wallet with a few dollars of gas. The contract's pooled escrow means the key must never be
given any role on the contract.

## What it cannot do

It holds no user funds. An order signs for its own vaults inside the program, and the program refuses any fill that gives
the owner less than their limit. A bug in the keeper can waste its own SOL or fail to fill; it cannot move an owner's money.
Anyone can run their own keeper; this one is Aretia's, so orders fill from day one.

## Running it

| Variable                                                                                        | Meaning                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `KEEPER_RPC_URL`, `KEEPER_ORDERS_PROGRAM`, `KEEPER_CURVE_PROGRAM`, `KEEPER_CURVE_VENUE_PROGRAM` | required                                                  |
| `KEEPER_KEY_FILE` or `KEEPER_SECRET_KEY`                                                        | the hot wallet, a JSON array of 64 bytes. Never commit it |
| `KEEPER_MODE`                                                                                   | `dry-run` (default, simulate only) or `live`              |
| `KEEPER_ALLOW_MAINNET`                                                                          | must be `yes` to run against mainnet-beta in either mode  |
| `KEEPER_INTERVAL_MS`                                                                            | default 5000                                              |
| `KEEPER_MAX_FILLS_PER_TICK`                                                                     | default 3                                                 |
| `KEEPER_MIN_REWARD`                                                                             | skip fills that pay the keeper less than this; default 0  |
| `KEEPER_MIN_BALANCE_LAMPORTS`                                                                   | live mode stops below this balance; default 0.05 SOL      |

Build with `npm run build -w apps/order-keeper`, run with `npm start -w apps/order-keeper`.

## The hot key (a decision for the owner)

The keeper needs a signing key to pay transaction fees. That conflicts with the rule that the backend holds no private keys,
so it is kept out of `launch-api` and run as its own process. Recommended: a dedicated wallet that holds a few SOL
at most, a floor (`KEEPER_MIN_BALANCE_LAMPORTS`), the key in the host's secret store and never in the repository, and a
different wallet from any fee-receiving or admin wallet. The owner must create and fund it; nothing here does.

## Known limits

- On Solana, a token still trading on its curve is filled only for SOL-quoted orders; a USDC/USDT order on such a token waits until it graduates
  (reported as `unsupported-quote-asset`). Graduated tokens fill on the Meteora pool in any payment asset.
- The EVM keeper has a single router per network and re-reads every order each pass.
- It lists every order with one RPC call per pass. That is fine for thousands of orders and needs an index (or websocket
  subscriptions) beyond that.
- No transaction confirmation tracking: it sends and moves on; the next pass sees the result.
- A fill takes about 175,000 compute units (a buy; a sell about 125,000); the transaction asks for 400,000.
