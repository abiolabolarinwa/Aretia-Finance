# Aretia Pool on BNB Chain, Ethereum and Polygon

Aretia's own constant-product swap pool for Ethereum-style chains: the EVM version of the Solana Aretia Pool (`docs/ARETIA_POOL.md`). It exists for the same two reasons: Aretia keeps a protocol share of the trading fees only on pools it owns, and a creator can lock liquidity for good and still earn **claimable** fees. Today's EVM pools (Uniswap V2 and PancakeSwap V2, which `walletPoolEvm*.ts` opens) cannot do either: their locked LP tokens earn nothing that anyone can claim, and Aretia gets nothing.

**Status: UNAUDITED. Not deployed on any mainnet. Deployed on Sepolia only (section 11). The Launch card is behind a build flag that is off. Aggregators and routers do not know this contract and will not route to it.**

Contract: `contracts-evm/AretiaPool.sol` (solc 0.8.26, optimizer 200, EVM paris, so one build runs on every chain below). Committed artifact: `AretiaPool.artifact.json`, rebuilt by `compile-pool.mjs`.
Web: `website/src/scripts/walletAretiaPoolEvm{Core,Tx,Flow}.ts`, the card in `walletAretiaPoolEvm.ts`, and `walletYourPoolsEvm*.ts` for the Your pools page.

## 1. Decisions for the owner

All are constants or constructor arguments. None can change after deployment (there is no admin function). Each is a one-line change before a mainnet build.

| Decision | Value now | Notes |
|---|---|---|
| Protocol share of every trading fee | 20% (`PROTOCOL_SHARE_BPS = 2000`) | Same as Solana. Sent to the fee address inside the trade. No claim step, no way around it. |
| Creator-chosen trading fee | 0.25% or 1% | The only two values the contract accepts. |
| Flat creation fee | The chain's token-creation fee: 0.0042 ETH, 0.014 BNB, 105 POL | Constructor argument `creationFee`, paid inside `createPool` to the fee address. Testnets use the testnet token-creation fees (0.0001, 0.0001, 0.1). |
| Fee address | `0xeb8725e16e504036c2166aa47804d88ecc4d0945` | Constructor argument `feeRecipient`, the same on every chain. |
| Quote asset | The chain's native coin only | Section 4. |
| Fee when a curve graduates into a pool | Not set | Section 9. |

## 2. What is the same as Solana

* One pool per token per chain, always against the quote asset.
* Constant product `X * Y = k` with a virtual quote reserve `l`. **Single-sided creation**: the creator deposits only tokens, `l` sets the starting price, and the pool holds no real coin until people buy. Nobody can sell for more coin than buyers paid in, so the price never falls below the start.
* The same integer maths: buy takes the fee off the coin first (rounded up) and prices the rest rounding tokens out down; sell prices the coin out rounding down, refuses a sale that would pay out more coin than the pool really holds, and takes the fee from the coin out (rounded up). Every rounding favours the pool.
* Fee tiers 0.25% and 1%. The fee is always in the coin, so there is exactly one fee asset. `protocol = floor(fee * 2000 / 10_000)` is sent to Aretia during the trade; the rest (`lp`) stays in the contract outside the reserves, raises a per-share accumulator (`acc += lp * 2^64 / l`, rounded down) and is claimable by liquidity positions, **locked or not**.
* Liquidity is one number, `l`, equal to shares. Add: the depositor pays `ceil(x*dl/l)` tokens and `ceil(y*dl/l)` coin. Remove: `floor` of both. Fees settle first. `k` per share never falls.
* Permanent lock (`lock` at creation, `lockLiquidity` later; nothing lowers it). Locked liquidity can never be removed by anyone; its fees stay claimable.
* Fee recipient per position (`setRecipient`) works on locked liquidity: the lock covers the liquidity, not where the fees go.
* Transferable positions (`transferPosition`): the whole position, lock included, moves to a wallet that has no position in that pool; the fee payee resets to the new owner.
* No admin keys, no pause, no way to change a fee, the share or a recipient after deployment, a solvency check after every call that moves coin, state written before any external call, a reentrancy lock, and balance checks on every token movement.

## 3. What differs from Solana, and why

