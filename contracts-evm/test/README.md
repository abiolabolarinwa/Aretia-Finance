# contracts-evm tests (in-process EVM)

These run the **committed artifacts** in `contracts-evm/` (never a fresh build) inside `@ethereumjs/vm`, with the real Uniswap V2 factory,
router and WETH9 builds from npm. They are separate from the website's tests because the EVM library is not a website dependency.

```
cd contracts-evm/test
npm install            # node_modules here is git-ignored
npm test               # node --test rescue.test.mjs seeder.test.mjs pool.test.mjs
npm run compile:helpers   # rebuild AretiaCurveRescue / AretiaPairSeeder artifacts + standard-input (solc 0.8.26, optimizer 200, paris)
npm run compile:pool      # rebuild AretiaPool artifact + standard-input
```

| File | What it proves |
|---|---|
| `rescue.test.mjs` | `AretiaCurveRescue` against the **deployed** `AretiaCurve` bytecode (review M-4, L-12). The three blocking cases make a plain `graduate` revert and the rescue graduate: 1 wei of WETH + `sync` (attacker holds no tokens), 1 wei of each side, 1 ETH against 1 token-wei (synced, minted LP, and 1 ETH alone, where the rescuer swaps the excess out and is paid about 1 ETH for dust tokens). Also: no pair (normal path, all value refunded), a token-heavy pair (coin in, tokens out), unsynced donations (skimmed to the caller), 14 random poisoned pairs across 18/6/0-decimal tokens (always `Migrated`, pool price within 0.1% of `realSol : lpTokens`, quote equals the effect on the caller to the wei), bounds (`maxTokens`, `msg.value`), it cannot pull tokens from anyone but the caller, it refuses open / aborted / migrated curves, no owner or withdraw in the ABI, gas. Every case checks the helper holds no coin, WETH or tokens afterwards and the curve owes nothing. |
| `seeder.test.mjs` | `AretiaPairSeeder` (the Uniswap-V2 pool page, M-4): a fresh pair, and pairs blocked for the router by 1 wei of WETH, 1 wei of each side or 1 token-wei, all open at **exactly** the intended reserves; unsynced donations are skimmed; a pair with liquidity tokens and reserves above the amounts are refused; tokens are pulled only from the caller; nothing left in the helper. |
| `launch.test.mjs` | `AretiaLaunchFactory` against the real Uniswap V2 code: token and locked pool in one transaction (liquidity tokens at the dead address, none with the creator, the creator keeps exactly the rest, fee paid, nothing left behind), the refusals (share below 70%, too little coin, bad inputs), a pair made before the token exists (it cannot be synced or minted; anything sent to it is skimmed to the creator), different tokens and pairs per launch. |
| `pool.test.mjs` | `AretiaPool` (new build): the review's `poc/evm-pool/poc.mjs` scenarios now fail (PoC 1 dust-position griefing and never-closing empty positions, PoC 2 fee-address freeze, PoC 3 unlocked creator withdrawing buyers' coin, PoC 5 LP-fee dust) plus deadlines (L-20), `quoteBuy` vs the size limit (I-7), events (I-3), the pull-payment accounting (M-2) and solvency. |

`harness.mjs` gives each test its own fresh chain. Revert reasons are decoded from `Error(string)`.
