# Aretia Pool

Aretia's own constant-product swap pool for Solana. It exists so that Aretia, not Meteora, keeps a protocol share of the trading fees on pools opened from the Launch page.

**Status: UNAUDITED. Deployed to devnet only. Never run on mainnet. The Launch card is behind a build flag that is off. Aggregators (Jupiter and others) do not route to it and will not until they integrate it.**

Program: `program/aretia-pool` (Anchor 0.30.1, same toolchain and conventions as `program/aretia-curve`).
Maths: `program/aretia-pool/pool-math` (pure integer maths, no Solana dependency, property-tested).
Web: `website/src/scripts/walletAretiaPool*.ts`.

## 1. Decisions for the owner

These are set as constants in the program. Each is a one-line change before a mainnet build, and none can change after deployment (there is no admin instruction).

| Decision | Value now | Notes |
|---|---|---|
| Protocol share of the trading fee | 20% (2000 of 10,000) | Meteora's own default protocol share is the same figure, so a creator sees no worse deal. Paid to the fee wallet on every trade, no claim step. |
| Creator-chosen trading fee | 0.25% or 1% | The only two values the program accepts. |
| Flat creation fee | 0.05 SOL | Taken by the program inside `create_pool`, to `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`. |
| Fee when a Curve graduates into a pool | Not set | Section 12. The curve program already took its own 0.58% on every trade; the owner decides whether graduation also pays the 0.05 SOL. |
| Who may be a pool's quote asset | Native SOL only | Keeps the program small. Section 11 says what this costs in aggregator terms. |

## 2. The pool in one paragraph

One pool per token, always against SOL. It is a constant-product curve (`X * Y = k`) with a virtual SOL reserve, which is what makes single-sided creation possible: the creator deposits only tokens, the virtual reserve sets the starting price, and the pool holds no real SOL until people buy. Nobody can sell tokens into the pool for more SOL than buyers have paid in, so the price can never fall below the starting price, which is the same behaviour as our Meteora single-sided pools (a Meteora position whose minimum price equals its starting price and whose maximum price is unbounded). Liquidity is a single number, `L`, measured in lamports of virtual SOL. Liquidity providers hold shares equal to `L`, fees accrue separately from the reserves, and a position can be locked permanently.

## 3. State

### Pool (PDA `["pool", mint]`)

| Field | Type | Meaning |
|---|---|---|
| bump, sol_bump | u8, u8 | PDA bumps (pool, and its SOL vault). |
| mint | Pubkey | The token. Quote side is always native SOL. |
| creator | Pubkey | Who opened it. Informational only; gives no power. |
| fee_bps | u16 | 25 or 100, fixed at creation. |
| x | u64 | Real token reserve: what is actually in the token vault for trading. |
| vx | u64 | Virtual token reserve. Zero means no upper price; otherwise it sets a price ceiling (section 6d). Scales with liquidity. |
| y | u64 | Real SOL reserve (lamports). Zero at single-sided creation. |
| l | u64 | Total liquidity = virtual SOL reserve = total shares. |
| acc | u128 | Fee per share, cumulative, scaled by 2^64. Wraps; only differences are read. |
| fee_reserve | u64 | LP fees accrued and not yet claimed, held in the SOL vault outside `y`. |
| created_at | i64 | Unix time. Launch protection counts from here. |
| fee_start_bps | u16 | Launch protection: the fee the pool starts at. Zero means none. Fixed at creation. |
| decay_secs | u32 | Launch protection: seconds the fee takes to fall in a straight line to `fee_bps`. Fixed at creation. |

The effective reserves the curve prices against are `X = x + vx` and `Y = y + l`. The starting price is `(y0 + l0) / (x0 + vx0)`, in lamports per raw token unit.

### Position (PDA `["position", pool, id]`)

