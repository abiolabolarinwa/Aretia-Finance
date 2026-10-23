# Aretia Orders (Solana): implementation notes

Specification and decisions: [ADR 0007](adr/0007-order-program.md). Code: `programs/aretia-orders`. Test-only venue:
`programs/aretia-orders-mock-venue` (never deploy).

**Status: milestone O1 (program and tests). Not deployed. Not audited. No fee recipient is set on chain; the owner's
addresses are in the ADR and are passed in at `initialize_config`.**

## How an order works

1. `create_order`: the owner escrows the asset they pay with into a vault owned by the order. Buy escrows the payment
   asset; sell escrows the launch token. The program checks that the token is an Aretia Launch token (an account of the
   bonding-curve program naming the mint), that its mint and freeze authority are renounced, that neither mint has a
   dangerous Token-2022 extension, that the payment asset is enabled, and the minimum size.
2. `fill_order`: anyone can call it. The keeper names a slice, a whitelisted venue program, the venue's instruction data and
   accounts. The order signs for its vaults. Afterwards the program measures what the vault spent and received.
3. `cancel_order`: the owner only. Pays the cancel fee, returns the rest, closes the order. Works while paused.

## What the program refuses

- A fill that gives the owner less than the limit rate, after Aretia's fee.
- A venue that spends a different amount than the fill declared, or changes a vault's owner, delegate or close authority.
- Any venue that is not on the admin whitelist. The token, Token-2022, associated-token, system and loader programs and the
  program itself can never be whitelisted.
- Fills under 5% of the order, unless it is the remainder (stops a keeper grinding an order into dust).
- A fee above its hard cap (cancel 1%, buy 3%, sell 3%, keeper share 50%), even from the admin.

Tests: `programs/aretia-orders/tests/orders.rs` (21) and unit tests in `src/math.rs` (5). The runtime also refuses a venue
re-entering the program; the order's own busy flag is a second line of defence.

## Money rules as built

| Event         | Fee   | Paid in          | Notes                                                                                    |
| ------------- | ----- | ---------------- | ---------------------------------------------------------------------------------------- |
| Buy fill      | 1.5%  | payment asset    | taken from the slice before the swap, on cumulative amounts so slicing cannot inflate it |
| Sell fill     | 2%    | payment asset    | taken from what the swap returns                                                         |
| Cancel (buy)  | 0.58% | payment asset    | on the unspent remainder                                                                 |
| Cancel (sell) | 0.58% | **launch token** | the escrow is the launch token; no payment asset is held to take it from                 |

The limit is what the owner ends up holding **after** Aretia's fee. The keeper earns up to 20% of the surplus above the limit.

## Venue adapter: the web wallet's bonding curve (`programs/aretia-orders-web-curve-venue`)

The web wallet's curve (`program/aretia-curve` in the Aretia-Finance repository, mainnet id `CCBr6Dty...` planned, **not deployed,
unaudited, and behind a flag that is off on mainnet**) trades native SOL against a Token-2022 token; an order holds wrapped SOL.
The adapter owns a wallet PDA `["adapter"]` that it keeps empty: on a buy it moves the order's WSOL to a temporary WSOL account,
closes it into the wallet, calls `curve.buy`, and passes the tokens to the order's vault; on a sell it calls `curve.sell` and
sends the SOL into the order's WSOL account and syncs it. Whatever the wallet holds before a call (someone sending dust) is swept to
the keeper, so dust cannot block fills. It only calls the curve program id it was built with, and the curve's fee wallet is pinned.

The curve's source is in another repository, so the adapter calls it with hand-built instructions. The tests run the curve's
real binary (`programs/aretia-orders/tests/fixtures/aretia_curve.so`, checked against the checksum published beside it) and compare
every balance with an independent Rust copy of the curve's arithmetic. Covered: buy, sell, the limit failing at the curve price,
the curve refusing a minimum the keeper names, dust, a wrong curve program, a swapped fee wallet, and a token with no curve.

The order program learns what a Launch-token proof looks like from its config (`curve_program`, `curve_mint_offset`), so it is not
tied to one curve. For the web curve the offset is 43. A keeper's transaction needs a compute budget request and two idempotent
ATA creations before the fill; a fill takes about 175,000 compute units (buy) and 125,000 (sell).

The other curve in this repository (`programs/aretia-launch-curve`, built for the extension) has no order adapter: the web wallet
does not use it.

## Order index and API (`apps/launch-api`)

The backend reads the order program's events through an order source (`SolanaOrderSource`: `getSignaturesForAddress`, then each
successful transaction's logs), applies them idempotently (an event is recorded first and acted on only if the record is new),
and keeps a cursor so a pass resumes where the last one stopped. `GET /v1/me/orders` and `GET /v1/me/orders/:address` need a
signed-in session and return only that person's orders; another person's order answers exactly like one that does not exist. There
is no public listing and no parameter that names another owner. Set `LAUNCH_ORDERS_PROGRAM_ID` to switch indexing on. The web
wallet does not depend on this: it reads a person's open orders straight from the chain, filtered by owner.

## EVM (`packages/launch-evm/contracts/AretiaOrders.sol`)

The same rules on EVM chains: escrow, open keeper fills through whitelisted venues, the limit checked on what actually arrived,
fees 1.5% / 2% / 0.58% with the same hard caps, the keeper's share of the surplus, and a native-currency buy that wraps for the
person. It differs from the Solana program in one way that matters: **escrow is pooled in one contract** (Solana gives every
order its own vault). A venue is called by the contract, so a venue that could make the contract call arbitrary functions could move
other orders' tokens; only plain swap routers may be whitelisted, a fill can never name that order's own tokens as the venue, and
the admin is meant to be a multisig behind a timelock. Fee-on-transfer tokens are refused. 21 tests run the real contract on a
real EVM (hostile venues, reentrancy, USDT-style tokens, isolation between orders). No EVM client, keeper or screen exists yet.

## A frozen or blocked fee address cannot trap an owner's money

A stablecoin issuer can freeze a token account (Solana) or block an address (EVM). If Aretia's fee address were frozen, the
cancel could not pay its fee and would fail, and the owner could not get their money back. So: on Solana there is a second instruction,
`cancel_order_fee_frozen`, that waives the fee, and the program checks the fee account really is frozen (it cannot be used to
skip the fee otherwise). On EVM a cancel that cannot pay the fee waives it instead of failing. Fills, which must pay the fee, stop
until the admin changes the fee address.

## Not done yet (honest list)

- **Graduated tokens** fill on their Meteora DAMM v2 pool, called directly by the order program (no adapter program). Meteora must
  be on the venue whitelist, and the pool must exist for the order's payment asset; tests run the real Meteora binary.
- **The curve itself is not live.** It is unaudited and gated off on mainnet in the web wallet. Orders have nothing to trade
  against until the owner deploys it.
- **EVM contract** (stage O5).
- **Keeper, backend index, per-user order API, web wallet UI** (O2 to O4).
- **Pools are not checked on chain.** An order for a pair with no pool can be created and can only be cancelled (with the fee).
  The app must list only pairs with a pool.
- **The USD 50 minimum is a per-asset amount** set by the admin; it goes stale as prices move.
- **Program id is a placeholder.** Replace it at deployment; the upgrade authority should be the multisig with a 72 hour timelock.
