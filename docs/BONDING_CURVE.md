# Aretia bonding curve

Status: **built and tested on a local VM and on devnet. UNAUDITED. NOT deployed to mainnet. Must not hold real money until an independent audit is done and the owner says go.**

Code: `program/aretia-curve/` (Anchor program in `programs/aretia-curve`, pure maths in `curve-math`, VM tests in `tests`). Web flow: `website/src/scripts/walletCurve*.ts`, behind a flag that is off on mainnet.

What it is: for a fixed-supply token made on the Launch page, the creator can sell tokens on Aretia's own curve instead of opening a pool at a price they pick. Buyers pay SOL and get tokens along a price curve that rises as tokens sell and falls as they are sold back. When every token on the curve is sold, the curve closes and everything it raised, plus tokens set aside for the purpose, moves into a Meteora DAMM v2 pool whose liquidity is locked for good. Aretia takes a fee on every trade.

## 1. Decisions for the owner

| Decision | Built as | Where to change it |
|---|---|---|
| Fee on each trade | **0.58% (58 bps)** of the SOL side, paid to `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`. Confirmed by the owner on 2026-10-16. | `FEE_BPS` in `lib.rs`, `CURVE_FEE_BPS` in `walletCurveCore.ts` (a test keeps them equal). A change is a redeploy; it does not touch curves already open (each stores its own rate). |
| Smallest raise a creator may target | 0.1 SOL | `MIN_TARGET_LAMPORTS` |
| Pool trading fee after graduation | 0.25%, collected **in SOL only** (Meteora's `OnlyB` fee mode, token B being wrapped SOL) and paid to the locked position. `claim_pool_fees` (anyone may call it) sends the position's share to Aretia's fee wallet as wrapped SOL; the liquidity stays locked. Decided by the owner on 2026-10-18. | `POOL_BASE_FEE_NUMERATOR`, `claim_pool_fees` |
| Wait before an unfinished migration can be unwound | 7 days | `ABORT_AFTER_SECS` |

## 2. The curve

Constant product over virtual reserves: `v_sol × v_tok = k`.

A creator chooses two numbers: `total_tokens` (how many tokens to commit) and `target` (SOL the curve should raise). Everything else follows, in integers, in `curve_math::derive`:

```
v_sol0       = target × 6 / 17                      (the 30 : 85 ratio)
lp_tokens    = total × v_sol0 / (2·v_sol0 + target)  (kept back for the pool)
curve_tokens = total − lp_tokens                     (sold along the curve)
v_tok0       = ceil( (v_sol0 + target) × curve_tokens / target )
```

These make the pool open at the price where the curve stopped: pool price = `raised / lp_tokens` equals the curve's last marginal price `v_sol / v_tok`, to within rounding (tested to 1e-6 relative). Example: 1,000,000,000 tokens, target 85 SOL: 793.1M on the curve, 206.9M for the pool, start price 2.80e-8 SOL per token (about 28 SOL for the whole supply), end price 4.11e-7 (about 411 SOL), 14.7× from start to end.

Two invariants hold after every trade (tested as properties, section 8):

- `v_sol − real_sol = v_sol0`: every lamport that enters the vault enters `v_sol`, and the reverse.
- `v_sol × v_tok ≥ k0`: every division rounds against the trader.

From these, a seller can never be paid more than the vault holds.

**Buy** (exact input): the offer's fee is `ceil(offer × bps / 10000)` and comes off first. Tokens out are rounded down. If the offer would buy more than is left, the buy is cut to exactly what is left, priced rounding up, and only that is charged.

**Sell** (exact input): SOL out is rounded down, the fee up. A sale that would put back more tokens than the curve has ever sold is refused.

## 3. How money is held

- **SOL**: in a system-owned PDA, `["sol_vault", curve]`, holding the rent minimum plus exactly `real_sol`. Only this program can move it (system transfers signed with the PDA seeds). It has no data, so system transfers can pay out of it. Accounting is the stored `real_sol`, never the balance, so a donation to the vault is ignored. After every trade the program checks `lamports ≥ rent + real_sol`.
- **Tokens**: in the curve's associated token account (the vault), authority = the curve PDA. After every move the program re-reads the balance and requires it changed by exactly the amount.
- **Fee**: never held. Paid straight to the fee wallet in the same transaction.
- A curve account is never closed, so it cannot be re-created over.

## 4. Instructions

All data is Anchor-encoded (8-byte discriminator `sha256("global:<name>")`, then Borsh little-endian).

| Instruction | Who | What |
|---|---|---|
| `create_curve(total_tokens, target_lamports)` | the creator | Checks the mint (section 7), moves `total_tokens` to the vault, funds the SOL vault with its rent minimum, stores the curve. May be bundled with a first `buy` in one transaction: that is the only way to be first. |
| `buy(gross_in, min_tokens_out)` | anyone | Section 2. Reverts if fewer than `min_tokens_out` result. Only while `Trading`. |
| `sell(tokens_in, min_lamports_out)` | anyone holding tokens | Section 2. Reverts if less than `min_lamports_out` reaches the seller after the fee. While `Trading` or `Aborted`. |
| `migrate(rent_budget, liquidity, sqrt_price)` | anyone | Section 5. Only when `SoldOut`. |
| `abort_migration()` | anyone | Section 5. Only when `SoldOut` and 7 days old. |

There is no admin instruction, no way to change a curve's parameters after creation, and no way to withdraw from it other than `sell` and `migrate`.

States: `Trading → SoldOut → Migrated`, or `SoldOut → Aborted`. Nothing goes back.

## 5. Graduation

The curve closes when the last curve token is sold (`SoldOut`). Raised SOL is about the target (within a couple of lamports). Then anyone calls `migrate`:

1. State is set to `Migrated` and `real_sol` to 0 before any CPI.
2. The caller lends `rent_budget` lamports (at most 0.2 SOL) to a PDA, `["migrator", curve]`, to pay the pool's rent. All of what is left goes straight back to the caller at the end.
3. `lp_tokens` move from the curve's vault to the migrator's token account; `real_sol` moves from the SOL vault to the migrator's wrapped-SOL account.
4. The migrator, as creator and payer, makes a Meteora DAMM v2 customizable pool: token A is the curve token, token B is wrapped SOL, the full price range, flat 0.25% fee, no dynamic fee, no alpha vault, opens at once. The position NFT lands in an account only the migrator can sign for.
5. The migrator permanently locks all the liquidity. This program has no instruction that removes liquidity.
6. **The program does not trust the caller's price.** `liquidity` and `sqrt_price` are computed off-chain and passed in. The program reverts unless the pool took all but 0.1% of **both** the SOL and the tokens that this migration put in. Over a full range that can only happen if the price is the right one. Tested with prices at half and double on each side.

If the migration cannot happen (most likely: someone opened a Meteora pool for the same token and SOL first, which is possible because the pool address is fixed by the two mints), the SOL sits in the vault. After 7 days anyone may call `abort_migration`. Then `sell` reopens and `buy` stays closed, so every holder can leave along the curve. The pool tokens stay in the vault.

The web flow reuses `walletPoolTx.ts` for what the two flows share: the Meteora program ids, the pool authority, the event authority and the token-badge derivation.

## 6. The fee

0.58% of the SOL leg, rounded up, taken on both buys (from the offer, before the curve sees it) and sells (from the SOL the vault pays out). The fee wallet is an address constraint, so a transaction naming any other wallet fails. The rate is stored per curve at creation. Creating a curve costs the creator only rent (about 0.006 SOL). Graduation costs the caller about 0.04 SOL of pool rent that stays in the locked pool's accounts.

## 7. Which tokens are accepted

Only a Token-2022 mint with all of: no mint authority (fixed supply), no freeze authority, and no extension other than the metadata pointer (18) and token metadata (19). That is exactly what the Launch page makes. The program reads the mint's raw bytes (base layout, account-type byte, then every TLV entry) and refuses any other extension type by number, so it does not depend on a library's idea of which extensions it knows. It refuses transfer fees, transfer hooks, permanent delegate, default-frozen accounts, pausing, confidential transfers, close authority and the rest.

## 8. Attack list

| # | Attack | What stops it | What is left |
|---|---|---|---|
| 1 | **Rounding in the trader's favour, drained over many small trades** | All pricing is in `curve-math`. Every division rounds against the trader; `k` never falls. Property tests (2,000 random sequences of buys and sells by four people, fees from 0 to 20%) check both invariants after every step, that no legitimate sale is ever refused, that what leaves the vault never exceeds what entered, and that selling everything back leaves a non-negative remainder. A mutation check (turn the sell's round-up into a round-down) is caught. | Not formally verified. Remainder dust (a few lamports) stays in the vault for good. |
| 2 | Overflow | Token total capped at 2^62, target at 1,000,000 SOL; every product is in u128; release builds keep overflow checks. | |
| 3 | **Reentrancy-style CPI** | The only programs called are System, Token-2022, the legacy Token program (wrapped SOL) and Meteora, each by checked address. State is written before any CPI. Mints with a transfer hook are refused, so no third party's code runs mid-trade. Token balances are re-read after every move. | `migrate` hands the migrator's authority to Meteora for one call. A malicious Meteora upgrade could take what the migrator holds (up to the whole raise). The 0.1% consumption check only proves the pool took the money, not that the position is out of anyone else's reach. |
| 4 | **Front-running, sandwiching** | Every buy and sell carries a minimum out. A creator who wants the first tokens bundles `create_curve` and `buy` in one transaction. | A sandwich inside the slippage limit is inherent to any curve. The creator's first-buy privilege is real: buyers should look at who holds what. |
| 5 | Fake accounts | The curve, SOL vault and migrator are PDAs checked by seeds; the token vault is the curve's associated account; the fee wallet is an address constraint; Meteora's pool authority, event authority, pool address and program are checked or derived; the pool address is checked against the two mints. | |
| 6 | **Authority and upgrade keys** | There is no admin key and no admin instruction. The fee wallet and fee rate are constants. The one powerful key is the **program upgrade authority**: whoever holds it can replace the program and take every vault. | Devnet: held by the deployer key. **Before mainnet it must be a multisig, and the plan for revoking it after audit must be written down.** |
| 7 | **Token-2022 extensions** | Section 7. | Extensions on the *holder's* token account are the holder's: CPI-guard on a seller's account makes their sells fail, memo-required on a buyer's makes their buys fail. Only they are hurt. The token's metadata may be updatable by its creator (a name or link can change). |
| 8 | Donations | Accounting uses stored numbers, never balances. A donation to the SOL vault, the token vault or the migrator's accounts changes nothing, and cannot block `migrate` (the checks are measured from the balance before this migration's own deposit). | Donated money is lost to the donor. |
| 9 | **Squatting the curve** | One curve per mint. Anyone holding tokens of a mint can open its curve first, with their own tokens, and then the real creator cannot open another. | The web flow only opens curves from the creator's own wallet and shows the creator's address on every curve. Buyers must check it. |
| 10 | **Squatting the pool** | The Meteora pool address depends only on the two mints, so anyone holding a few tokens can open a pool first and make `migrate` fail. | Funds are not lost: after 7 days `abort_migration` lets every holder sell out along the curve. The cost is a week of locked money and no graduation. |
| 11 | Creator dumps | Fixed supply and no freeze, so the creator cannot print or freeze. | A creator who kept tokens outside the curve can sell them into it (up to what was sold along it). The curve cannot tell. |
| 12 | Dust and zero trades | A trade that buys or pays out nothing is refused. | |
| 13 | Clock | `abort_migration` reads the cluster clock; validators can move it by seconds. | |
| 14 | Re-initialisation | No curve is ever closed, so a curve address is never reused. | The curve's rent, the SOL vault's rent and any dust are locked for good. |
| 15 | Compute | `migrate` used about 218,000 compute units in the test VM and 227,000 on devnet; the web flow asks for 400,000. | Meteora's cost may change. |
| 16 | **A fee wallet that does not exist yet** | Every trade pays its fee by plain transfer. A transfer that would leave the fee wallet below the rent minimum (0.00089 SOL) fails, so a fee of less than that into an **empty** wallet reverts the trade. The mainnet management-fee wallet already holds SOL. | A fresh cluster (or a changed fee wallet) must be funded once first. On devnet it was funded with 0.002 SOL. |