| Topic | Solana | EVM | Why |
|---|---|---|---|
| Token checks | Reads the raw Token-2022 mint bytes: no mint authority, no freeze authority, only metadata extensions | **Only tokens made by Aretia's own factory** are accepted. The creator names the factory's CREATE nonce and the contract recomputes the token's address from it (same proof as `AretiaCurve.sol`) | A contract cannot inspect another contract's behaviour on the EVM, and "has no mint function" cannot be proved from outside. Provenance can: the factory only ever deploys `AretiaToken` (fixed supply, no owner, no mint, pause, blacklist, hook or fee on transfer). Anything else is refused with `not from the factory`. The cost: tokens made elsewhere cannot get an Aretia Pool. |
| Defence under that rule | Balance re-read after each transfer | The same: every token movement is compared with the pool's balance change; a token that moved a different amount, returned false or lied reverts the whole call | A fee-on-transfer or false-returning token cannot do damage even if one were somehow accepted (tested with a pool whose "factory" makes hostile tokens). |
| Launch protection (anti-sniper fee) | Optional decaying fee | **Not built** | Keeps the first EVM contract small and reviewable. The creator's own first buy can be made in the creation transaction (`firstBuyWei`), which is what stops bots buying first. A later version can add a schedule. |
| Price ranges (`vx`) | Optional | **Not built** | Same reason. Every EVM pool trades against bare `x` and `y + l`. |
| Creation fee | 0.05 SOL | The chain's token-creation fee, a constructor argument | Owner's instruction: equal to what Launch already charges on that chain. |
| Positions | PDA per `(pool, id)` | `positions[token][owner]`, one per wallet per pool | Smaller. A wallet that wants two positions uses two wallets, or transfers one away. |
| Last liquidity | An unlocked creator can remove everything | At least `MIN_L` (10^12 wei) of liquidity always stays | The pool never reaches `l = 0`, which would divide by zero in the fee accumulator. |
| Bounds | u64 | Every reserve below 2^112, so every product below 2^224 | No overflow anywhere, with `unchecked` never used. |
| Coin dust and failing receivers | Rent minimum on the fee wallet | A receiver that reverts when paid can only block its own sale or claim. The fee address is fixed, so a pool cannot be blocked by a changed recipient. If the fee address were a contract that reverts, every trade would revert: the verify script checks it is an ordinary account. |

## 4. The pair: native coin, not wrapped

**Decision: the pool's quote asset is the chain's native coin, held by the contract directly. Nothing is ever wrapped, inside swaps or otherwise.** A buy is a payable call (`buy(token, minOut)` with the coin as `msg.value`); a sell pays out coin with a plain call.

Why: the pool then holds no WETH/WBNB/WPOL contract dependency and no wrapped-coin approvals, there is no wrapper whose behaviour the pool must trust, and the Solana pool made the same choice (native SOL). The coin is one accounting asset, so the solvency check is the contract's balance against what it owes.

What it costs, said plainly: a router that expects a token/WETH pair will not recognise this pool. Aggregators would need an adaptor. The owner asked for a pair "against the chain's wrapped coin"; if that matters for routing, the follow-up is a thin wrapper contract (`buyWithWrapped`, `sellForWrapped`) around the same pool, which adds a trusted wrapper to the audit scope and is not built here.

## 5. Interface

All reverts carry a short reason string.

* `createPool(CreateParams)` payable: `token, factoryNonce, x0, l0, y0, feeBps, lock, owner, firstBuyWei, minFirstBuyOut`. Send exactly `creationFee + y0 + firstBuyWei`. Needs the token approved for `x0`. Bounds: `x0 >= 1000`, `l0 >= 10^12`, everything below 2^112. `y0` is usually zero (the curve graduation would use it). `owner` is normally the caller.
* `buy(token, minTokensOut)` payable. All of `msg.value` is used.
* `sell(token, tokensIn, minCoinOut)`. Needs the token approved.
* `addLiquidity(token, dl, maxTokens)` payable: pay at least `ceil(y*dl/l)`; the excess is returned. `dl >= 1000`.
* `removeLiquidity(token, dl, minTokens, minCoin)`.
* `claimFees(token)`, `lockLiquidity(token, amount)`, `transferPosition(token, to)`, `setRecipient(token, recipient)`.
* Views: `pools`, `positions`, `quoteBuy`, `quoteSell`, `pendingFees`, `totalOwed`.
* Events: `Created`, `Swapped`, `LiquidityChanged`, `Claimed`, `Locked`, `PositionTransferred`, `RecipientSet`.

## 6. Attack list

