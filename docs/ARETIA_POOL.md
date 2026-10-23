# Aretia Pool

Aretia's own constant-product swap pool for Solana. It exists so that Aretia, not Meteora, keeps a protocol share of the trading fees on pools opened from the Launch page.

**Status: UNAUDITED. Deployed to devnet only. Never run on mainnet. The Launch card is behind a build flag that is off. Aggregators (Jupiter and others) do not route to it and will not until they integrate it.**

Program: `program/aretia-pool` (Anchor 0.30.1, same toolchain and conventions as `program/aretia-curve`).
Maths: `program/aretia-pool/pool-math` (pure integer maths, no Solana dependency, property-tested).
Web: `website/src/scripts/walletAretiaPool*.ts`.

## 1. Decisions for the owner

These are set as constants in the program. Each is a one-line change before a mainnet build, and none can change after deployment (there is no admin instruction).

**Decided by the owner, 2026-10-18** (confirmed as built, no program change needed): 20% protocol share; 0.05 SOL creation fee, also paid when a curve graduates (by whoever calls `migrate`, from its rent budget); the launch-protection presets as they are (none, standard 10% over 5 minutes, strong 25% over 15 minutes, standard the default); Meteora is the default pool for a new token until Jupiter routes the Aretia Pool, then the default flips; token logos and metadata are hosted on an IPFS pinning service.

| Decision | Value now | Notes |
|---|---|---|
| Protocol share of the trading fee | 20% (2000 of 10,000) | Meteora's own default protocol share is the same figure, so a creator sees no worse deal. Paid to the fee wallet on every trade, no claim step. |
| Creator-chosen trading fee | 0.25% or 1% | The only two values the program accepts. |
| Flat creation fee | 0.05 SOL | Taken by the program inside `create_pool`, to `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`. |
| Fee when a Curve graduates into a pool | 0.05 SOL (decided) | Section 12. Paid by whoever calls `migrate`, from the rent budget it lends, not from holders' SOL. The curve program also takes its own 0.58% on every trade. |
| Quote asset | Wrapped SOL (v4) | The pool's SOL side is a wrapped-SOL token vault, so routers and trackers read it like any other pool; a wallet wraps and unwraps SOL around each transaction. Section 11. |

## 2. The pool in one paragraph

