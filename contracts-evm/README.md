# Aretia Launch, EVM token factory

`AretiaTokenFactory.sol` makes fixed-supply ERC-20 tokens for the Launch page on BNB Chain, Ethereum and Polygon (Base was dropped: the owner cannot use it from their region).

- **Token** (`AretiaToken`): standard ERC-20. No owner, no mint after construction, no pause, no blacklist, no transfer fee, no upgrade. The whole supply is minted once to the creator.
- **Factory** (`AretiaTokenFactory`): immutable, no owner or setters. `fee` and `feeRecipient` are fixed at deployment. `create(name, symbol, decimals, supply)` requires `msg.value == fee`, forwards it to `feeRecipient` in the same transaction, and holds nothing.
- Why a factory and not per-token bytecode: the page then signs a transaction to ONE known address with a small, decodable calldata, which its independent inspector can verify byte for byte. Deploying fresh bytecode per token would make the transaction impossible to check against anything.

## Artifact

`AretiaTokenFactory.artifact.json` is the output of `solc 0.8.26`, optimizer 200 runs, EVM `paris` (so it runs on every chain above). Rebuild it with solc-js and compare bytecode before deploying; verify the source on each explorer after.

## Deploying (owner action, not done)

Constructor arguments: `(feeRecipient, feeWei)`. They must equal `feeAddress` and `feeWei` in `LAUNCH_EVM_CHAINS` (`website/src/scripts/walletLaunchEvmCore.ts`). Deploy to the test network first, create a token from the page, then deploy to the mainnet and write the **lower-case** factory and fee addresses into that table. A chain stays disabled on the page until both are set, and the page refuses a factory whose on-chain `fee()` or `feeRecipient()` differs from the table.

Fees (set by the owner): Ethereum 0.0042 ETH, BNB Chain 0.014 BNB, Polygon 105 POL. Fee address on all chains: `0xeb8725e16e504036c2166aa47804d88ecc4d0945`.

## Tests

`website/src/scripts/walletLaunchEvmContract.test.ts` runs this exact artifact in an in-process EVM (`npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util` first; skipped without it).

## Bonding curve (deployed, immutable)

`AretiaCurve.sol` is the EVM version of Aretia's bonding curve. See `docs/BONDING_CURVE_EVM.md`. Rebuild its artifact with `compile-curve.mjs` (needs `solc@0.8.26`); test stand-ins and their build script are in `test-mocks/`.

It **is deployed**, at the same address on all three chains: `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` on Ethereum, BNB Chain and Polygon (`EVM_CURVE_ADDRESSES` in `website/src/scripts/walletCurveEvmCore.ts`). It has no owner and cannot be upgraded. It was covered by the October 2026 review (`docs/audit/2026-10-full-review/REPORT.md`); read findings M-2, M-3, M-4, L-10 and L-11 before relying on it. Check a deployment with `website/scripts/curve-mainnet.mjs verify --chain <chain> --address <address>`, and verify its source as in `VERIFY.md`.

The deployed source is byte-for-byte what was verified on the explorers, so its comments are left as they were, including these that are now out of date or imprecise (audit I-1, I-2):

- The header (`AretiaCurve.sol:5`) says "UNAUDITED. NOT deployed anywhere". It is deployed, at the address above.
- The graduation price check (`:264-266`, `:347`) compares the pool's opening price with the deposit ratio (`coinIn / tokensIn`), not with "the curve's last price".
- `quoteBuy` (`:303`) reverts for an impossible request; it does not "return zeros".
- "No privileged role" (`:12-13`): the fee recipient is paid inside every trade, and a failed payment reverts it, so the fee key can freeze trading if it ever gets code (EIP-7702). Treat it as a privileged freeze key: see `docs/operations/fee-key-monitor.md` (audit M-2).

## Aretia Pool (UNAUDITED, not deployed on any mainnet)

`AretiaPool.sol` is Aretia's own constant-product swap pool for these chains: single-sided creation, 0.25% or 1% fee, 20% of every fee paid to Aretia inside the trade, the rest claimable by liquidity positions even while locked for good. See `docs/ARETIA_POOL_EVM.md`. Rebuild with `compile-pool.mjs`; hostile test stand-ins are `test-mocks/PoolMocks.sol` (built by `test-mocks/compile-pool-mocks.mjs`); deploy and verify with `website/scripts/pool-evm.mjs`.
