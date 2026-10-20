# Verifying the contracts on each explorer

## The token factory

Verification publishes the source so anyone can read what the factory does. You do it on each explorer's website with your own login; nothing here needs a key or a fee. The standard-JSON file is the exact compiler input used to build the deployed bytecode.

**Settings (same on all three):** Compiler `solc 0.8.26`, optimizer on, 200 runs, EVM version `paris`, license MIT. Contract name `AretiaTokenFactory`. Choose "Solidity (Standard JSON Input)" and upload `AretiaTokenFactory.standard-input.json`.

| Network | Explorer | Factory address | Constructor arguments (ABI-encoded, no 0x) |
|---|---|---|---|
| BNB Chain (0.014 BNB) | https://bscscan.com/address/0xc3eb98c45795cffb10b61178332cc6fcbbc0385c#code | `0xc3eb98c45795cffb10b61178332cc6fcbbc0385c` | `000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d09450000000000000000000000000000000000000000000000000031bced02db0000` |
| Ethereum (0.0042 ETH) | https://etherscan.io/address/0x951a22270faa7d1c25efad2356c414cbddaba324#code | `0x951a22270faa7d1c25efad2356c414cbddaba324` | `000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d0945000000000000000000000000000000000000000000000000000eebe0b40e8000` |
| Polygon (105 POL) | https://polygonscan.com/address/0xca1aa427ba5906d00377a835dd9b36b049034f0c#code | `0xca1aa427ba5906d00377a835dd9b36b049034f0c` | `000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d0945000000000000000000000000000000000000000000000005b12aefafa8040000` |

The constructor arguments are the fee address `0xeb8725e16e504036c2166aa47804d88ecc4d0945` followed by the fee in wei.

Steps on each explorer: open the factory address, then Contract, then "Verify and Publish", pick Standard JSON Input, upload the file, paste the constructor arguments above, submit. It should report a match. If it does not, the compiler settings above are the first thing to recheck.

Tokens made by the factory (`AretiaToken`) are separate contracts. Explorers show them as unverified unless someone verifies them; each one has its own constructor arguments (name, symbol, decimals, supply, creator), so a creator who wants theirs verified uses the same standard-JSON file and the `AretiaToken` contract with their own values.

## The bonding curve (`AretiaCurve`)

The curve is deployed at `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` on all three chains. Its source is verified the same way, with its own standard-JSON file.

**Settings (same on all three):** Compiler `solc 0.8.26`, optimizer on, 200 runs, EVM version `paris`, license MIT. Contract name `AretiaCurve`. Choose "Solidity (Standard JSON Input)" and upload `AretiaCurve.standard-input.json`.

The constructor is `(factory, feeRecipient, router)`: the chain's Aretia token factory, the fee address, and the chain's Uniswap V2-style router.

| Network | Explorer | Constructor arguments (ABI-encoded, no 0x) |
|---|---|---|
| BNB Chain | https://bscscan.com/address/0x4e85bc5bd6f08fa87ceb749372e34226556837e8#code | `000000000000000000000000c3eb98c45795cffb10b61178332cc6fcbbc0385c000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d094500000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e` |
| Ethereum | https://etherscan.io/address/0x4e85bc5bd6f08fa87ceb749372e34226556837e8#code | `000000000000000000000000951a22270faa7d1c25efad2356c414cbddaba324000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d09450000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d` |
| Polygon | https://polygonscan.com/address/0x4e85bc5bd6f08fa87ceb749372e34226556837e8#code | `000000000000000000000000ca1aa427ba5906d00377a835dd9b36b049034f0c000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d0945000000000000000000000000a5e0829caced8ffdd4de3c43696c57f7d7a678ff` |

Routers: PancakeSwap V2 `0x10ed43c718714eb63d5aa57b78b54704e256024e` (BNB Chain), Uniswap V2 `0x7a250d5630b4cf539739df2c5dacb4c659f2488d` (Ethereum), QuickSwap `0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff` (Polygon).

Before (or instead of) the explorer, check the deployed code itself, read-only:

```
cd website && npm i --no-save viem
node scripts/curve-mainnet.mjs verify --chain ethereum --address 0x4e85bc5bd6f08fa87ceb749372e34226556837e8
```

It rebuilds the expected runtime code from the artifact and these constructor arguments, compares it byte for byte with the chain, reads back `factory()`, `feeRecipient()`, `router()`, `weth()` and `FEE_BPS()`, reads the token factory's `feeRecipient()` and `fee()`, and stops if the fee address has any code (an EIP-7702 delegation would let it freeze trading; see `docs/operations/fee-key-monitor.md`). Repeat with `--chain bnb` and `--chain polygon`.

The source's comments are kept exactly as verified; `README.md` lists the ones that are out of date.