| Field | Type | Meaning |
|---|---|---|
| pool, owner | Pubkey | The owner is whoever can act on the position now. |
| id | Pubkey | The address the account is derived from. Never changes. |
| bump | u8 | |
| shares | u64 | Liquidity this position owns. Sum over all positions equals `pool.l` at all times. |
| locked | u64 | Shares that can never be removed. Only ever grows. |
| checkpoint | u128 | `pool.acc` at the last settlement. |
| pending | u64 | Fees settled and not yet claimed. |
| recipient | Pubkey | Where `claim_fees` pays. The owner until the owner names another wallet. |

A position's address comes from its `id`, which is the owner's own address, or an address that signed for itself when the position was opened (so nobody can take an id in advance, and one wallet can hold several positions). `transfer_position` changes the `owner` and resets the fee payee to the new owner; the id, and so the address, stays. Everything goes with it, locked liquidity included, and so do the fees already settled to the position. A locked position can therefore be sold, but never withdrawn by anyone.

### Vaults

* **Token vault**: the pool's associated token account for the mint (Token-2022), authority = the pool PDA.
* **SOL vault**: a system-owned PDA `["sol_vault", pool]` holding the lamports the pool owes: `rent_min + y + fee_reserve`. The same arrangement as the curve's SOL vault.

Reserves are numbers in the pool account, never the vault balances. A donation to either vault changes nothing.

## 4. Instructions

All instructions revert with a named error on any failure; nothing is partially applied.

1. **`create_pool(x0, y0, l0, fee_bps, lock, sniper_bps, decay_secs, vx0)`**. Creator signs. Checks the mint (section 5). Moves `x0` tokens into the token vault and `y0` lamports (usually zero) into the SOL vault, plus the rent minimum for the SOL vault, pays the 0.05 SOL creation fee to the fee wallet, writes the pool, and opens the owner's position with `shares = l0` (`locked = l0` when `lock`). The `owner` of the position is a separate account passed in, normally the creator, and the curve's graduation sets it to the curve's creator (section 12). Bounds: `x0 >= 1000`, `l0 >= 10,000,000` lamports (0.01 SOL), all amounts at most 2^62.
2. **`swap(is_buy, amount_in, min_out)`**. Anyone. Buy: pay SOL, get tokens. Sell: give tokens, get SOL. Exact input, with a minimum output. Section 6 for the maths and the fee.
3. **`add_liquidity(dl, max_tokens, max_sol)`**. Adds `dl` of liquidity at the pool's current price. The depositor pays tokens `ceil(x*dl/l)` and SOL `ceil(y*dl/l)`, both rounded up, and reverts if either exceeds the caps. Opens the position named by `position_id` if it does not exist (the id is the owner's address, or must sign); refuses if it belongs to someone else. Scales the virtual token reserve with the liquidity. Settles pending fees first. `dl >= 1000`.
4. **`remove_liquidity(dl, min_tokens, min_sol)`**. Removes `dl` of the position's unlocked shares. Receives `floor(x*dl/l)` tokens and `floor(y*dl/l)` lamports, both rounded down. Settles pending fees first. Cannot touch locked shares.
5. **`claim_fees()`**. Owner only. Settles and pays the position's pending SOL out of the SOL vault to the position's `recipient`. Works on locked positions.
5a. **`transfer_position(new_owner)`**. Owner only. Hands the whole position to `new_owner`, resets its fee payee to them, and keeps the lock. The seller can do nothing with it afterwards.
5b. **`set_recipient(recipient)`**. Owner only, any time, even on a locked position: the lock covers the liquidity, not where the fees go. Lets a creator send their 80% to a treasury, a multisig or a splitter without moving the position.
6. **`lock_liquidity(amount)`**. Owner only. Adds `amount` shares to `locked`. Irreversible; no instruction lowers `locked`. `amount` is at most the unlocked shares.

There is no instruction to change a fee, a protocol share, the launch schedule or any pool parameter, and no pause. The only thing an owner can redirect is where their own fees are paid.

## 5. Token-2022 handling

Same rule as the Launch page's pool check (`walletPoolCore.ts`) and the curve (`check_mint`), enforced on chain by reading the raw mint bytes:

* Owned by Token-2022 (Token legacy mints are refused by the account type check for now; the Launch page only makes Token-2022 tokens).
* No mint authority (fixed supply).
* **No freeze authority.**
* Extensions: only metadata pointer (18) and token metadata (19). Anything else is refused, which covers **transfer fee (1), transfer hook (14), permanent delegate (12), non-transferable, confidential transfer, default account state** and every extension added later.
* Every transfer uses `transfer_checked`, and the balance of the vault is re-read after each transfer and compared with the amount moved, so a token that somehow moved a different amount is caught rather than trusted.

Because no hook can exist, no third-party code runs inside a swap.

## 6. Swap maths and the fee model

All integer, in `pool-math`, and the program calls nothing else to price a trade.

**Buy** (SOL in): `fee = ceil(gross * fee_bps / 10_000)`, `net = gross - fee`. Pool reserves `X = x`, `Y = y + l`, `k = X * Y` (fits u128 because X and Y are below 2^64, which every operation checks). `Y' = Y + net`, `X' = ceil(k / Y')`, tokens out `= X - X'`. Reserve `y` grows by `net`. Rounds against the buyer twice (fee up, tokens down, the new reserve up).

**Sell** (tokens in): `X' = X + in`, `Y' = ceil(k / X')`, `gross = Y - Y'`, rounded down. Refused when `gross > y`: the pool never pays out SOL it does not really hold, so it can never be driven below its starting price. `fee = ceil(gross * fee_bps / 10_000)` taken from the SOL out. Seller receives `gross - fee`.

**Fee split.** The fee is always in SOL (taken from the SOL input on a buy, from the SOL output on a sell), so there is exactly one fee asset and no token fee accounts. `protocol = floor(fee * 2000 / 10_000)`, paid in the same transaction to the fee wallet. `lp = fee - protocol` stays in the SOL vault outside `y`, is added to `fee_reserve`, and raises `acc` by `lp * 2^64 / l` (rounded down). The curve of the pool is therefore not moved by fees, and fees are claimable by locked positions.

**Claims.** A position's claimable amount is `shares * (acc - checkpoint) >> 64`, rounded down, so the sum of everyone's claims never exceeds the fees credited.

**Rounding rule, stated once.** Every division rounds so that the pool, never the swapper, keeps the remainder: fees up, amounts out down, new reserves up, liquidity deposits up, liquidity withdrawals down, fee credits down. The invariant tests in section 10 check it.

### 6b. Launch protection (anti-sniper fee)

Optional, chosen by the creator at creation, fixed for good. The fee starts at `sniper_bps` (at most 25%) and falls in a straight line to the trading fee over `decay_secs` (at most one hour). `fee_now = base + ceil((start - base) * (decay - elapsed) / decay)`: the part above the base is rounded **up**, so the schedule never undercharges, and it never rises with time (property-tested; the web copy is replayed against Rust vectors at 65 moments). It applies to buys and sells alike, and the same 20% / 80% split applies. The Launch card offers none, standard (10% falling over 5 minutes) and strong (25% falling over 15 minutes), default standard. The stored `fee_bps` is always the base.

The point: a bot that buys in the first seconds pays most of the fee to the creator's position and to Aretia, instead of taking the cheap early tokens for 0.25%. Real buyers who wait a few minutes pay the normal fee. This is also what Meteora's fee scheduler does; the difference here is that the schedule is two numbers on the pool, readable by anyone, quoted exactly by our own router, and paid into the same claimable fees.

### 6d. Price range (concentrated liquidity)