One pool per token, always against wrapped SOL (a token, held in the pool's own associated account). It is a constant-product curve (`X * Y = k`) with a virtual SOL reserve, which is what makes single-sided creation possible: the creator deposits only tokens, the virtual reserve sets the starting price, and the pool holds no real SOL until people buy. Nobody can sell tokens into the pool for more SOL than buyers have paid in, so the price can never fall below the starting price, which is the same behaviour as our Meteora single-sided pools (a Meteora position whose minimum price equals its starting price and whose maximum price is unbounded). Liquidity is a single number, `L`, measured in lamports of virtual SOL. Liquidity providers hold shares equal to `L`, fees accrue separately from the reserves, and a position can be locked permanently.

## 3. State

### Pool (PDA `["pool", mint]`)

| Field | Type | Meaning |
|---|---|---|
| bump, sol_bump | u8, u8 | The pool's bump. `sol_bump` is unused since v4 (always 0): the SOL vault is the pool's associated wrapped-SOL account, not a PDA of its own. Kept so the layout did not move. |
| mint | Pubkey | The token. The quote side is always wrapped SOL. |
| creator | Pubkey | Who opened it. Informational only; gives no power. |
| fee_bps | u16 | 25 or 100, fixed at creation. |
| x | u64 | Real token reserve: what is actually in the token vault for trading. |
| vx | u64 | Virtual token reserve. Zero means no upper price; otherwise it sets a price ceiling (section 6d). Scales with liquidity. |
| y | u64 | Real SOL reserve (lamports of wrapped SOL). Zero at single-sided creation. |
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
* **SOL vault**: the pool's associated token account for the native (wrapped-SOL) mint, authority the pool PDA. It holds `y + fee_reserve` (plus anything strangers donate, which is ignored). A tracker reads it as an ordinary token balance.

Reserves are numbers in the pool account, never the vault balances. A donation to either vault changes nothing.

## 4. Instructions

All instructions revert with a named error on any failure; nothing is partially applied.

1. **`create_pool(x0, y0, l0, fee_bps, lock, sniper_bps, decay_secs, vx0)`**. Creator signs. Checks the mint (section 5). Moves `x0` tokens into the token vault and `y0` wrapped lamports (usually zero, taken from the creator's wrapped-SOL account) into the SOL vault (made here), plus the rent minimum for the SOL vault, pays the 0.05 SOL creation fee to the fee wallet, writes the pool, and opens the owner's position with `shares = l0` (`locked = l0` when `lock`). The `owner` of the position is a separate account passed in, normally the creator, and the curve's graduation sets it to the curve's creator (section 12). Bounds: `x0 >= 1000`, `l0 >= 10,000,000` lamports (0.01 SOL), all amounts at most 2^62.
2. **`swap(is_buy, amount_in, min_out)`**. Anyone. Buy: pay SOL, get tokens. Sell: give tokens, get SOL. Exact input, with a minimum output. Section 6 for the maths and the fee. After its ten accounts it takes four optional read-only ones (the fee wallet, the native mint, the System program, the associated-token program): if Aretia's wrapped-SOL fee account has been closed, the swap opens it again with the trader paying its rent, so trading never stops (L-21). The web builder and the Jupiter adapter always pass them; a client that does not still works while the account exists.
3. **`add_liquidity(dl, max_tokens, max_sol)`**. Adds `dl` of liquidity at the pool's current price. The depositor pays tokens `ceil(x*dl/l)` and SOL `ceil(y*dl/l)`, both rounded up, and reverts if either exceeds the caps. Opens the position named by `position_id` only when its account was just created (its `pool` field is still empty; it is written once and never cleared), so an existing position is never re-initialised and its checkpoint and pending fees are never rewritten (M-5); the id is the owner's address, or must sign; refuses if the position belongs to someone else. Refused while the creator's launch fee is above the base fee (L-22): nobody can add just before a big launch-window buy, take most of the launch fee and leave; adding opens the moment the schedule ends. Scales the virtual token reserve with the liquidity. Settles pending fees first. `dl >= 1000`.
4. **`remove_liquidity(dl, min_tokens, min_sol)`**. Removes `dl` of the position's unlocked shares. Receives `floor(x*dl/l)` tokens and `floor(y*dl/l)` wrapped lamports, both rounded down. Settles pending fees first. Cannot touch locked shares. The pool always keeps at least `MIN_LIQUIDITY` (0.01 SOL of liquidity, the least it can open with, the same rule as the EVM pool's `MIN_L`), so no removal can leave `l = 0` and a pool that can never trade or be re-created (L-23); a creator who opened at exactly that minimum and did not lock therefore cannot remove anything. `dl >= 1000`, except that a position may always remove all of its own unlocked shares, however few (I-15).
5. **`claim_fees()`**. Owner only. Settles and pays the position's pending SOL, in wrapped SOL, out of the SOL vault to a wrapped-SOL account owned by the position's `recipient` (the claim transaction makes it if missing, and unwraps it when the recipient is the owner). Works on locked positions. Never pays into the pool's own SOL vault (I-16).
5a. **`transfer_position(new_owner)`**. Owner only. Hands the whole position to `new_owner`, resets its fee payee to them, and keeps the lock. The seller can do nothing with it afterwards. `new_owner` may not be the default key `1111...1111` (also the System program's id) or the pool itself (M-5). **Sending a position to such an address is not a burn**, and is refused: before this fix the id holder could take it back. The only burn is `lock_liquidity` of every share.
5b. **`set_recipient(recipient)`**. Owner only, any time, even on a locked position: the lock covers the liquidity, not where the fees go. Lets a creator send their 80% to a treasury, a multisig or a splitter without moving the position. The default key and the pool itself are refused (I-16).
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
| 8 | Fake accounts (wrong vault, wrong mint, wrong fee account) | Pool and position are PDAs with stored bumps; the token vault and the SOL vault are the pool's associated accounts, checked by address; Aretia's fee account is the fee wallet's wrapped-SOL account, checked by address; trader accounts are checked for mint and owner. |
| 9 | Aretia's fee account missing | A swap pays Aretia's share into the fee wallet's wrapped-SOL account. If it has been closed (the normal "unwrap" in a wallet), the swap opens it again, the trader paying about 0.002 SOL of rent, provided the four optional trailing accounts are passed (the web builder and the Jupiter adapter always pass them). A client that omits them gets `FeeAccountMissing` while the account is closed. Treasury runbook all the same: do not close it. |
| 10 | Draining the SOL vault through pending/fee accounting | `fee_reserve` is incremented by the full LP fee and decremented only by what a claim pays; credits to `acc` are rounded down, so `sum(claims) <= fee_reserve`. A solvency check (`vault token amount >= y + fee_reserve`) runs after every instruction that moves SOL. |
| 11 | Removing locked liquidity | `remove_liquidity` allows at most `shares - locked`. `locked` has no decrement path. Tested against a scripted attacker. |
| 12 | Pool created first by a stranger at a bad price | One pool per mint, so any holder of the token could open it before the creator. Only a holder of tokens can; the Launch card checks for an existing pool before it builds anything, and the curve's abort path (section 12) is the recovery. Accepted risk, same as the Meteora flow. |
| 13 | Arithmetic overflow | All reserves and the sum `y + l` are checked to fit u64 on every mutation; products are u128 or, for fee settlement, split into two u128 multiplications. `overflow-checks = true` in the release profile. |
| 14 | A pool drained to dust by an unlocked creator, then a victim adds | Adds are pro-rata to tracked reserves, so a victim pays tokens and SOL in proportion and the caps they sign bound the price they accept. A pool can never be emptied: removals stop at `MIN_LIQUIDITY` (L-23). |
| 15 | Upgrade authority abuse | Section 13. |
| 16 | Position takeover | The position PDA is derived from its id (the opener's address, or a key that signed for itself) and every owner-only instruction requires the current owner's signature. A position is initialised only when its account is new (`pool` still empty), never because its owner looks empty, and it cannot be sent to the default key or the pool. Before the 2026-10 fix, a position "burned" to `1111...1111` could be re-initialised by the id holder and its unlocked liquidity withdrawn (M-5). To give liquidity up for good, lock it. |
| 17 | Account closing / resurrection | Nothing is ever closed. |
| 18 | Just-in-time liquidity in the launch window | Adding is refused while the launch fee is above the base fee (L-22), so nobody can take the creator's share of the launch fee by adding right before a big buy and removing right after. The simpler of the two options the review offered; a minimum holding period would have needed new position state. |
| 19 | Fees sent back into the pool | A recipient equal to the pool, or the default key, is refused, and a claim never pays into the pool's own SOL vault (I-16). |

What is not defended: price manipulation as such (this is an AMM, anyone can move the price by trading, and arbitrage restores it), impermanent loss, a token whose creator keeps off-chain power, and bugs. **There has been no audit.**

## 10. Tests

* `pool-math` unit tests and proptest properties (`cargo test` in `program/aretia-pool`): `k` monotonic, never pays more than held, round trips lose, fee conservation (`gross = net + protocol + lp`), liquidity adds/removes (big-integer check), claim sum never above credited, accumulator wrap-around.
* LiteSVM integration tests (`program/aretia-pool/tests`, run against the compiled program): every instruction, every refusal, mint rejection (authority kept, freeze kept, transfer-fee/hook-style extensions), lock enforcement, the fee wallet receiving exactly the protocol share, and a **scripted random run** (seeded, 400 operations across five wallets) in which a plain-Rust model predicts every balance and the pool's state, compared after each step.
* Web (`vitest`): core rules and price conversion, instruction bytes against the program's layout, an independent inspector that must refuse each of a long list of tampered transactions, and the flow with every dependency injected.

## 11. What aggregators and the rest of Aretia can and cannot do

* Jupiter and similar routers will not route here until they add this program. We do not ask them to yet, and nothing on the site claims they do.
* The pair is (token, wrapped SOL), the same as Meteora and Raydium pools, so a router's ordinary wrap and unwrap of SOL works. This was native SOL in v1 to v3 and changed in v4 for exactly this reason. A Jupiter AMM adapter exists (`program/aretia-pool/jupiter-amm`); Jupiter's own integration is theirs to do.
* Aretia's own Radar charting reads pools by address and the Swings swap routes through a registry (section 14). Both can use this pool once enabled.
* Events (`Created`, `Swapped`, `LiquidityChanged`, `Claimed`, `Locked`) are emitted for indexing.

## 12. How the Aretia Curve graduates into an Aretia Pool

**Built and tested; devnet only.** The shipped curve (`program/aretia-curve`, mainnet id `CCBr6...`) is untouched and still graduates into a Meteora pool. Graduation into an Aretia Pool is a **separate copy**, `program/aretia-curve-grad`, with its own program id (`Ak12tX3J3m5rSmWLXUttyDpVAsniszkfvVG1GgWmnuBm`, devnet), so the audited-bound mainnet build does not change. It needs its own audit and a mainnet pool program id. The pool id is a constant in the copy, gated by a cargo feature (L-31): a default build points at the devnet pool program; a build with `--features mainnet` refuses to compile until the mainnet pool program id (and the copy's own mainnet `declare_id!`) are written in, so a mainnet build can never ship pointing at the devnet pool.

`migrate(rent_budget)`, callable by anyone once the curve has sold out:
1. The caller lends the migrator PDA up to 0.2 SOL for the pool's creation fee (0.05 SOL, to the fee wallet) and rent; what is left comes back.
2. The curve's vault hands the migrator the tokens set aside for the pool and all the SOL raised, wrapped (lamports into the migrator's wrapped-SOL account, then synced). The empty wrapped-SOL account is closed afterwards and its rent goes back to the caller.
3. One CPI to the pool's `create_pool`, signed by the migrator as creator: `x0 = lp_tokens`, `y0 = SOL raised`, `l0 = 0.01 SOL` (the pool's smallest liquidity), 0.25% fee, **locked**, no launch schedule, no range. The position's **owner is the curve's creator**, who can therefore claim and redirect its fees. On the Meteora route the position belongs to a program account and its fees cannot be claimed.
4. Checks: the migrator's token account is back to where it started, and the pool's stored `x`, `y`, `l` equal exactly what was sent. Either all of it happens or none.

Price: the pool opens at `(SOL raised + 0.01) / tokens` against the curve's last price `SOL raised / tokens`: a premium of 0.01 SOL over the raise, 0.012% on an 85 SOL raise but 10% on the smallest 0.1 SOL raise (the 0.01 SOL virtual liquidity is the pool's floor; the alternative of withholding 0.01 SOL from holders was rejected). The test asserts within 0.1% on a 20 SOL curve.

Tests (`program/aretia-curve-grad/tests`, LiteSVM, against both compiled programs): the old curve tests, plus: migrate refused until sold out, refused for wrong owner / pool / creator accounts and an oversized or too-small budget (nothing moves), a locked pool opens with the creator as owner and the exact amounts, a holder then sells into the graduated pool through the pool program, a second migration is refused, and curves of 0.1, 1, 3 and 85 SOL all graduate. Devnet deployment: see section 16.

Not done: a web flow for the new curve (the Launch card's curve still talks to the shipped curve), the abort path's interplay with a pool opened first by a stranger (unchanged: after seven days anyone may unwind), and a mainnet build.

## 13. Upgrade authority and key plan

The program is deployed upgradeable, because an immutable unaudited program cannot be fixed. Authority therefore matters more than any other point in this document.

1. **Devnet**: deployed from the devnet test wallet. Authority stays with it. Worthless money.
2. **Before any mainnet use**: the owner builds with the mainnet program id (its own keypair, kept outside the repo, as with the curve), deploys from their own wallet, and in the same sitting runs `solana program set-upgrade-authority <program> --new-upgrade-authority GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` (the treasury Squads 2-of-3 vault).
3. **The committed `aretia_pool.so` is built for the devnet id and cannot be used on mainnet:** it needs a rebuild with the mainnet id (`aretia-curve-grad` too, which refuses to compile with `--features mainnet` until both ids are set). Deploy rent at the 2026-10-23 rate is about 2.07 SOL for the pool and 1.81 SOL for the graduation program; steps and commands are in `docs/MAINNET_GO_LIVE.md`, and `website/scripts/grad-solana-mainnet.mjs` checks the graduation program. `website/scripts/pool-solana-mainnet.mjs verify` refuses to pass unless the authority is exactly that vault, the bytes equal the committed artifact (sha-256) and nothing but zeros follows them, the build contains the program id, and the fee wallet is funded.
4. Later options for the multisig: a time-locked upgrade path through Squads, or making the program immutable after an audit. Both are the owner's call.

## 14. Swings swap registry

`website/src/swings/dex/entries.ts` has an `aretia-pool` entry on Solana with `status: 'DISABLED'`, so `registry.routable('solana')` never returns it and no venue code runs. When enabled it needs:

* a venue adapter (BUILT, disabled: `website/src/swings/solana/aretiaPool.ts`, wired in `venues.ts` behind the registry entry, tested against the Rust vectors) that lists the pool for a pair from the PDA `["pool", mint]`, reads `x`, `y`, `l`, `fee_bps` from the account (the layout is fixed in `walletAretiaPoolCore.ts` and tested against the program), and quotes **locally and exactly** with the same integer maths (the venue interface already supports a `localQuote`);
* a `swapInstruction` builder (already in `walletAretiaPoolTx.ts`), with the SOL side as ordinary wrapped-SOL token accounts (the adapter is built and tested, `website/src/swings/solana/aretiaPool.ts`, and still disabled);
* the flip from `DISABLED` to `ACTIVE` only after the audit, a mainnet deployment and `npm run test:live` coverage.

## 15. Not done, on purpose

* No mainnet program id and no mainnet deployment. The mainnet slot in `walletAretiaPoolCore.ts` is `null` and the card shows a notice on mainnet.
* No audit.
* No multiple fee tiers beyond two and no dynamic fee. (Transferable positions, the wrapped-SOL vault and price ranges are built: sections 3, 4 and 6.)
* The card covers create (with optional lock), claim, lock, trade (buy and sell, with a slippage floor) and add/remove liquidity, all built from a quote of the pool as just read and each checked by the byte-level inspector. None of it has been run in a browser against devnet.
* Curve graduation into a pool is built and tested as a separate devnet program (sections 12 and 19); it has no web flow and no mainnet build.

## 16. Devnet

Deployed to **devnet only**. First deployment 2026-10-17, upgraded the same day with launch protection and the fee recipient.

* Program id: `4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc` (its keypair is kept outside the repo; the same id is written into the committed build). Upgrade authority: the devnet test wallet.
* Current build (v4: wrapped-SOL vault): `program/aretia-pool/artifacts/aretia_pool.so`, sha-256 `04324868051f80ffafe99ca336905e35f97fdc4891d26da6472251aee5e81c02`, upgrade signature `2Wg1WwBttZcucFt8Hq9g76xD1p6LmmcfCczDSZp2mxTnFbnnvZnQPtKPRRqudHMbs7MGT36WK9NoV5NGms8cfPJW`. Earlier builds (v1 to v3, native-SOL vault) were upgraded over the same id; pools made by them are not readable by this layout (none exist outside tests). The previous build (launch protection and fee recipient) was upgraded with `39VrBfQ3...`. First deployment signature `416748VZvdwba7A6magNt1PiXhaYcEsE7wKwbK37g8TcjkctVdAHaZT3tGe2Wj5gDsLbouKj3tcxQ6HbSLtV7zYt` (an older build).
* `node scripts/pool-solana-mainnet.mjs verify --program 4EBV... --cluster devnet` passes. The upgrade authority there is not the multisig; that is expected on devnet and would fail the same check on mainnet.
* **A live run through the web code on devnet** (`website/src/scripts/walletAretiaPool.devnet.ts`, signs with a local devnet key, not a browser wallet): made a fixed-supply Token-2022 token, opened a pool with standard launch protection, bought at the launch fee, sold, added and removed liquidity, claimed, redirected fees to a fresh wallet and claimed to it (that wallet received exactly the quoted amount), then locked. Pool `99GzrVSH7Lt4z2Hc3h72F3xVwmhvJP3598naPAK61dbk`, create signature `2bqjdawQ1cuksDRQRAa5rPCWHNPLGRPoqNwW8yhD7K6iUi1bh8YHUNFbBt5s7yQYpNX6aaqmAhhgMFs6qEjR2iPg`. A second run on the current build opened a **ranged** pool (`HiDTcNMHVRH4hRkyvdykcrXmMtchKPKizFiRZYNvvxpX`, create `37WNmXGSgV6yCd8oB3CGLxFvSb8QNRFYyuyv2RHzQQqJjkyP7m29MGEaoXVvTddxdfxxWax8gQn9m8pu5XyuR4ct`), traded, locked, **sold the locked position** to a new wallet (`4XnQPSXTVrTNs37yv8Ar2v5j1D5Aj2gornovDcyV4N7wukxA87K7YpXmAzNpSvsWM3EmKWNFvwY4H71WSvJm9yyW`), confirmed the seller can no longer claim, and had the buyer claim the fees (`3MUdjBs9b3cexNLztT1zKLcEh1dxK5ahggqsh87NzuYrdKdCSPP3FjQrQVhCAimx7FSepe9XCvDJzZEXsGq8F2CE`). A third run on the **v4** build (wrapped-SOL vault) opened a ranged pool (`5NN2r2vqyNASC6Sh4okktZbeaB5wykeapuV7Lzif5P19`, create `2ph2H1mc4P4FQsFs91pu4kM4877ie4jhLoSWt8AixRywWn2yexEgBr9Tfj85W7AW2gkT9BvaoUVBYYMYP8C3iFq1`), bought and sold with the SOL wrapped and unwrapped inside each transaction, added and removed liquidity, claimed to another wallet's wrapped-SOL account, locked, sold the locked position and had the buyer claim. Opening cost on devnet: 0.0074 SOL on top of the fee (rent for the pool, position, two vaults, and Aretia's wrapped-SOL account the first time). **Browser run** (`website/dev/aretia-pool-harness`, the real card in a browser against devnet with throwaway in-page keys, not a wallet extension): opened a ranged pool, then a second wallet with no token account bought through the card, sold, and the creator claimed. The first attempt found a bug (a buyer with no token account for the token was refused in the trial run); the buy and add-liquidity transactions now first create the wallet's own token account (idempotent), and the inspector accepts that one extra step, byte for byte, and nothing else. **Second browser run, on the v4 program, every screen:** open (unlocked, medium range), buy and sell from a wallet with no token account, add and remove liquidity (checked against the chain's own events), claim, name another fee recipient, lock, give the position away, then claim it as the new owner by its id. It found two more card bugs, both fixed and covered by tests: (1) the liquidity box did not refresh its quote when left, so Add and Remove used a stale amount (the chain showed adds and removes at amounts that were not the ones typed); (2) after a transfer the old owner's lookup still showed the position as theirs with action buttons. Not done: a real wallet extension (the harness signs with in-page throwaway keys).

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
* Opening cost. Rent for the pool, the position, the token vault and the wrapped-SOL vault, plus Aretia's own wrapped-SOL account the first time, measured on devnet at about 0.0074 SOL (network fee included), plus the flat 0.05 SOL. There is no position NFT mint, NFT token account or second pool vault. We did not measure a Meteora pool opening side by side, so there is no "x times cheaper" claim here.

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

