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