## 9. What is not done, and known limits

- **No audit.** Nobody but the author has read this code adversarially.
- **Not on mainnet.** Never run with real SOL. Devnet and a local VM only.
- Tested against Meteora's mainnet program binary in the local VM, and against the live Meteora program on devnet (a different build from the mainnet one: the binaries' hashes differ). Meteora's mainnet behaviour was not exercised with a real transaction.
- The pool's trading fee is claimable only to Aretia's fee wallet (`claim_pool_fees`); nobody else can receive it, and no instruction removes liquidity.
- No fuzzing beyond the property tests, no formal verification, no load test.
- A curve that is never fully bought just stays open. There is no refund path for a curve nobody finishes, other than selling back.
- The 7-day wait and the 0.1% tolerance are judgement calls.
- If Meteora ships a new version with a different account layout, `migrate` will fail until this program is redeployed; funds then wait, and `abort_migration` is the way out.

## 10. Tests

| Where | What |
|---|---|
| `curve-math` unit and property tests | 11 tests: derivation, price continuity, the drain property, round trips, monotonic pricing. `cargo test --release` in `program/aretia-curve/curve-math`. |
| `programs/aretia-curve` unit tests | The mint check against hand-built mint data. |
| `tests` (LiteSVM, the compiled program) | 14 tests: creation and every refusal, a buy matched to the maths to the lamport, slippage and wrong accounts, round trips, donations, selling out, closed trading, early and late abort and the unwind, a scripted 120-step random run compared with the model and the vault's real balances, the full migration into Meteora's mainnet binary (position fully locked, held only by the migrator, pool holding the raise), wrong-price refusal, wrong-pool refusal, and curves from a thousand raw tokens to the program maximum all moving into a pool. Build the program first (`cargo build-sbf`), then `cargo test` in `program/aretia-curve/tests`. The Meteora tests need Meteora's binary (`solana program dump cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, path in `METEORA_CP_AMM_SO`) and skip without it. |
| Web | `walletCurve*.test.ts`: the rules, the byte-level inspector (every unexpected program, account, amount or signer refused), the flow. |