Optional, fixed at creation. A pool made with `vx0 > 0` trades against effective reserves `X = x + vx` and `Y = y + l` instead of bare `x`. Buyers can only ever take real tokens (`out <= x`), so when the real tokens are gone the price has reached its ceiling: with `vx0 = x0 / (s - 1)` the ceiling is `s^2` times the starting price, and the most SOL the pool can raise is `l0 * (s - 1)`. The Launch card offers none, wide (`s = 10`, 100x), medium (`s = 4`, 16x) and narrow (`s = 2`, 4x). The same tokens spread over a band are deeper near the start: buyers move the price less per SOL. This is the shape of a Meteora DAMM v2 pool with a minimum and a maximum price, set pool-wide. What it does not have is a separate price range per position (Meteora's can choose its own ranges per pool too, but not per position, so this is the same). `vx` is bounded between a thousandth and a thousand times the tokens deposited, grows with every add (rounded up) and shrinks with every remove (rounded down), so `X*Y` per share never falls (property-tested on pools with and without ranges).

### 6c. Where fees go

Fees are paid to the position's `recipient`, which is the owner by default and can be changed by the owner at any time, including on a locked position. Meteora's locked positions pay their owner and nobody else unless the position is transferred. Here a creator can lock the liquidity (so buyers can trust it) and still send their share to a multisig, a team wallet or a splitter, and change their mind later, without ever being able to touch the liquidity. The recipient must be able to hold what is paid: an empty wallet needs at least the rent minimum (0.00089 SOL) in one claim.

## 7. Single-sided creation

Same experience as the Meteora flow. The creator enters a token amount `x0` and a starting price in SOL per whole token. The page computes `l0 = floor(x0 * price_lamports_per_raw_unit)` as exact rational arithmetic from the decimal text, sends `y0 = 0`, and the pool opens with no SOL in it. A buyer pays SOL, the price rises along the curve, sells walk back down and stop at the starting price. The creator can also provide both sides (`y0 > 0`), which the curve's graduation needs.

The starting price is the creator's choice and is not checked against any market, exactly as before.

## 8. Permanent lock

`lock` at creation, or `lock_liquidity` later. `locked` shares can never be removed by anyone, the program's upgrade authority included, while the program is unchanged. The lock covers the position's share of both reserves. Fees on it stay claimable. An unlocked creator can remove everything and leave holders with no market; the Launch card defaults to locked and says so.

## 9. Attack list

| # | Attack | Defence |
|---|---|---|
| 1 | Rounding drain by many tiny swaps | All rounding favours the pool (section 6). `k = X*Y` never decreases through a swap (property test, 100,000 cases). A swap that buys or sells zero is refused. |
| 2 | Round trip profit (buy then sell) | Property test: selling what a buy returned yields no more SOL than was paid, fee or no fee. |
| 3 | Add/remove liquidity rounding loop | Deposits round up, withdrawals round down, and `k` after an add is at least `k (1+f)^2`, after a remove at least `k (1-f)^2` (checked with big integers). A add-then-remove of the same shares never returns more than was put in. |
| 4 | First-depositor / share inflation | Shares equal liquidity units exactly, deposits are pro-rata to tracked reserves, not vault balances, and the creator's first deposit is bounded below (`l0 >= 0.01 SOL`). There is no share price to inflate. |
| 5 | Donation to move the price | Reserves are stored numbers. Vault donations are ignored, and cannot block anything. A donation of tokens or SOL to the vaults is simply lost to the donor. |
| 6 | Sandwich of another user's trade | Every swap has an exact-input minimum output. The program cannot stop sandwiching on a public mempool, but the Launch card sets the minimum from a quote with a stated slippage and refuses to submit without one. |
| 7 | Reentrancy-style CPI | State is written before any transfer. The only CPIs go to System, Token-2022, and the ATA program, each by address. Token-2022 mints with hooks are refused, so no foreign code runs mid-swap. Balances are re-read after token transfers. |
| 8 | Fake accounts (wrong vault, wrong mint, wrong fee wallet) | Pool, SOL vault and position are PDAs with stored bumps; the token vault is the pool's associated account; the fee wallet is checked by address; trader token accounts are checked for mint and authority. |
| 9 | Fee wallet griefing (an empty fee wallet below rent) | The fee wallet exists with a balance on mainnet. The verify script checks it before any deployment (same as the curve). |
| 10 | Draining the SOL vault through pending/fee accounting | `fee_reserve` is incremented by the full LP fee and decremented only by what a claim pays; credits to `acc` are rounded down, so `sum(claims) <= fee_reserve`. A solvency check (`vault lamports >= rent + y + fee_reserve`) runs after every instruction that moves SOL. |
| 11 | Removing locked liquidity | `remove_liquidity` allows at most `shares - locked`. `locked` has no decrement path. Tested against a scripted attacker. |
| 12 | Pool created first by a stranger at a bad price | One pool per mint, so any holder of the token could open it before the creator. Only a holder of tokens can; the Launch card checks for an existing pool before it builds anything, and the curve's abort path (section 12) is the recovery. Accepted risk, same as the Meteora flow. |
| 13 | Arithmetic overflow | All reserves and the sum `y + l` are checked to fit u64 on every mutation; products are u128 or, for fee settlement, split into two u128 multiplications. `overflow-checks = true` in the release profile. |
| 14 | A pool drained to dust by an unlocked creator, then a victim adds | Adds are pro-rata to tracked reserves, so a victim pays tokens and SOL in proportion and the caps they sign bound the price they accept. |
| 15 | Upgrade authority abuse | Section 13. |
| 16 | Position takeover | Position PDA is derived from the owner and every owner-only instruction requires the owner's signature. |
| 17 | Account closing / resurrection | Nothing is ever closed. |

What is not defended: price manipulation as such (this is an AMM, anyone can move the price by trading, and arbitrage restores it), impermanent loss, a token whose creator keeps off-chain power, and bugs. **There has been no audit.**

## 10. Tests

* `pool-math` unit tests and proptest properties (`cargo test` in `program/aretia-pool`): `k` monotonic, never pays more than held, round trips lose, fee conservation (`gross = net + protocol + lp`), liquidity adds/removes (big-integer check), claim sum never above credited, accumulator wrap-around.
* LiteSVM integration tests (`program/aretia-pool/tests`, run against the compiled program): every instruction, every refusal, mint rejection (authority kept, freeze kept, transfer-fee/hook-style extensions), lock enforcement, the fee wallet receiving exactly the protocol share, and a **scripted random run** (seeded, 400 operations across five wallets) in which a plain-Rust model predicts every balance and the pool's state, compared after each step.
* Web (`vitest`): core rules and price conversion, instruction bytes against the program's layout, an independent inspector that must refuse each of a long list of tampered transactions, and the flow with every dependency injected.

## 11. What aggregators and the rest of Aretia can and cannot do

* Jupiter and similar routers will not route here until they add this program. We do not ask them to yet, and nothing on the site claims they do.
* The pair is native SOL, not wrapped SOL. An aggregator integration would want either a wrapped-SOL variant or an adaptor; neither is built.
* Aretia's own Radar charting reads pools by address and the Swings swap routes through a registry (section 14). Both can use this pool once enabled.
* Events (`Created`, `Swapped`, `LiquidityChanged`, `Claimed`, `Locked`) are emitted for indexing.

## 12. How the Aretia Curve graduates into an Aretia Pool

The shipped curve (`program/aretia-curve`, mainnet id `CCBr6...`) migrates into a Meteora pool. A pool-based graduation is a **new curve build** and needs its own audit pass; nothing here changes the shipped program.

1. A `migrate_aretia` instruction would replace the Meteora CPI with one CPI to `create_pool`, signed by the curve's `migrator` PDA as `creator`: `x0 = lp_tokens`, `y0 = real_sol`, and `l0` chosen so the opening price is where the curve ended: `l0 = lp_tokens * (v_sol_end) / v_tok_end - real_sol` (a single integer expression, checked in the curve's own maths crate).
2. `owner` is the **curve creator's wallet**, not the migrator, and `lock = true`. This fixes a limitation of the Meteora route, where the position is held by a PDA and nobody can claim its fees. With the pool, the creator claims their share directly.
3. Graduation consumes all of `lp_tokens` and `real_sol`. There is no leftover to return and no price-mismatch window, so the 0.1% dust check disappears.
4. The creation fee (0.05 SOL) is the owner's decision; it can be waived by funding it from the curve's own fee income, or charged to the caller of `migrate`.
5. The abort path stays as it is.

