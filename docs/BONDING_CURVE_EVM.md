# Aretia bonding curve, Ethereum-style chains

Status: **contract written and tested locally and against a local copy of Ethereum mainnet. UNAUDITED. NOT deployed anywhere, testnet or mainnet. Must not hold real money until an independent audit is done and the owner says go.**

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
| 4 | **A pool made first at another price** | The exchange's own minimums plus the price check refuse. Tested against the real Uniswap V2 code (a pool 100× cheaper makes `graduate` revert with the exchange's own message). After 7 days `abortMigration` reopens selling so holders leave along the curve. | The cost is a week of locked money and no graduation. |
| 5 | **A pool made first and then skewed after the check** | The price is read back from the pair after the deposit, in the same transaction, and the transaction reverts if it is off by more than 1%. | Someone can still move the price after graduation, as in any pool. |
| 6 | Front-running, sandwiching | Every buy and sell carries a minimum. | Inherent to any curve. On Ethereum the public mempool makes it easier; a private-relay option in the web flow is worth considering. |
| 7 | Forced coin (self-destruct) or a donation | Accounting uses stored numbers; the solvency check is `balance ≥ owed`, so extra coin only helps. | The donor's coin is stuck. |
| 8 | Upgrade or admin keys | There are none. | A bug cannot be fixed in place: deploy a new contract. |
| 9 | Fee recipient that rejects coin | A rejecting recipient would make every trade revert. The recipient is fixed at deployment, so it must be an address that accepts coin (a plain account does). | Check it before deploying. |
| 10 | Creator dumps | Fixed supply, no mint, no pause. | A creator holding tokens outside the curve can sell them into it, up to what was sold. |
| 11 | Squatting | One curve per token; anyone holding the token can open its curve first. | Same as Solana: the page shows who opened a curve. A stricter rule (only the factory's `TokenCreated` creator) is not possible without an on-chain record the factory does not keep. |
| 12 | Gas | Measured in the test EVM (execution gas, before the 21,000 base cost): the first buy on a curve about 123,000, later buys about 42,000, a sell about 56,000. **Graduating into the real exchange with a new pool cost about 2.8 million gas on Ethereum and Polygon and 3.5 million on BNB Chain**, mostly the exchange creating the pair. | Real gas money to whoever calls `graduate` (anyone). At 20 gwei that is about 0.055 ETH, so the web flow must say who pays and how much before it is signed. |

## 6. Tests

| What | Result |
|---|---|
| In-process EVM with the real compiled contract and the real token factory code, and a stand-in exchange | 17 tests, 4 of them driving the page's own flow code against the contract (open a curve with a first buy, buy, sell, sell out, graduate, unwind, and a tampered transaction refused). The 13 contract tests: the maths against the model, the factory-only rule at every nonce size, fees to the wei, every refusal, an oversized buy, a 60-step random run, reentrancy (with a mutation check), graduation, a pool at another price and the 7-day unwind, immutability (no owner, setter, upgrade or withdraw in the ABI). |
| A local copy of each of Ethereum, BNB Chain and Polygon mainnet (read-only RPC), Aretia's **real deployed factory** on each, and the **real Uniswap V2 / PancakeSwap V2 / QuickSwap** router, factory and pair code | A curve opened with a token made by the real factory, bought out, and graduated: pair created, tokens and coin in at the right ratio, liquidity tokens held by the dead address, nothing owed. A pool created first at another price makes graduation revert with the exchange's own message. All three chains pass. |

Run them: `npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util @ethereumjs/block @ethereumjs/statemanager` in `website`, then `npx vitest run src/scripts/walletCurveEvmContract.test.ts` and `npm run test:curve-fork`. They are skipped or separate in CI, as the factory's test is, because the EVM library is not a website dependency.

## 7. Not done

- **No audit, no deployment, not even on a testnet.** The first real-network step is a testnet deployment (Sepolia), which needs test ETH and the owner's go-ahead for the deployer key.
- The fork test does not check what happens after a revert (the lazy state manager does not roll back storage); that is covered by the in-process tests.
- The solc build is not yet reproduced by a second person. The compiler input is committed so anyone can.
- The web flow exists (section 8) but has only been run against the contract in a local EVM, never in a browser with a real wallet. BNB Chain (PancakeSwap V2) and Polygon (QuickSwap) pass the same mainnet-copy test; they still need their own testnet deployments and the owner's go-ahead.
- Fee-on-transfer or rebasing tokens are not supported and cannot occur: only factory tokens are accepted.

## 8. The web flow

`website/src/scripts/walletCurveEvm{Core,Tx,Flow}.ts` and the card `walletCurveEvm.ts`, drawn under the pool card on the Launch page's Ethereum-style networks, in the same style as the Solana curve and the EVM pool.

- **Core:** the maths in BigInt (no 64-bit limit), forms, the proof that a token came from the factory (the page searches the factory's CREATE nonces, newest first, with the same RLP rule the contract uses), reading a curve from the contract's answer, a live preview, presets (1, 5, 20 of the coin), and plain-language notes.
- **Transactions and the inspector:** approve (exactly the tokens, to the curve, never unlimited), create (which carries the creator's first buy), buy, sell, graduate, unwind. The inspector decodes each from its bytes and refuses a changed digit anywhere in the data, another contract, another sender, another amount of coin, an extra field, a gas limit that is not a number, or the wrong network.
- **Flow:** prepares, inspects, simulates, switches the wallet to the right network, sends, waits for the receipt, then reads the curve back and compares. If the second transaction of a pair cannot go ahead it says the approval stays for exactly the tokens and nothing else happened.
- **Off twice:** the card exists only on a build with `PUBLIC_CURVE_ENABLED=1`, and `EVM_CURVE_ADDRESSES` is `null` for every network, which makes the card show "not live" and nothing else. A test pins both, and pins every shared constant and every function selector to the contract's source and compiled ABI.

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

**Audit status, stated plainly:** the owner reports an AI-assisted review (ChatGPT) with no findings. That is not an independent human audit, no report was supplied to the author of this code, and the contract is immutable. BNB Chain and Polygon are not deployed.

## 13. BNB Chain mainnet record

The BNB Chain curve is deployed at `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` (same deployer and nonce as Ethereum, so the same address; creation transaction `0xb88bd23078242b3b5dfe6785b10b8de6e0b494247f2af3b8ad7352bf793a7786`). `verify` confirmed the code is byte-for-byte the BNB Chain build (runtime keccak `0x20774ed7…3d40cab`), the pinned factory `0xc3eb…0385c`, fee recipient, PancakeSwap V2 router and WBNB, fee 58 bps and `totalOwed` 0. Flag still off; same audit caveat as section 12. Polygon is not deployed.