Everything. No independent review of the program, the maths or the web code has happened. Nothing has run on mainnet. Mainnet has no program id, the card shows a notice there, and the build flag is off. The 20% protocol share, the 0.05 SOL creation fee, the launch-protection presets and the transferable-position design are the owner's to confirm (section 1).

## 19. Graduation program on devnet

`program/aretia-curve-grad`, id `Ak12tX3J3m5rSmWLXUttyDpVAsniszkfvVG1GgWmnuBm`, build sha-256 `fb539435d376b9ea727a8c1cc207d412d27b8e1d8af4ada02b3a3dd42cf293d5` (v4: the raised SOL is wrapped before it goes into the pool), deployed to devnet only, upgrade signature `3xptuGsjbFrWNV2PgBcX9FA4N113GMesrbTP6tjat8SJMroLLxDuH2wHqGr51a2zPjoQVxi1CYpJMmAJUBqdbuhT`. Upgrade authority: the devnet test wallet. A live devnet graduation has **not** been run (the LiteSVM tests run the same bytes); trading outside Aretia is in `docs/ARETIA_POOL_INTEGRATION.md`.

## 20. Fixes from the 2026-10 full review

The findings are in `docs/audit/2026-10-full-review/REPORT.md`. Changes to `aretia-pool` (sections 4 and 9 describe the result): M-5 (positions are initialised only on a fresh account; no transfer to the default key or the pool), L-21 (a swap reopens a closed fee account), L-23 (a pool always keeps `MIN_LIQUIDITY`), I-15 (a position can always take out all of its own unlocked shares), I-16 (no recipient equal to the pool or the default key, and no claim into the SOL vault), L-22 (no adding during the launch fee). The maths changes are in `pool-math` (`remove(p, dl, available)`, `adding_open`) and mirrored line for line in `website/src/scripts/walletAretiaPoolCore.ts` (`removeLiquidity(p, dl, available)`, `addingOpen`), with the fixture `aretiaPoolVectors.json` regenerated from the Rust (remove steps now carry `available`). The swap's four optional trailing accounts are in the IDL, the web builder and inspector, and the Jupiter adapter (`get_accounts_len` is 14). The web inspector also refuses to send a position or its fees to the pool or the default key.