## 13. Upgrade authority and key plan

The program is deployed upgradeable, because an immutable unaudited program cannot be fixed. Authority therefore matters more than any other point in this document.

1. **Devnet**: deployed from the devnet test wallet. Authority stays with it. Worthless money.
2. **Before any mainnet use**: the owner builds with the mainnet program id (its own keypair, kept outside the repo, as with the curve), deploys from their own wallet, and in the same sitting runs `solana program set-upgrade-authority <program> --new-upgrade-authority GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` (the treasury Squads 2-of-3 vault).
3. `website/scripts/pool-solana-mainnet.mjs verify` refuses to pass unless the authority is exactly that vault, the bytes equal the committed artifact (sha-256) and nothing but zeros follows them, the build contains the program id, and the fee wallet is funded.
4. Later options for the multisig: a time-locked upgrade path through Squads, or making the program immutable after an audit. Both are the owner's call.

## 14. Swings swap registry

`website/src/swings/dex/entries.ts` has an `aretia-pool` entry on Solana with `status: 'DISABLED'`, so `registry.routable('solana')` never returns it and no venue code runs. When enabled it needs:

* a venue adapter (BUILT, disabled: `website/src/swings/solana/aretiaPool.ts`, wired in `venues.ts` behind the registry entry, tested against the Rust vectors) that lists the pool for a pair from the PDA `["pool", mint]`, reads `x`, `y`, `l`, `fee_bps` from the account (the layout is fixed in `walletAretiaPoolCore.ts` and tested against the program), and quotes **locally and exactly** with the same integer maths (the venue interface already supports a `localQuote`);
* a `swapInstruction` builder (already in `walletAretiaPoolTx.ts`), with native SOL in or out handled by the program, not by a wrapped account;
* the flip from `DISABLED` to `ACTIVE` only after the audit, a mainnet deployment and `npm run test:live` coverage.