| # | Attack | Defence |
|---|---|---|
| 1 | Rounding drain by many tiny swaps | Every rounding favours the pool; `k` never falls (property test); a swap that gives zero reverts. |
| 2 | Round-trip profit | Property test: a buy then a sell of what it returned never returns more coin than was paid, fee or no fee. |
| 3 | Add/remove rounding loop | Deposits round up, withdrawals down; an add then remove never returns more than was put in (property test). |
| 4 | First-depositor / share inflation | Shares equal liquidity units exactly; deposits are pro rata to the stored reserves, not to balances. There is no share price to inflate. |
| 5 | Donation to move the price | Reserves are stored numbers. Coin sent by `selfdestruct` or tokens sent to the contract change nothing and are lost to the donor. `receive()` reverts. |
| 6 | Sandwiching | Every swap has a minimum output; the card sets it from a quote with stated slippage. A public mempool cannot be defended against beyond that. |
| 7 | Reentrancy | `nonReentrant` on every state-changing function; state is written before any token transfer or coin send; tested with a token that re-enters during a transfer and a contract wallet that re-enters when paid. |
| 8 | Hostile token | Only factory tokens are accepted; under that every transfer is balance-checked (fee on transfer, false return, lying balance, no-op transfer: all revert). |
| 9 | Fee-address griefing | Fixed, ordinary account; the verify script checks it. |
| 10 | Draining through fee accounting | `feeReserve` rises by the full LP fee and falls only by what a claim pays; credits round down so claims never sum to more than credited; `balance >= totalOwed` after every call. |
| 11 | Removing locked liquidity | `removeLiquidity` allows at most `shares - locked`; `locked` has no decrement path; `transferPosition` keeps it. |
| 12 | A stranger opens the pool first at a bad price | Anyone holding the token can. The card checks for an existing pool first. Accepted risk, same as Solana and Meteora. |
| 13 | Position takeover | Positions are keyed by the caller's address; every position function acts on `msg.sender`'s own. |
| 14 | Pool drained to dust, then a victim adds | Adds are pro rata and capped by `maxTokens` and `msg.value`. |
| 15 | Forged token | The factory-CREATE proof; a future nonce has no code, so the first call to it reverts. |

Not defended: price manipulation as such (this is an AMM), impermanent loss, a token whose creator keeps off-chain power (not possible for factory tokens), a dishonest page, bugs. **There has been no audit.**

## 7. Tests

* `website/src/scripts/walletAretiaPoolEvmContract.test.ts` runs the committed artifact and the real token factory in an in-process EVM (`npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util @ethereumjs/block`; skipped without it): every function and refusal, the exact fee split, locked claims, transfer, recipient, **properties** (round trip never profits, fee split sums exactly, `k` never falls, add/remove never profits, solvency after every step), a **seeded scripted random run** against a BigInt model that predicts every balance and every pool number after each step, **reentrancy** (token and receiver), and **hostile tokens** (fee on transfer, false return, lying balance, no-op transfer).
* `walletAretiaPoolEvmCore.test.ts`, `…Tx.test.ts`, `…Flow.test.ts`: rules, calldata bytes, an independent inspector that must refuse a long list of tampered transactions, and the flow with every dependency injected.
* `walletYourPoolsEvm.test.ts`: listing and claiming.

## 8. Web flow

* **Pure core**: validation, the starting price to `l0`, quotes using the same integer maths as the contract (tested against the compiled contract), disclosures.
* **Builder and inspector**: the builder makes approve, create, buy, sell, add, remove, claim, lock, transfer, set-recipient transactions. The inspector decodes the bytes of the transaction about to be signed and compares them with what the person approved, never calling the builder; it refuses a wrong `to`, a wrong chain, an unexpected field, a wrong amount, an unlimited approval, a different spender, extra coin, or any calldata that is not exactly the expected call. The contract address comes from a constant, never from the page or chain.
* **Flow**: all dependencies injected (wallet, reads, clock). Reads the pool as it is now, builds from that quote, runs the inspector on the exact object given to the wallet, and refuses a pool whose on-chain `feeRecipient`, `creationFee` or `factory` differs from the constants.
* **Card**: on the Launch page behind `PUBLIC_ARETIA_POOL_EVM_ENABLED`, which is off. A chain is also off until its pool address is written in the table.
* **Your pools**: lists the wallet's Aretia Pool positions on each enabled EVM chain (from `Created`, `PositionTransferred` and `LiquidityChanged` logs, then `positions` and `pendingFees`) and claims.

## 9. How the Aretia Curve should graduate

The deployed curve (`0x4e85bc5b…` on Ethereum, BNB Chain, Polygon) is immutable and graduates into a V2 pool with the liquidity tokens sent to the dead address. That pool earns nobody a claimable fee and pays Aretia nothing. **It should graduate into Aretia Pool**, and `createPool` is built for it: `x0 = lpTokens`, `y0 = realSol`, `l0` chosen so the opening price equals where the curve ended (`l0 = lpTokens * vSol / vTok - realSol`, the same expression as the Solana design), `owner` = the curve's creator, `lock = true`. Graduation then leaves nothing over, has no price-mismatch window, and the creator can claim.