Build notes for Windows: do not build into a OneDrive folder (the linker cannot write there); set `CARGO_TARGET_DIR` elsewhere.

## 11. Before mainnet

1. Independent audit of `programs/aretia-curve` and `curve-math`.
2. Owner confirms the fee rate, the minimum target and the 7-day wait.
3. Upgrade authority moved to a multisig; revocation plan written.
4. A real-money rehearsal with a small curve on mainnet, by the owner, watched.
5. Only then set the flag (`PUBLIC_CURVE_ENABLED=true`) and the mainnet program id in `walletCurveCore.ts`.

## 11b. Mainnet deployment (Solana)

Program id: `CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu`, its own key made by the owner (the key file stays outside the repo and signs only the first deployment). The id is written into the program at build time (`declare_id!`), so the committed build in `program/aretia-curve/artifacts/aretia_curve.so` (with its `.sha256`) is built for this id and no other. The devnet program (section 12) has a different id and keeps running its old build.

`website/scripts/curve-solana-mainnet.mjs` never holds a key and sends nothing:
- `prepare` checks Meteora's program and the fee wallet, prints the cost (rent that stays locked in the program's accounts) and the four commands to run.
- `verify --program <id>` checks that the deployed bytes are exactly the committed build, that the build was made for this id, that the **upgrade authority is the treasury multisig vault** `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` (a single key that can replace the program can take every vault), and that the fee wallet is funded.