## 15. Not done, on purpose

* No mainnet program id and no mainnet deployment. The mainnet slot in `walletAretiaPoolCore.ts` is `null` and the card shows a notice on mainnet.
* No audit.
* No transferable positions, no wrapped-SOL pool, no multiple fee tiers beyond two, no dynamic fee, no ranges.
* The card covers create (with optional lock), claim, lock, trade (buy and sell, with a slippage floor) and add/remove liquidity, all built from a quote of the pool as just read and each checked by the byte-level inspector. None of it has been run in a browser against devnet.
* Curve graduation into a pool is designed, not built.

## 16. Devnet

Deployed to **devnet only**. First deployment 2026-10-17, upgraded the same day with launch protection and the fee recipient.

* Program id: `4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc` (its keypair is kept outside the repo; the same id is written into the committed build). Upgrade authority: the devnet test wallet.
* Current build: `program/aretia-pool/artifacts/aretia_pool.so`, sha-256 `827e0d28b51ceed6f52eeb60bee5416a260bb54112c83ec901e8ff70c369d51a` (price ranges and transferable positions). Upgrade signature `5AwZwLHDq3GKD1Pm9ZMWdFLWadS9YkWoXCGjUwcGz36CP3dvQwkqvuJZUzPbWUpjJL8b28dQhubZ4jReRtGqind3`. The previous build (launch protection and fee recipient) was upgraded with `39VrBfQ3...`. First deployment signature `416748VZvdwba7A6magNt1PiXhaYcEsE7wKwbK37g8TcjkctVdAHaZT3tGe2Wj5gDsLbouKj3tcxQ6HbSLtV7zYt` (an older build).
* `node scripts/pool-solana-mainnet.mjs verify --program 4EBV... --cluster devnet` passes. The upgrade authority there is not the multisig; that is expected on devnet and would fail the same check on mainnet.
* **A live run through the web code on devnet** (`website/src/scripts/walletAretiaPool.devnet.ts`, signs with a local devnet key, not a browser wallet): made a fixed-supply Token-2022 token, opened a pool with standard launch protection, bought at the launch fee, sold, added and removed liquidity, claimed, redirected fees to a fresh wallet and claimed to it (that wallet received exactly the quoted amount), then locked. Pool `99GzrVSH7Lt4z2Hc3h72F3xVwmhvJP3598naPAK61dbk`, create signature `2bqjdawQ1cuksDRQRAa5rPCWHNPLGRPoqNwW8yhD7K6iUi1bh8YHUNFbBt5s7yQYpNX6aaqmAhhgMFs6qEjR2iPg`. A second run on the current build opened a **ranged** pool (`HiDTcNMHVRH4hRkyvdykcrXmMtchKPKizFiRZYNvvxpX`, create `37WNmXGSgV6yCd8oB3CGLxFvSb8QNRFYyuyv2RHzQQqJjkyP7m29MGEaoXVvTddxdfxxWax8gQn9m8pu5XyuR4ct`), traded, locked, **sold the locked position** to a new wallet (`4XnQPSXTVrTNs37yv8Ar2v5j1D5Aj2gornovDcyV4N7wukxA87K7YpXmAzNpSvsWM3EmKWNFvwY4H71WSvJm9yyW`), confirmed the seller can no longer claim, and had the buyer claim the fees (`3MUdjBs9b3cexNLztT1zKLcEh1dxK5ahggqsh87NzuYrdKdCSPP3FjQrQVhCAimx7FSepe9XCvDJzZEXsGq8F2CE`). Opening cost on devnet this time: 0.0051 SOL on top of the fee. Not done: a browser session with a real wallet extension.