That is a **new curve contract**, because the deployed one is immutable, and it needs its own audit. It is not built here. Whether graduation pays the creation fee is the owner's call.

## 10. Not done, on purpose

* No mainnet deployment of anything. No audit.
* No launch protection, no price ranges, no wrapped-coin pair, no aggregator adaptor.
* Curve graduation into Aretia Pool (section 9).
* No wallet-extension run of the card; the flow is tested with injected dependencies and, on testnets, with a script that signs with a test key (section 11).

## 11. Deployment and what has actually been run

**Sepolia: DEPLOYED AND VERIFIED (2026-10-18).** Test token factory `0xac1b5010eab26f6d5e53e0ee9c246376a914891e`, pool `0x5e93e9023e8891ffbe7bfac6e989d64fe49a3421` (block 11939451), deployed by the throwaway test key `0x5B708eC0393c7799D985CCa3D331c4C6202E2421`. `pool-evm.mjs verify` passed every check against the live network, and `walletAretiaPoolEvm.devnet.ts` ran the real web flow against Sepolia end to end (token made by the factory, pool with a first buy, buy, sell, add, remove, locked liquidity refused, claim while locked, fees redirected and claimed to a fresh wallet, position handed over). The pool address, deploy block and test factory are written into `walletAretiaPoolEvmCore.ts`. The run found one real-network problem, now fixed: a public node can answer an allowance read from a block just before the approval, so the flow re-reads a few times before treating a mismatch as real.

**BSC testnet and Amoy: NOT deployed yet.** They need tBNB and test POL on the same deployer address, then:

```
cd website
npm i --no-save viem
DEPLOYER_KEY_FILE=<that key file> node scripts/pool-evm.mjs deploy --chain bscTestnet --send     # also deploys a test token factory
node scripts/pool-evm.mjs verify --chain bscTestnet --address <pool> --factory <factory>
```

Same for `polygonAmoy`. Then write the printed addresses and deploy block into `EVM_POOL_ADDRESSES`, `EVM_POOL_DEPLOY_BLOCKS` and `EVM_POOL_TEST_FACTORIES`. The deploy script refuses every mainnet chain id and has no mainnet `send`.

**Also run, on a local node first:** the same deploy and verify scripts, unchanged, against a local test node (ganache, chain id set to Sepolia's, throwaway key). The factory and the pool deployed, `verify` passed every check (byte-for-byte code, `factory()`, `feeRecipient()`, `creationFee()` equal to the factory's fee, the constants, solvency) and failed correctly when pointed at the wrong contract. Then `walletAretiaPoolEvm.devnet.ts` drove the real web flow (with its inspector) against that node over JSON-RPC: made a token with the real factory, created a pool with a first buy, bought, sold, added and removed liquidity, refused to remove locked liquidity, claimed fees while locked, redirected the fees to a fresh wallet and claimed to it (exact amount), and handed the position over. A local node is not a public testnet: it proves the scripts, the flow and the contract work together over RPC, not that anything works on those networks.

**Mainnet read-only checks:** `pool-evm.mjs prepare` was run for Ethereum, BNB Chain and Polygon. It only reads: it confirmed each chain's token factory exists, pays the Aretia fee address and charges exactly the creation fee used here (0.0042 ETH, 0.014 BNB, 105 POL), and that the fee address is an ordinary account. Nothing was signed or sent to any mainnet. Runtime keccak of the committed build with each chain's constructor arguments: Ethereum `0x7df9e3dd…a529`, BNB `0xc458a218…f0f3`, Polygon `0xb975df74…af8c`.

Re-run the live flow any time with:

```
POOL_EVM_KEY_FILE=<key> POOL_EVM_CHAIN=sepolia POOL_EVM_RPC=<node> POOL_EVM_POOL=0x… POOL_EVM_FACTORY=0x…   npx vitest run --config vitest.devnet.config.ts src/scripts/walletAretiaPoolEvm.devnet.ts
```

Run the rest:

```
cd website
npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util @ethereumjs/block solc@0.8.26
NODE_PATH=$PWD/node_modules node ../contracts-evm/compile-pool.mjs ../contracts-evm            # rebuild the artifact; it must not change
NODE_PATH=$PWD/node_modules node ../contracts-evm/test-mocks/compile-pool-mocks.mjs ../contracts-evm
npx vitest run src/scripts/walletAretiaPoolEvm src/scripts/walletYourPoolsEvm
```

On Windows build and test outside OneDrive.

## 12. What is unaudited and untested on mainnet

Everything. No independent review of the contract, the maths or the web code has happened. Nothing has run on mainnet. The owner confirms the 20% share, the fee tiers and the creation fees (section 1) before any mainnet build.