The owner deploys from their own wallet, then hands the upgrade authority to the multisig in a second command (a multisig cannot sign the deploy itself). Only after `verify` passes is the id put in `CURVE_PROGRAM_ID_MAINNET` (`walletCurveCore.ts`) and the gate test updated. The site flag `PUBLIC_CURVE_ENABLED` is already on in production for the EVM curves, so setting the id makes the Solana card live at once: rehearse with a very small curve straight after.

**Re-checked 2026-10-23, and the deploy cost re-measured.** The committed build (395,024 bytes, sha-256 `0275bb1f…ed5a5`) equals its `.sha256`, contains `CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu` exactly once (the `declare_id!`), and has no `.STALE` marker. **Deploy rent is 2.0084 SOL, not 2.75 and not 1.6133:** the node charges 5,080 lamports per byte of (128 + length), so the 395,069-byte data account costs 2,007,600,760 lamports and the 36-byte program account 833,120; total 2,008,433,880 lamports. The 2.75 SOL (and 2.7517 from the arithmetic at 6,960 lamports per byte) was the old rate; the 1.6133 SOL was a smaller, older build at that old rate. The deploy command now passes `--max-len 395024` explicitly (the CLI default is the build's own size anyway). Fund the deployer with 2.06 SOL; `prepare` asks the node and prints the live figure. Before deploying, re-run the test suite with Meteora's current binary (`prepare` prints the commands; six tests skip without it). After `verify` prints Verified, `website/scripts/wire-solana-mainnet-id.mjs curve --address <id> --i-ran-verify` makes the one-line change and updates the gate tests. The full ordered list is `docs/MAINNET_GO_LIVE.md`.

Still true on mainnet: **no independent audit**. The program holds buyers' SOL.

**2026-10-18:** rebuilt from the fixed source (see `AUDIT_2026-10-18.md`), now with `claim_pool_fees` and SOL-only pool fees. Built with `cargo-build-sbf` 2.1.21 (platform-tools v1.43, Rust 1.79) against the committed `program/aretia-curve/Cargo.lock`. The lockfile used to be git-ignored, and a build resolved against the newest crates came out with `migrate`'s account-loading frame over the 4 KB stack limit and crashed at runtime. **After any rebuild, the build log must contain no "Stack offset ... exceeded" line.** `migrate` now opens the migrator's two token accounts in its handler, which keeps that frame well inside the limit. Build: sha-256 `698b499a04f3ecefaafb383e1d4cb4e3d9e34dc587b40fb21fef47bbf98dd81e`. All 17 LiteSVM tests pass against this build with Meteora's mainnet binary (`METEORA_CP_AMM_SO`), run on the owner's machine on 2026-10-18: every migration test, and the fee claim, which paid 27,671,517 lamports to the fee wallet for about 11 SOL of pool trades (0.25%, with no protocol share kept by Meteora). Deploy rent for this size is about 2.75 SOL (`prepare` prints the exact figure).

**2026-10-20:** rebuilt after the 2026-10 full review (`docs/audit/2026-10-full-review/REPORT.md`). Changes: a sell that would pay the seller nothing after the fee is refused (L-8, so row 12 of section 8 now holds for sells too; the web copy `quoteSell` refuses it as well); `migrate` also requires the migrator's leftover token and wrapped-SOL balances to be at least what those accounts held before the pool took anything, so a donation can no longer loosen the 0.1% rule (I-11); and the vault's rent floor is now the rent-exempt minimum or what the vault held beyond its debt before the instruction, whichever is lower (I-13), so a later rise in rent cannot freeze sells. That last change reads the rent the vault paid from the vault itself: **no field was added and the account layout is unchanged** (still 189 bytes), because the web reader parses curve accounts of exactly that size for the devnet program too and `aretia-curve-grad` has live devnet curves. If rent rises, emptying the very last of a vault below the new minimum is still refused by the runtime (not the program) until anyone sends the vault the difference, which the curve ignores. Same toolchain and lockfile as above; the build log has no "Stack offset ... exceeded" line. Build: **395,024 bytes, sha-256 `0275bb1f7a1844b8d1a993d501538947866cd0ee928283f3b412e111006ed5a5`** (968 bytes larger than the 2026-10-18 build). 19 LiteSVM tests pass against it here, including the new L-8 and I-13 regression tests (both fail against the 2026-10-18 build), but **the six migration and fee-claim tests skip here because Meteora's binary is not available, so the owner must re-run the whole suite with `METEORA_CP_AMM_SO` on their own machine before deploying** (the I-11 check runs only inside `migrate`). Deploy rent for this size is about 2.751 SOL, about 0.0067 SOL more than the previous build (`prepare` prints the exact figure).

## 12. Devnet

Program id: `9HVuUHU4mm6PYZFRnY7KzuGsHVSZ8QUVavarJLpJt5f4`, upgradeable, upgrade authority `DWkwVbRZ3WUPSxLdmLdnNeq3rAkrev5vusjkpwrjU4fw` (the devnet deployer key; **a single key, so devnet only**). The program keypair is not in the repo.

Deployed 2026-10-16, then upgraded the same day to the 0.58% fee from source at commit `1c9fe3b`. Built with `cargo build-sbf` (release profile `opt-level = "s"`), 317,240 bytes, sha-256 of the `.so` `459006a479c3e91dfb19249c66615e262903ddf6f49803212fcefbc15aed4399` (the on-chain data matches it byte for byte). It was first deployed with `--max-len` equal to its size to save devnet SOL, so a bigger build needs `solana program extend` first.

A full run through the web flow code against the upgraded program (`npm run test:curve-devnet` in `website`, with `CURVE_DEVNET_KEYPAIR` set) passed: make a fixed-supply Token-2022 token, open a curve (1,000,000,000 tokens, target 0.1 SOL), buy, sell half back (the Aretia fee reached the fee wallet to the lamport, at 0.58%), buy the rest with an oversized offer (only what was left was charged), and move into a Meteora pool, whose position was locked in the same transaction. The numbers each step showed matched the chain every time.

| Step | Transaction (devnet) |
|---|---|
| Open the curve | `pRkQ83KrPQaTZ9LSRetsnuumWdk4oSwcEE1fB69UqiXmtL2fpL7yM4JLdJQbkPpvX2Gc2sKVBzAZTukpxCqVnvp` |
| Buy | `21MdXUmhAkM1vAd9gyTshFjyywwus2xxyvhD9YvR58BfjsGpQpeSzypw7BvTqp1CVXuXVTedueCP8Uwyeijd7Riu` |
| Sell | `CBz1CoLf4iZRBZ8Rmpap9SJqcBa5WG2AQZy9AdSRTo1JqmyzwiantLGK5m9rBxszT9rvRmfDr7oyEN5mb4CttkK` |
| Sell out | `C9DYopWDa9FdVV3NHx1yEStvtFZfjWKQ2mERWEUbsrCsGL8X4hup1tcpKPjjctnhSsLQBWieners3chBadAYdpc` |
| Move into a pool | `4vCtwtEaxGrrWrVj67rrunFowZGX3DCDbxZ7iYx1e5vWvLrziA44FbFjJkpoKDEroJqVgvcfSTQc2knb1iYtoFY6` (pool `H8A7FZVJRHs13263j42jpvvgAwSWDDfQBZwJYnVG7XJ1`, curve `8YbPb4pbcDRqzMMRzvYcC9wwGs8x87Lo7Y6HivimHHDy`) |

The devnet run used a single wallet as creator and buyer; a second wallet buying was covered in the local VM only.

## 13. The card, run in a browser against devnet

`website/dev/curve-harness/` is a local-only page (not part of the site build) that runs the real Launch-page card against the devnet program, with two throwaway test keys, generated fresh and kept in memory only, standing in for wallets. Start it with `npx vite --config dev/curve-harness/vite.config.ts` in `website` and open `http://localhost:4391/curve-harness/`; fund the two addresses it shows with devnet SOL. It uses a small seam in `initCurve` (`opts.program`, `opts.deps`) that the wallet page never uses.

Run on 2026-10-16 with the card's own buttons, creator and buyer as two different wallets: make a token, review and open a curve (0.3 SOL target), switch wallet, look the curve up, buy 0.1 SOL, sell 100,000,000 tokens back, buy the rest with an oversized offer (the card then offered "Move into a pool"), and move it into a Meteora pool. Every step's review screen showed the right numbers and every result was read back from the network as matching. What this did not cover: a real browser wallet (the harness signs with a local key), the mobile layout, and the "Unwind this curve" button.

## 14. What a creator sees (added after section 13's run)

- After a token is made on the Launch page, a "Sell it on a bonding curve" button sits beside "Open a liquidity pool for it" (only where the card exists, so not on mainnet today).
- The create form shows, as the creator types, how the tokens split, the first and last token price, how many times the price rises, and what the whole supply is worth at each end. One-tap targets of 10, 30 and 85 SOL.
- A finished curve gives a link, `#/launch/curve/<token address>` on the Launch page, that opens it for anyone, with a progress bar and the state in plain words.
- Run in the browser harness on devnet: the live preview, the presets, creating a curve, the done screen with its share link, "View your curve", and opening the link in a fresh page with different keys. Not run: the button on the token-created screen (covered by a source test only), a real wallet, mobile.
