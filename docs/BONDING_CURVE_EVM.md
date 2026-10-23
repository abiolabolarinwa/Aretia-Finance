# Aretia bonding curve, Ethereum-style chains

Status: **DEPLOYED and IMMUTABLE on Ethereum, BNB Chain and Polygon** at `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` (sections 12 to 14), verified on each explorer. **Not independently audited.** The web card stays off unless a build sets `PUBLIC_CURVE_ENABLED=1`. The October 2026 review (`docs/audit/2026-10-full-review/REPORT.md`) found issues that cannot be fixed in the deployed contract; they are handled around it (sections 15 to 18) and listed for any future version (section 19).

This is the same product as the Solana curve (`BONDING_CURVE.md`) for Ethereum first, then BNB Chain and Polygon. Read that file for the curve shape and the reasoning; this one only records what differs.

Code: `contracts-evm/AretiaCurve.sol`, its compiled form `AretiaCurve.artifact.json` (and the exact compiler input `AretiaCurve.standard-input.json`), test stand-ins in `contracts-evm/test-mocks/`, tests in `website/src/scripts/walletCurveEvmContract.test.ts` and `walletCurveEvm.fork.ts`.

## 1. What is the same

The curve maths (`v_sol × v_tok = k`, the 6 : 17 virtual reserve, the split that makes the pool open at the curve's last price, fee rounded up, tokens and coin out rounded down, an oversized buy cut to what is left), the **0.58%** fee on the coin side of every trade, one curve per token, a 7-day wait before an unfinished graduation can be unwound, and the two states `SoldOut` and `Aborted`. The contract is checked step by step against a BigInt copy of the Rust maths, which is itself checked against vectors the Rust prints.

## 2. What is different, and why

| | Solana | Ethereum-style |
|---|---|---|
| Who may change it | The program upgrade authority (a key) | **Nobody.** No owner, no admin function, no proxy. To change anything, deploy a new contract; old curves keep working on the old one. |
| Which tokens | Raw check of the mint for a fixed supply and a short list of extensions | **Only tokens made by Aretia's own factory.** The creator names the factory's CREATE nonce; the contract recomputes the address and refuses anything else. The factory only ever deploys `AretiaToken` (a plain ERC-20: no owner, mint, pause, fee or hook), so no foreign code runs mid-trade. |
| Where the money sits | A system account per curve | One contract holds all curves. A running total of what it owes (`totalOwed`) is checked after every trade, so one curve can never spend another's coin. |
| Graduation | Meteora DAMM v2, position permanently locked | The network's Uniswap V2-style exchange (Uniswap V2 on Ethereum), liquidity tokens sent to the dead address. |
| Verifying the pool | Both sides at least 99.9% consumed | The same, plus the pool's price must be within 1% of the curve's last price, read back from the pair. |
| Creating | One transaction | **Two:** an approval for exactly the tokens, then `createCurve`. Selling also needs an approval first. The creator's own first buy can ride in the same `createCurve` call (any coin sent with it), so nobody can buy before the creator; if that buy would give less than the creator asked, the whole creation reverts. |
| Minimum raise | 0.1 SOL | 0.01 of the chain's coin (a constant). |

## 3. Decisions for the owner

| Decision | Built as |
|---|---|
| Fee | 0.58% (58 bps), to the EVM fee address `0xeb8725e16e504036c2166aa47804d88ecc4d0945` (the constructor argument; the same one the token factory uses). |
| Where each curve is deployed | One contract per chain, pinned at deployment to that chain's token factory, fee address and exchange router. Ethereum: factory `0x951a22270faa7d1c25efad2356c414cbddaba324`, Uniswap V2 router `0x7a250d5630b4cf539739df2c5dacb4c659f2488d`. |
| Minimum raise | 0.01 ETH (`MIN_TARGET`), maximum 1,000,000. |
| Locking | Liquidity tokens to the dead address. The pool's trading fees then accrue to the pool and **cannot be claimed** by anyone. |

## 4. How it works

`createCurve(token, factoryNonce, total, target, minFirstBuyOut)` payable: proves the token is the factory's, pulls `total` tokens in (approval first), stores the curve, and makes the creator's first buy with any coin sent. `buy(token, minTokensOut)` payable: pays `msg.value`, fee to the recipient, any part of the payment not needed (a cut-down final buy) back to the buyer. `sell(token, tokensIn, minCoinOut)`: pulls tokens in (approval first), pays the seller, fee to the recipient. `graduate(token)`: anyone, once sold out. `abortMigration(token)`: anyone, 7 days after selling out. `quoteBuy` is a read-only helper. The contract only accepts coin from the exchange (the refund of unused coin at graduation) or with a `buy`.

## 5. Attack list

| # | Attack | What stops it | What is left |
|---|---|---|---|
| 1 | Rounding in the trader's favour | The maths is the Rust crate's, in the same order. A 60-step random run of buys and sells by three people, in the EVM, matches the model at every step and the contract's balance equals what it owes. | Not formally verified. |
| 2 | **Reentrancy** | A lock on every function that moves value, and state is written before any external call. A buyer contract that tries to sell again from inside its payout is refused; removing the lock from `sell` makes that test fail. | |
| 3 | **A fake or hostile token** | Only addresses the factory's CREATE produces are accepted; the factory deploys only `AretiaToken`. A token deployed by hand with identical code is refused at every nonce size. | If the factory is ever replaced, a new curve contract must be deployed for it. |
| 4 | **A pool made first at another price** | The exchange's own minimums plus the price check refuse. Tested against the real Uniswap V2 code (a pool 100× cheaper makes `graduate` revert with the exchange's own message). After 7 days `abortMigration` reopens selling so holders leave along the curve. | **It is cheap:** 1 wei of WETH and `sync()` blocks graduation, without holding the token (review M-4). Mitigated by the rescue helper (section 15), which repairs the pair and graduates in one transaction. |
| 5 | **A pool made first and then skewed after the check** | The price is read back from the pair after the deposit, in the same transaction, and the transaction reverts if it is off by more than 1%. | Someone can still move the price after graduation, as in any pool. |
| 6 | Front-running, sandwiching | Every buy and sell carries a minimum. | Inherent to any curve. On Ethereum the public mempool makes it easier; a private-relay option in the web flow is worth considering. |
| 7 | Forced coin (self-destruct) or a donation | Accounting uses stored numbers; the solvency check is `balance ≥ owed`, so extra coin only helps. | The donor's coin is stuck. |
| 8 | Upgrade or admin keys | There are none. | A bug cannot be fixed in place: deploy a new contract. |
| 9 | Fee recipient that rejects coin | A rejecting recipient would make every trade revert. The recipient is fixed at deployment. | **Under EIP-7702 a plain account can become code** (review M-2): the fee key is a privileged freeze key. Operational rules in section 17. |
| 10 | Creator dumps | Fixed supply, no mint, no pause. | A creator (or anyone) holding tokens outside the curve can sell them into it, up to what was sold, **and buyers are then locked out of selling** (review M-3). The page shows the outside share on every card (section 18). |
| 11 | Squatting | One curve per token; anyone holding the token can open its curve first. | Same as Solana: the page shows who opened a curve. A stricter rule (only the factory's `TokenCreated` creator) is not possible without an on-chain record the factory does not keep. |
| 12 | Gas | Measured in the test EVM (execution gas, before the 21,000 base cost): the first buy on a curve about 123,000, later buys about 42,000, a sell about 56,000. **Graduating into the real exchange with a new pool cost about 2.8 million gas on Ethereum and Polygon and 3.5 million on BNB Chain**, mostly the exchange creating the pair. | Real gas money to whoever calls `graduate` (anyone). At 20 gwei that is about 0.055 ETH, so the web flow must say who pays and how much before it is signed. |

## 6. Tests

| What | Result |
|---|---|
| In-process EVM with the real compiled contract and the real token factory code, and a stand-in exchange | 17 tests, 4 of them driving the page's own flow code against the contract (open a curve with a first buy, buy, sell, sell out, graduate, unwind, and a tampered transaction refused). The 13 contract tests: the maths against the model, the factory-only rule at every nonce size, fees to the wei, every refusal, an oversized buy, a 60-step random run, reentrancy (with a mutation check), graduation, a pool at another price and the 7-day unwind, immutability (no owner, setter, upgrade or withdraw in the ABI). |
| A local copy of each of Ethereum, BNB Chain and Polygon mainnet (read-only RPC), Aretia's **real deployed factory** on each, and the **real Uniswap V2 / PancakeSwap V2 / QuickSwap** router, factory and pair code | A curve opened with a token made by the real factory, bought out, and graduated: pair created, tokens and coin in at the right ratio, liquidity tokens held by the dead address, nothing owed. A pool created first at another price makes graduation revert with the exchange's own message. All three chains pass. |

Run them: `npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util @ethereumjs/block @ethereumjs/statemanager` in `website`, then `npx vitest run src/scripts/walletCurveEvmContract.test.ts` and `npm run test:curve-fork`. They are skipped or separate in CI, as the factory's test is, because the EVM library is not a website dependency.

## 7. Not done

- **No independent audit.** The contract is deployed on Ethereum, BNB Chain and Polygon (sections 12 to 14) and cannot be changed.
- The fork test does not check what happens after a revert (the lazy state manager does not roll back storage); that is covered by the in-process tests.
- The solc build is not yet reproduced by a second person. The compiler input is committed so anyone can.
- The web flow exists (section 8) but has only been run against the contract in a local EVM, never in a browser with a real wallet. BNB Chain (PancakeSwap V2) and Polygon (QuickSwap) pass the same mainnet-copy test; they still need their own testnet deployments and the owner's go-ahead.
- Fee-on-transfer or rebasing tokens are not supported and cannot occur: only factory tokens are accepted.

## 8. The web flow

`website/src/scripts/walletCurveEvm{Core,Tx,Flow}.ts` and the card `walletCurveEvm.ts`, drawn under the pool card on the Launch page's Ethereum-style networks, in the same style as the Solana curve and the EVM pool.

- **Core:** the maths in BigInt (no 64-bit limit), forms, the proof that a token came from the factory (the page searches the factory's CREATE nonces, newest first, with the same RLP rule the contract uses), reading a curve from the contract's answer, a live preview, presets (1, 5, 20 of the coin), and plain-language notes.
- **Transactions and the inspector:** approve (exactly the tokens, to the curve, never unlimited), create (which carries the creator's first buy), buy, sell, graduate, unwind. The inspector decodes each from its bytes and refuses a changed digit anywhere in the data, another contract, another sender, another amount of coin, an extra field, a gas limit that is not a number, or the wrong network.
- **Flow:** prepares, inspects, simulates, switches the wallet to the right network, sends, waits for the receipt, then reads the curve back and compares. If the second transaction of a pair cannot go ahead it says the approval stays for exactly the tokens and nothing else happened.
- **Off by default:** the card exists only on a build with `PUBLIC_CURVE_ENABLED=1`. `EVM_CURVE_ADDRESSES` holds the three deployed addresses; a network without one shows "not live" and nothing else. A test pins the flag, and pins every shared constant and every function selector to the contract's source and compiled ABI.
- **Around the deployed contract:** every curve card shows the total supply, the share on the curve, the share outside it and the opener's live balance, with a warning when anything is outside (section 18); a graduation blocked by a pre-made pair is explained, and goes through the rescue helper once `EVM_CURVE_RESCUE_ADDRESSES` names one (section 15).

## 9. Putting it on a test network

`website/scripts/deploy-curve-testnet.mjs` deploys the token factory and the curve to Sepolia, BNB Chain testnet or Polygon Amoy and nothing else (it refuses every mainnet by name). It does a dry run unless `--send` is given and reads the key from a file you name. It prints the factory and curve addresses; putting them in `LAUNCH_EVM_CHAINS` and `EVM_CURVE_ADDRESSES` is a deliberate human step. The Sepolia dry run was checked against the real network (router answers, both constructors run). It has not been sent: that needs test coins.

## 10. Before mainnet

1. Independent audit of `AretiaCurve.sol`.
2. A Sepolia deployment, exercised with the real wallet flow.
3. The owner confirms the fee, minimum raise and the 7-day wait.
4. A watched small real-money rehearsal on Ethereum.
5. Then, and only then, put the address in the web code and turn the flag on.

## 11. Mainnet deployment (Ethereum, BNB Chain, Polygon)

`website/scripts/curve-mainnet.mjs` never holds a key and never sends anything. `prepare --chain <ethereum|bnb|polygon>` reads the chain, checks that the Aretia token factory, the exchange router, its factory and the wrapped coin are really there and agree with each other, runs the constructor read-only, and writes the unsigned contract-creation data (`deploy-out/curve-<chain>-creation.json`, ignored by git). The owner deploys that from their own wallet or hardware wallet: a creation transaction with no `to`, value 0, that data. `verify --chain <c> --address <new contract>` then checks the code at the address is byte-for-byte what the constructor produces for that chain (so it is the audited build with the right pinned addresses) and reads back factory, fee recipient, router, wrapped coin, fee (58 bps) and `totalOwed` (0).

Order, per chain: prepare, owner deploys, verify, put the address in `EVM_CURVE_ADDRESSES` and update the gate test (by hand), turn `PUBLIC_CURVE_ENABLED=1` on only for a watched small rehearsal, then open it up. Expected runtime keccak at preparation: Ethereum `0x9fdf8361…45c323`, BNB Chain `0x20774ed7…3d40cab`, Polygon `0x83218ff7…e456eeea`.

A wallet (for example one using a smart-account upgrade) may rewrite a transaction before it is sent, so the page's inspection covers the transaction it asked for, not necessarily the one the wallet submits. The page therefore reads the result back from the contract after every send and compares it.

## 12. Ethereum mainnet record

The Ethereum curve is deployed at `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` (creation transaction `0xe6056ceb76a6872f7a6e6152eadf7a56836333a04b6a01c202bd5e7f1a95e942`), from a fresh gas-only wallet that has no power over it. `scripts/curve-mainnet.mjs verify` confirmed the code is byte-for-byte the build for Ethereum (runtime keccak `0x9fdf8361…45c323`), the pinned factory, fee recipient, Uniswap V2 router and WETH, the 0.58% fee, and `totalOwed` of 0. The address is in `EVM_CURVE_ADDRESSES.ethereum`; the page card still needs a build with `PUBLIC_CURVE_ENABLED=1`, which stays off until a watched small rehearsal.

**Audit status, stated plainly:** the owner reports an AI-assisted review (ChatGPT) with no findings. That is not an independent human audit, no report was supplied to the author of this code, and the contract is immutable. (BNB Chain and Polygon were deployed afterwards: sections 13 and 14.) The October 2026 full review found M-2, M-3, M-4, L-10 to L-12 and I-1, I-4, I-6 in this contract: see sections 15 to 19.

## 13. BNB Chain mainnet record

The BNB Chain curve is deployed at `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` (same deployer and nonce as Ethereum, so the same address; creation transaction `0xb88bd23078242b3b5dfe6785b10b8de6e0b494247f2af3b8ad7352bf793a7786`). `verify` confirmed the code is byte-for-byte the BNB Chain build (runtime keccak `0x20774ed7…3d40cab`), the pinned factory `0xc3eb…0385c`, fee recipient, PancakeSwap V2 router and WBNB, fee 58 bps and `totalOwed` 0. Flag still off; same audit caveat as section 12. (Polygon followed: section 14.)

## 14. Polygon mainnet record

The Polygon curve is deployed at `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` (same deployer and nonce, so the same address; creation transaction `0xdb6dd6c93d104e9a730abfa574be818ecb2c01fe1022f78b55d800dffda4f5da`). `verify` confirmed the code is byte-for-byte the Polygon build (runtime keccak `0x83218ff7…e456eeea`), the pinned factory `0xca1a…f0c`, fee recipient, QuickSwap router and WPOL, fee 58 bps and `totalOwed` 0. Flag still off; same audit caveat as section 12. All three curves are now deployed and none has had a real trade yet.

## 15. Graduation blocked by a pre-made pair (M-4) and the rescue helper

**The problem (review M-4, L-12).** `graduate` deposits through the router's `addLiquidityETH` with minimums of 99.9% of each side, then requires the pool price within 1% of the curve's. Anyone can create the token/WETH pair first, send it **1 wei of WETH** and call `sync()`: the reserves are (0, 1), the router's `quote` reverts with `UniswapV2Library: INSUFFICIENT_LIQUIDITY`, and the curve can never graduate. No token is needed, so it works from the moment the token exists. An **unsynced** donation also blocks it (it is swept into the graduation deposit and moves the price past 1%). The deployed curve cannot be changed.

**The helper:** `contracts-evm/AretiaCurveRescue.sol` (artifact `AretiaCurveRescue.artifact.json`, compiler input `AretiaCurveRescue.standard-input.json`, built by `compile-helpers.mjs`). Permissionless, no owner, no state, holds nothing between calls. Constructor: the deployed curve (it reads the curve's `weth()` and its router's `factory()`). `rescue(token, maxTokens)` payable, in one transaction:

1. requires the curve `SoldOut` with `realTok == 0`; the deposit ratio is `realSol : lpTokens`;
2. finds the pair through the router's factory; if there is none, it just calls `graduate`;
3. `skim`s unsynced excess to the caller;
4. moves the reserves to the curve's ratio by the cheapest route the pair accepts: a **donation** of the missing side(s) then `sync()`, or, when the pair holds real value on the heavy side, a **swap** in which the caller pays the light side in and takes the excess of the heavy side out at the pair's own price (0.3% fee assumed, the most conservative of the three exchanges). The attacker pays for the skew; the rescuer is paid for repairing it. A side with a zero reserve gets 1 base unit first (a pair cannot swap while either reserve is zero). The larger-magnitude side is derived from the other by rounding up, with a floor of 10,000 units, so the ratio is exact to 1 part in 10,000, well inside the router's 0.1% and the curve's 1%;
5. checks the pair's reserves now equal the planned ones exactly, calls `curve.graduate(token)` (its own checks unchanged) and requires `Migrated`;
6. sends the caller everything left: unused coin, coin taken out (unwrapped), any tokens.

`quote(token)` returns the plan (`tokensIn`, `coinIn`, `tokensOut`, `coinOut`, reserves before and after), so the page knows what to approve and send.

**When the token side is needed, and how it is handled.** Whenever the pair's price is *above* the curve's (too much coin for its tokens: 1 wei of WETH alone, 1 wei of each side, 1 ETH against 1 token-wei), only tokens can bring it down, and the helper can only take them from the caller: the caller approves the helper for exactly `quote.tokensIn` and passes it as `maxTokens`. The amounts are tiny: about `rC × lpTokens / realSol` base units for dust (for a 5 ETH raise of an 18-decimal token, 4×10^7 base units, i.e. 4×10^-11 tokens, against 1 wei of WETH), and for real value it is a swap (1 ETH against 1 token-wei: the rescuer pays about 6×10^12 base units and receives about 1 ETH). Tokens are also needed when the token reserve is too small to express the ratio precisely. The curve has sold out, so the tokens are in buyers' hands; any holder can rescue. The curve's own tokens are never touched. When the pair's price is *below* the curve's, coin is paid in (`msg.value`) and, if the pair holds real value, the excess tokens come out to the caller.

**What it cannot do.** It cannot take tokens from anyone but `msg.sender`, nor coin other than `msg.value`. It does not change the curve; it only changes the pair, and the curve's own `graduate` decides. If the result is not a graduation, nothing happens.

**Tests** (`contracts-evm/test/rescue.test.mjs`, the deployed curve bytecode with the real Uniswap V2 builds): the three blocking cases (plain `graduate` reverts, the rescue graduates), the normal path, a token-heavy pair, unsynced donations, 14 random poisoned pairs across 18-, 6- and 0-decimal tokens, bounds, theft attempts, refused curve states, no leftover funds, gas (about 310,000 for the 1-wei case, against about 3 million for a fresh graduation).

**The web page** (`walletCurveEvmFlow.ts`): before graduating it reads the pair (`getPair` through the router's factory, `getReserves`, balances). A pair holding anything is explained in words; when `EVM_CURVE_RESCUE_ADDRESSES` names a helper for the chain, the review offers **"Graduate anyway"**: it checks the helper's code and that its `curve()` is this curve, reads `quote`, then (only if tokens are needed) an approval for exactly `tokensIn` to the helper, then `rescue(token, tokensIn)` with exactly `coinIn`. The inspector refuses any other destination, token, cap, a single changed digit, or more coin than the plan. `INSUFFICIENT_LIQUIDITY` is put in words, and the curve's own `exists` reason is matched only as its own reason.

**The Uniswap-V2 pool page has the same problem.** `walletPoolEvmFlow.ts` opens a pool with `addLiquidityETH` and minimums equal to the amounts, so a pair made first with dust refuses it. `contracts-evm/AretiaPairSeeder.sol` (constructor: the router) handles a pair with **no liquidity tokens**: it creates the pair if needed, skims unsynced excess, tops the reserves up to **exactly** the chosen amounts (the dust counts towards them), `mint`s to the dead address or the creator, checks the reserves equal the amounts, and refunds unused coin. A pair that already has liquidity tokens, or reserves above the amounts, is refused (someone owns it). The page uses it when `EVM_PAIR_SEEDER_ADDRESSES` names one; otherwise it explains and sends nothing. Tests: `contracts-evm/test/seeder.test.mjs`.

## 16. Deploying the rescue helper and the pair seeder (owner action, not done)

Neither is deployed. Both are permissionless and hold nothing, so deploying them gives nobody any power; they only make the page able to offer the repair.

0. `website/scripts/evm-helpers-mainnet.mjs` does the read-only checks, prints the gas estimate and writes the creation data (`prepare`), can deploy from the owner's own machine (`send --yes-mainnet`) and checks the result (`verify`); gas measured 2026-10-23: rescue 1.49 M, seeder 0.92 M. See `docs/MAINNET_GO_LIVE.md` step 5.
1. Rebuild and compare: `cd contracts-evm/test && npm i && npm run compile:helpers` must leave `AretiaCurveRescue.artifact.json`, `AretiaPairSeeder.artifact.json` and their standard-input files unchanged (`git diff --exit-code`). Expected runtime bytecode sha-256 **as compiled** (immutables are zero there; they are filled at deployment, so the deployed code differs per chain): `AretiaCurveRescue` `2035a510b035a908ed1ec558676b1b262465c3456498997e3c34d9172b568d1e`, `AretiaPairSeeder` `e65f98ae048c927a6e585cd406ad9c2d2f468fa12acd1655e0ed515c892a9b43`.
2. Run the tests: `npm test` there.
3. Per chain (Ethereum, BNB Chain, Polygon), from any gas-only wallet:
   - `AretiaCurveRescue` with constructor argument the curve `0x4e85bc5bd6f08fa87ceb749372e34226556837e8`;
   - `AretiaPairSeeder` with constructor argument the chain's router (`POOL_DEXES` in `walletPoolEvmCore.ts`: Uniswap V2 `0x7a250d5630b4cf539739df2c5dacb4c659f2488d`, PancakeSwap V2 `0x10ed43c718714eb63d5aa57b78b54704e256024e`, QuickSwap `0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff`).
4. Read back: the helper's `curve()`, `weth()` (the chain's wrapped coin) and `pairFactory()` (the exchange factory); the seeder's `router()`, `weth()`, `pairFactory()`. Verify the source on each explorer with the standard-input file (solc 0.8.26, optimizer 200, paris).
5. On a mainnet fork, or with a token of your own, rescue a deliberately poisoned pair once before relying on it.
6. Write the addresses, lower-case, into `EVM_CURVE_RESCUE_ADDRESSES` (`walletCurveEvmCore.ts`) and `EVM_PAIR_SEEDER_ADDRESSES` (`walletPoolEvmCore.ts`) and update the tests that pin them as null.

## 17. The fee key is a privileged freeze key under EIP-7702

The deployed curve pays the fee to `feeRecipient` (`0xeb8725e16e504036c2166aa47804d88ecc4d0945`, the same on all three chains) **inside every buy and sell**, and a failed payment reverts the trade (review M-2). EIP-7702 is live on Ethereum (Pectra), BNB Chain (Pascal) and Polygon PoS (Bhilai): one signed authorisation turns that account into code. Code that reverts on receipt then **freezes every buy and every sell on every curve on that chain**, including the sells after `abortMigration` that are holders' only exit; code that reverts selectively (for example by `tx.origin`) is a censorship and honeypot switch. This cannot be changed in the deployed contract. The statement "no privileged role" in `AretiaCurve.sol` is therefore wrong in practice: **the fee key is a privileged freeze key**, and must be run as one.

Operational rules:

1. **Cold storage.** The fee key lives on a hardware wallet (or a multi-party setup) used for nothing else, never in a browser wallet, a hot server, a CI secret or a phone wallet that offers "smart account" upgrades.
2. **Never sign an EIP-7702 authorisation with it, on any chain.** No "upgrade to smart account", no "batch transactions", no delegation prompts, no gas-sponsorship flows. An authorisation signed for chain id 0 is valid on every chain. Any wallet that cannot turn these prompts off is not used for this key.
3. **Withdraw only.** The key's only legitimate use is moving collected fees out. Keep transactions from it rare and deliberate; each one is reviewed by a second person.
4. **Monitoring.** `eth_getCode(0xeb8725e16e504036c2166aa47804d88ecc4d0945)` must stay `0x` on Ethereum, BNB Chain and Polygon. `website/scripts/fee-key-monitor.mjs` (written separately) checks it on all three chains and alerts on any change, including a 7702 delegation designator (`0xef0100…`); run it on a schedule (every few minutes) from infrastructure that does not hold the key, with alerts to more than one person.
5. **Response.** If code ever appears: announce at once that trading on the curves is frozen; if the key is still controlled, sign a 7702 authorisation **to the zero address** (which clears the delegation) from the cold key, after which payments succeed again; then rotate where future fees are sent for new contracts. A compromised key cannot be fixed for the deployed curves; say so publicly.
6. **The token factory** sends its creation fee to the same address inside `create`, so a freeze also stops new tokens; the rules above cover it.

The new `AretiaPool.sol` build (Sepolia only) no longer has this problem: fees accrue in `protocolOwed` and anyone can pay them out with `withdrawProtocolFees()` (`docs/ARETIA_POOL_EVM.md`).

## 18. Supply held outside a curve (M-3)

The curve accepts any `total` from 1 to 2^96 regardless of the token's supply, and lets anyone sell tokens back until `realTok == curveTokens`. A holder of supply outside the curve (the creator, or anyone given tokens) can therefore sell ahead of buyers, take their coin, and leave real buyers unable to sell (`"more than sold"`). The deployed contract cannot enforce `total == totalSupply()`.

The page now shows, on every curve card: the total supply, the amount and share on the curve, the amount and share outside it, and the opener's **live** token balance, with a strong warning whenever anything is outside: "X% of supply is outside this curve; holders of it can sell ahead of you". If the supply cannot be read, it says that instead. The create preview and review show the same numbers to the creator and say buyers will see the warning, so the creator can put the whole supply on the curve. Code: `evmSupplyOutside` and `evmOutsideWarning` in `walletCurveEvmCore.ts`; tests in `walletCurveEvmRescue.test.ts`.

## 19. Known limitations of the deployed version

These are in the deployed, immutable `AretiaCurve.sol` and stay for its life. Each has a recommended change for any future version (a new contract; old curves keep working on this one).

| Finding | Limitation in the deployed curve | Mitigation now | Recommended for a future version |
|---|---|---|---|
| M-2 | The fee is pushed inside every trade, so the fee key can freeze trading (section 17). | Cold key, never sign 7702, monitoring. | Pull payments: accrue `protocolOwed` inside `totalOwed`, and a permissionless `withdrawProtocolFees()`; or credit a failed or gas-limited fee send instead of reverting. |
| M-3 | Supply outside the curve can be sold into it ahead of buyers. | Shown and warned on every card (section 18). | Require `total == totalSupply()`, held entirely by the caller; cap the factory's supply at `MAX_TOTAL`. |
| M-4 | A pre-made pair with 1 wei blocks graduation. | Rescue helper (sections 15, 16). | Graduate through `pair.mint` directly (skim, top up, mint), or let `abortMigration` run at once when the pair has reserves before graduation. |
| **L-10** | **Liveness.** Graduation costs about 3 million gas with no reward to the caller. After 7 days anyone may `abortMigration`, even for a curve that could still graduate; an aborted curve can never graduate again, and its `lpTokens` stay in the contract for good. | The page shows the gas cost before signing; the rescue makes a blocked graduation cheap; anyone (the creator, Aretia) can call `graduate` as soon as the curve sells out. | A small caller bounty from the raise; allow abort only when graduation is impossible (the pair has reserves at another price); allow graduating again after an abort once the pair is fixed. |
| **L-11** | **Precision at tiny `total` or zero decimals.** With `total = 5` the pool opens 33% above the curve's last price and the raise falls 29% short; integer rounding of the split dominates. | The page's create form takes whole tokens of real tokens; very small totals are unusual. Treat curves with `total` below 10^6 base units as broken. | Require `total >= 1e6` base units (and reject tokens with fewer decimals where that cannot be met). |
| **I-4** | `MAX_TOTAL` is 2^96 but the token factory allows a larger supply, so a large-supply token cannot put its whole supply on a curve, which forces M-3. | The outside-supply warning covers it. | Cap the factory's supply at `MAX_TOTAL`, or raise `MAX_TOTAL` (the maths fits 2^112). |
| **I-6** | **Gas.** `feeBps`, `createdAt`, `target` and `vSol0` are stored per curve but never read on chain; the checks at `AretiaCurve.sol:244, 246, 285` can never fail. | None needed (cost only). | Make `feeBps` a constant read, emit `createdAt`/`target`/`vSol0` in `Created` instead of storing them, drop the unreachable checks. |
| I-3 | No `SoldOut` event; `Traded` lacks `realTok` and its `coin` is gross in both directions; `Migrated` omits what was left unused. | Indexers read `curves(token)` after each event. | Add `SoldOut`, `realTok`, and net amounts; emit leftovers. |
| I-5 | Up to 0.1% graduation leftovers, an aborted curve's `lpTokens`, k-rounding dust, direct token transfers and forced coin stay in the contract for good. | None possible. | A permissionless sweep of amounts provably not owed (balance above `totalOwed`, tokens above what curves hold) to the fee address. |