Run the checks:

```
cd program/aretia-pool && cargo test -p pool-math                      # maths and properties
cd program/aretia-pool && cargo build-sbf --manifest-path programs/aretia-pool/Cargo.toml   # set CARGO_TARGET_DIR outside OneDrive on Windows
cd program/aretia-pool/tests && cargo test                             # LiteSVM, needs the .so (ARETIA_POOL_SO overrides the path)
cd program/aretia-pool/tests && cargo run --example vectors > ../../../website/src/scripts/__fixtures__/aretiaPoolVectors.json
cd website && npx vitest run src/scripts/walletAretiaPool
ARETIA_POOL_DEVNET_KEYPAIR=<funded devnet key> npx vitest run --config vitest.devnet.config.ts src/scripts/walletAretiaPool.devnet.ts
```

## 17. Where it is ahead of a Meteora pool, and where it is not

Said plainly, because only some of this is measured.

**Measured**
* Opening cost. Rent for the pool, the position, the token vault and the SOL vault is about 0.005 SOL (LiteSVM and devnet, the position and pool accounts grew a few bytes in this version), plus the flat 0.05 SOL. There is no position NFT mint, NFT token account or second vault, and no wrapped-SOL account. We did not measure a Meteora pool opening side by side, so there is no "x times cheaper" claim here.

**By design** (tested in the program, but a design choice, not a measurement)
* Aretia keeps 20% of every trading fee, paid at trade time. On a Meteora pool opened from the Launch page Aretia keeps none.
* Fees can be redirected while liquidity stays locked (6c), and a locked position can be sold as a whole (the new owner gets the fees; nobody gets the liquidity).
* Launch protection is two readable numbers and is quoted exactly (6b).
* Locally exact quotes: the Swings router can price this pool from its account alone, with no simulation.
* The curve can graduate into a pool whose fees the creator can claim (section 12); on the Meteora route the position belongs to a program account and its fees cannot be claimed.

**Where Meteora is ahead**
* It is audited and has been live for a long time. This is neither.
* Jupiter and every aggregator route to it. They do not route here.
* Dynamic fees, alpha vaults and a large set of tools exist there and not here. Price ranges are pool-wide here, as in DAMM v2; there are no per-position ranges on either.

## 18. What is unaudited and untested on mainnet

Everything. No independent review of the program, the maths or the web code has happened. Nothing has run on mainnet. Mainnet has no program id, the card shows a notice there, and the build flag is off. The 20% protocol share, the 0.05 SOL creation fee, the launch-protection presets and the no-transferable-position design are the owner's to confirm (section 1).
