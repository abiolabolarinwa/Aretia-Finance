# Aretia launch factory: deploy and verify

`AretiaLaunchFactory.sol` creates a fixed-supply token and opens its trading pool with the liquidity locked, in ONE transaction (see the contract header). It replaces token-only creation on the Launch page.

## Deploy (the owner's wallet signs; nothing here holds a key)

Open `deploy-launch.html` (serve it locally, for example `python -m http.server` in this folder, and open it in the browser that has the wallet; wallets do not inject into `file://` pages). Pick the network, check the five values it shows, press Deploy and approve. It prints the factory address. Send it back so it is written into `LAUNCH_EVM_CHAINS` (`website/src/scripts/walletLaunchEvmCore.ts`, field `launch.factory`, lower-case). Every value below is fixed for ever in the deployed factory: to change one, deploy a new factory.

| Network | Fee | Fee address | Exchange | Minimum coin in the pool |
|---|---|---|---|---|
| BNB Chain | 0.028 BNB | `0xeb8725e16e504036c2166aa47804d88ecc4d0945` | PancakeSwap V2 | 0.07 BNB |
| Ethereum | 0.0084 ETH | same | Uniswap V2 | 0.02 ETH |
| Polygon | 210 POL | same | QuickSwap | 500 POL |

These amounts are PROPOSED (about USD 20 in each coin, and about USD 50 for the minimum pool), not confirmed: the factory's fee and minimum cannot be changed after deployment. The minimum share of the supply that must go into the pool is 70% on every network (a constant in the contract).

Gas: a launch also creates the pool's pair contract, so it costs about 3.2 million gas (measured in an in-process EVM against the real Uniswap V2 code). On Ethereum that is a lot of ETH at busy times.

## Verify on the explorer

Settings: compiler `solc 0.8.26`, optimizer on, 200 runs, EVM version `paris`, license MIT, contract `AretiaLaunchFactory`. Choose "Solidity (Standard JSON Input)" and upload `AretiaLaunchFactory.standard-input.json` (it contains both source files: `AretiaLaunchFactory.sol` and `AretiaTokenFactory.sol`, which the factory imports the token from). Constructor arguments, ABI-encoded, no `0x` (fee address, fee in wei, exchange factory, wrapped coin, minimum coin in wei):

| Network | Explorer | Constructor arguments |
|---|---|---|
| BNB Chain (PancakeSwap V2) | https://bscscan.com/address/ADDRESS#code | `000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d0945000000000000000000000000000000000000000000000000006379da05b60000000000000000000000000000ca143ce32fe78f1f7019d7d551a6402fc5350c73000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00000000000000000000000000000000000000000000000000f8b0a10e470000` |
| Ethereum (Uniswap V2) | https://etherscan.io/address/ADDRESS#code | `000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d0945000000000000000000000000000000000000000000000000001dd7c1681d00000000000000000000000000005c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000470de4df820000` |
| Polygon (QuickSwap) | https://polygonscan.com/address/ADDRESS#code | `000000000000000000000000eb8725e16e504036c2166aa47804d88ecc4d094500000000000000000000000000000000000000000000000b6255df5f500800000000000000000000000000005757371414417b8c6caad45baef941abc7d3ab320000000000000000000000000d500b1d8e8ef31e21c99d1db9a6444d3adf127000000000000000000000000000000000000000000000001b1ae4d6e2ef500000` |

## Tests

`contracts-evm/test/launch.test.mjs` runs the committed artifact in an in-process EVM against the real Uniswap V2 factory, router and WETH9 builds: the token and pool in one transaction, the liquidity tokens at the dead address and none with the creator, the creator keeping exactly the rest of the supply, the fee paid, nothing left in the factory, the refusals (pool share below 70%, too little coin, bad names, zero supply), a pair made before the token exists (it cannot be synced or minted, and anything sent to it is skimmed to the creator), and a different token and pair for each launch.