Not changed: a pool sell whose SOL out is all fee is still accepted (as with the curve before L-8, the `min_out` floor every client sets prevents it in practice), and the three new errors (`FeeAccountMissing`, `LaunchFeeActive`, `BadRecipient`) are appended at the end of `PoolError`, so earlier error codes are unchanged. Pools that were already emptied on devnet (`l = 0`) stay unusable.

New build: `program/aretia-pool/artifacts/aretia_pool.so`, **407,488 bytes, sha-256 `ff97a2fdf5663d4fbc5c9fef0341f38905bcd77235afadfd98844020f71ed1a2`**, built with `cargo-build-sbf` 2.1.21 against the committed lockfile, with no "Stack offset ... exceeded" line (the swap's fee account is now an address-checked unchecked account opened in the handler, which keeps the frame small). It is 8,368 bytes larger than the previous build: deploy rent about 2.837 SOL, about 0.058 SOL more; a devnet upgrade over a program deployed with `--max-len` equal to the old size needs `solana program extend` first. **Not yet deployed to devnet**: the devnet program (`4EBV...`) still runs a pre-fix build until the owner upgrades it. LiteSVM: 29 tests pass, including one regression test per finding, each of which fails against the previous build (bar the one that checks a top-up keeps settled fees, which held before too).

`aretia-curve-grad` was rebuilt with the same curve fixes as `aretia-curve` (L-8, I-13; see BONDING_CURVE.md section 11b) and the L-31 feature gate: `program/aretia-curve-grad/artifacts/aretia_curve_grad.so`, **356,168 bytes, sha-256 `4eb16715f2410e7de5ac61c15a4b4d634ce39f48f37ad93647070b5373161421`**; 18 LiteSVM tests pass against it and the new pool build. Its devnet deployment (section 19) still runs the older build.

