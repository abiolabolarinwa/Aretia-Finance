# Mainnet go-live checklist

Written 2026-10-23. This is the one ordered list for taking everything live on mainnet. **Nothing in it has been run on mainnet by the people who wrote it.** The scripts only read the chain; every step that spends money or signs is yours, from your own machine and wallet. Keep the deploy keys out of the repo and out of any chat.

## 0. What is true, plainly

| Piece | State | Unaudited? |
|---|---|---|
| EVM Aretia Curve (Ethereum, BNB Chain, Polygon) | **Live** at `0x4e85bc5bd6f08fa87ceb749372e34226556837e8` on all three; immutable; `PUBLIC_CURVE_ENABLED=1` in production | **Yes.** A ChainSecurity review is in progress; there is no report yet. The cards keep their notice. |
| EVM `AretiaCurveRescue`, `AretiaPairSeeder` | Built, tested locally, **not deployed** | Yes |
| EVM `AretiaPool` | Built, flag off, mainnet addresses null, public testnets not deployed | Yes |
| Solana Aretia Curve | Built, tested on devnet, **not on mainnet**. Planned id `CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu` | Yes |
| Solana Aretia Pool and `aretia-curve-grad` | Devnet only. The committed builds are made for the **devnet** ids, so mainnet needs a rebuild with new ids (step 7) | Yes |
| Jupiter / DexScreener listing | Not submitted; waits for a mainnet pool, an audit and the other items in step 8 | n/a |

Everything above that holds people's money is **not independently audited**. A programme that can be upgraded (all the Solana ones) is controlled by the Squads vault `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` once you run the hand-over command; the EVM contracts cannot be changed at all.

## 1. Costs and funding

### Solana (one deployer wallet, SOL)

Rent is whatever the network charges when you deploy; the scripts ask the node. On 2026-10-23 it was **5,080 lamports per byte** of (128 + account length), checked with the official CLI (`solana rent 395069`) against three nodes. An account's rent stays locked in it; it is not a fee.

Rent of a deploy = program data account (45-byte header + `--max-len`) + the 36-byte program account (164 × 5,080 = 833,120 lamports). The commands pass `--max-len` equal to the build size, so there is no spare room for a bigger upgrade (a bigger one needs `solana program extend` first, which costs more rent). `solana program deploy` also uploads the build to a temporary buffer of the same size; the loader hands the buffer's lamports back to the payer inside the deploy instruction, before the data account is paid for, so the wallet does not need the rent twice. If a deploy stops for lack of funds, the buffer is kept: top up and resume with `--buffer`.

| Program | Build size (bytes) | Data account (bytes) | Rent: data + program account | Fund the deployer with |
|---|---|---|---|---|
| Aretia Curve (`aretia_curve.so`) | 395,024 | 395,069 | (395,197 × 5,080) 2,007,600,760 + 833,120 = 2,008,433,880 lamports = **2.0084 SOL** | **2.06 SOL** |
| Aretia Pool (`aretia_pool.so`, mainnet rebuild, same size to within a few bytes) | 407,488 | 407,533 | 2,070,917,880 + 833,120 = **2.0718 SOL** | **2.12 SOL** |
| `aretia-curve-grad` (mainnet rebuild) | 356,168 | 356,213 | 1,810,212,280 + 833,120 = **1.8110 SOL** | **1.86 SOL** |

All three: **5.89 SOL** of rent plus about 0.01 SOL of fees, so fund the deployer with about **6.1 SOL** if you do them in one sitting. (If you also deploy `act-staking`, 368,896 bytes: 1.8757 SOL.)

**Why earlier numbers differ.** The October review said about 2.75 SOL. That is (128 + 395,069) × 6,960 + 1,141,440 = 2.7517 SOL: correct arithmetic at the **old** rate of 6,960 lamports per byte, which the network no longer charges. The 1.6133 SOL measured on devnet was a smaller, older build (about 231 KB) at that same old rate. The one number to use now is **2.0084 SOL for the curve**, and `prepare` re-asks the node, so if the rate changes before you deploy, trust what `prepare` prints.

Also keep **0.0007 SOL** in the fee wallet `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2` (it holds 0.0074 SOL today; the scripts stop if it holds less than the rent minimum).

### EVM (one deployer wallet per chain)

Gas measured on 2026-10-23 with `eth_estimateGas` against each live chain (the helper scripts print it for you):

| Contract | Ethereum / BNB Chain | Polygon |
|---|---|---|
| `AretiaCurveRescue(curve)` | 1,489,144 gas | 1,489,990 |
| `AretiaPairSeeder(router)` | 921,881 | 922,728 |
| `AretiaPool(factory, fee address, creation fee)` | 2,718,183 | 2,719,042 |
| Total per chain | about 5.13 million | about 5.13 million |

Gas prices move, so these are cost at a price, not a quote. At the prices seen that day the whole set cost about 0.0002 ETH (0.04 gwei), 0.0003 BNB (0.05 gwei) and 1.2 POL (222–258 gwei). Fund with room for a much worse day:

| Chain | Total gas | Price you could meet | Fund the deployer with |
|---|---|---|---|
| Ethereum | 5.13 M | up to about 6 gwei | **0.03 ETH** (about 0.001 ETH at 0.2 gwei; 0.15 ETH at 30 gwei) |
| BNB Chain | 5.13 M | up to about 4 gwei | **0.02 BNB** |
| Polygon | 5.13 M | up to about 1,000 gwei | **5 POL** |

The leftover stays in the deployer. The contracts have no owner, so the deployer wallet gets no power over them; use a wallet funded for gas only.

## 2. Order

Do the steps in this order. Each says what finishing it proves.

### Step 1: database (Supabase)

Source: `docs/audit/2026-10-full-review/REMEDIATION.md` section 6. In the Supabase SQL Editor, or with `SUPABASE_DB_URL=... npm run db:migrate` from `website/` (which applies every pending migration in file order, which is fine here because the new code is not deployed yet):

1. Back up: `create table referral_credits_pre0013 as select * from referral_credits;`
2. If `0011_referrals.sql` and `0012_launchbox.sql` have never been applied, run them first. All migrations are safe to run twice.
3. Run **`0014_auth_nonces_and_pruning.sql` first** of the new ones: it must be in before the new code, or sign-in and every signed-in feature fail.
4. Run `0013_referral_tx_case.sql`, then `0015_launchbox_listing.sql`.

*Proves:* the tables exist. It does not prove the app works with them; step 3 does.

### Step 2: Vercel environment variables (Production, mark Sensitive)

1. `SWINGS_SESSION_SECRET`: a long random value (`openssl rand -hex 32`, or a 64-character password-manager string). Everyone is signed out once.
2. `SWINGS_LOGIN_DOMAINS` = `aretiafinance.org,www.aretiafinance.org`.
3. `SWINGS_AGGREGATORS` = `off` for the moment (Jupiter and 0x swaps stay off until step 3 passes).
4. Flags (build-time, exactly the text `1` turns one on; anything else is off):
   - `PUBLIC_CURVE_ENABLED`: already `1`. Setting a Solana curve id (step 4) makes the Solana curve card live at the next deploy.
   - `PUBLIC_ARETIA_POOL_ENABLED` (Solana pool) and `PUBLIC_ARETIA_POOL_EVM_ENABLED` (EVM pool): leave **off** until the pool is deployed, verified and you have watched a rehearsal.

### Step 3: merge and check the site

Merge to `main`, let Vercel deploy. Check: sign in with an EVM wallet and a Solana wallet; a MoonPay buy asks you to sign in; Launch Box loads. Then delete `SWINGS_AGGREGATORS`, redeploy, try one small Solana swap (Jupiter) and one small ETH to token and back (0x).
*Proves:* the sign-in and database changes work in production. Not covered here: Vercel Hobby allows 12 serverless functions and `website/api` is at that limit; do not add files there.

### Step 4: Solana Aretia Curve

Files: `program/aretia-curve/artifacts/aretia_curve.so`, `website/scripts/curve-solana-mainnet.mjs`.

**Re-checked 2026-10-23:** the committed build is 395,024 bytes with sha-256 `0275bb1f7a1844b8d1a993d501538947866cd0ee928283f3b412e111006ed5a5`, equal to its `.sha256` file and to the hash in `docs/BONDING_CURVE.md` 11b; the program id `CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu` appears exactly once inside it and equals `declare_id!` in the source and `CURVE_PROGRAM_ID_MAINNET_PLANNED`; there is no `.STALE` marker.

**4a. Re-run the curve tests with Meteora's current mainnet binary.** The review requires this before deploy, because six migration and fee tests skip without the binary. From the repo root in PowerShell:

```powershell
solana program dump cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG meteora_cp_amm.so --url mainnet-beta
$env:METEORA_CP_AMM_SO = (Resolve-Path meteora_cp_amm.so).Path
$env:ARETIA_CURVE_SO = (Resolve-Path program\aretia-curve\artifacts\aretia_curve.so).Path
cargo test --manifest-path program\aretia-curve\tests\Cargo.toml
```

All tests must pass with none skipped (19 in total, including the migration and fee-claim ones, and the I-11 check inside `migrate`). If anything fails or skips, stop. *Proves:* the committed build migrates a sold-out curve into Meteora's current mainnet program, in a local VM. It does not prove a real mainnet transaction.

**4b. Check and fund.** `cd website; node scripts/curve-solana-mainnet.mjs prepare` (read-only) prints the live rent and the commands below. Fund the deployer with **2.06 SOL**.

**4c. Deploy and hand over** (PowerShell; `<folder>` holds the program key, kept outside the repo):

```powershell
solana-keygen new --no-bip39-passphrase --outfile <folder>\aretia-curve-program.json
solana address --keypair <folder>\aretia-curve-program.json
```

The printed address must be `CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu`. It will not be by chance: a fresh key gives a random address, so the key file for this id must be the one you made for it earlier. If you no longer have that key, the build has to be remade for a new id, and this step changes.

```powershell
solana program deploy program\aretia-curve\artifacts\aretia_curve.so --program-id <folder>\aretia-curve-program.json --max-len 395024 --keypair <deployer-keypair.json> --url mainnet-beta
solana program set-upgrade-authority CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu --new-upgrade-authority GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA --skip-new-upgrade-authority-signer-check --keypair <deployer-keypair.json> --url mainnet-beta
node scripts/curve-solana-mainnet.mjs verify --program CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu
```

Do the second command at once: until you do, one key can replace the program. `verify` must print `Verified`. *Proves:* the bytes on chain are exactly the committed build, nothing but zeros follows them, the id is inside it, and the upgrade authority is the Squads vault. It does not prove the program is correct.

**4d. Wire the site (the one-line change), only after `Verified`:**

```powershell
cd website
node scripts/wire-solana-mainnet-id.mjs curve --address CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu --i-ran-verify
npm test
```

This changes `export const CURVE_PROGRAM_ID_MAINNET: string | null = null;` in `src/scripts/walletCurveCore.ts` to `= CURVE_PROGRAM_ID_MAINNET_PLANNED;` and flips the two gate tests (`walletCurveGate.test.ts`, `walletCurveCore.test.ts`) from `toBeNull()` to the id. The script refuses any address other than the build's own id and stops without writing if the code has changed. Commit, merge, deploy: because `PUBLIC_CURVE_ENABLED` is already `1`, the Solana card is live at once. **Rehearse straight away** with a very small curve (0.1 SOL target): create, buy, sell, and keep the money small until you have watched a migration.

### Step 5: EVM helpers (rescue and seeder), per chain

Both are small, ownerless and hold nothing. They exist so a graduation or a pool is not blocked by someone who made the exchange pair first and left dust in it.

```powershell
cd website
npm i --no-save viem
mkdir ..\evm-out; cd ..\evm-out
node ..\website\scripts\evm-helpers-mainnet.mjs prepare --chain ethereum --helper rescue
node ..\website\scripts\evm-helpers-mainnet.mjs prepare --chain ethereum --helper seeder
```

Repeat with `--chain bnb` and `--chain polygon`. `prepare` is read-only: it checks that the committed build matches the pinned runtime sha-256 (`AretiaCurveRescue` `2035a510…8d1e`, `AretiaPairSeeder` `e65f98ae…9b43`), that the router, exchange factory, wrapped coin and curve are what the code expects, runs the constructor in a read-only call, prints the gas estimate, and writes `<helper>-<chain>-creation.json` (`data` is the creation transaction's data). Constructor arguments: rescue takes the curve `0x4e85bc5bd6f08fa87ceb749372e34226556837e8`; the seeder takes the chain's router (Uniswap V2 `0x7a250d5630b4cf539739df2c5dacb4c659f2488d`, PancakeSwap V2 `0x10ed43c718714eb63d5aa57b78b54704e256024e`, QuickSwap `0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff`).

Deploy it on your own machine. This reads a key file you name; never share it, and use a wallet funded for gas only:

```powershell
$env:DEPLOYER_KEY_FILE = "<file holding one 0x key>"
node scripts\evm-helpers-mainnet.mjs send --chain ethereum --helper rescue --yes-mainnet
node scripts\evm-helpers-mainnet.mjs send --chain ethereum --helper seeder --yes-mainnet
node scripts\evm-helpers-mainnet.mjs verify --chain ethereum --helper rescue --address <new address>
node scripts\evm-helpers-mainnet.mjs verify --chain ethereum --helper seeder --address <new address>
```

(Or deploy `data` from the JSON file with your own tooling; `verify` is the same.) `send` estimates gas, refuses if the wallet cannot cover it with a 20% margin, and prints the new address. `verify` compares the on-chain code byte for byte with the committed build, reads back `curve()` / `router()`, `weth()`, `pairFactory()`, and checks the balance. Then verify the **source** on each explorer: `contracts-evm/VERIFY.md` has the settings (solc 0.8.26, optimizer on, 200 runs, EVM `paris`, Standard JSON Input with `AretiaCurveRescue.standard-input.json` or `AretiaPairSeeder.standard-input.json`).

Where the addresses go (lower-case), after `verify` passes:
- rescue: `EVM_CURVE_RESCUE_ADDRESSES.<chain>` in `website/src/scripts/walletCurveEvmCore.ts`, and the test that pins them as null, `walletCurveEvmRescue.test.ts` ("is null on every chain until the helper is deployed").
- seeder: `EVM_PAIR_SEEDER_ADDRESSES.<chain>` in `website/src/scripts/walletPoolEvmCore.ts`.

Once per chain, rescue a deliberately poisoned pair (on a mainnet fork or with a token of your own) before relying on it (`docs/BONDING_CURVE_EVM.md` section 16). *Proves:* the deployed code is the committed code and points at the right curve and exchange. It does not prove the helper is safe; it is unaudited.

### Step 6: EVM Aretia Pool, per chain

(Use `$w` from step 5.) The pool's constructor is the chain's token factory, the fee address and the creation fee (equal to the factory's fee: 0.0042 ETH, 0.014 BNB, 105 POL). Factories are in `contracts-evm/VERIFY.md`.

```powershell
node ..\website\scripts\pool-evm.mjs prepare --chain ethereum
$env:DEPLOYER_KEY_FILE = "<file holding one 0x key>"
node ..\website\scripts\pool-evm.mjs send --chain ethereum --yes-mainnet
node ..\website\scripts\pool-evm.mjs verify --chain ethereum --address <new address>
```

Same for `bnb` and `polygon`. `verify` also reads back the fee, share and range constants and checks the contract is solvent. Verify the source on the explorer with `AretiaPool.standard-input.json` (settings in `VERIFY.md`; the constructor arguments are the factory, the fee address, the creation fee).

Where the address goes after `verify`: `EVM_POOL_ADDRESSES.<chain>` and `EVM_POOL_DEPLOY_BLOCKS.<chain>` (the block number of the deployment transaction, from the explorer) in `website/src/scripts/walletAretiaPoolEvmCore.ts`, then update `walletAretiaPoolEvmGate.test.ts` (the two `toEqual([null, null, null])` lines) and `walletAretiaPoolEvmCore.test.ts`. Set `PUBLIC_ARETIA_POOL_EVM_ENABLED=1` in Vercel only for a watched rehearsal. The Sepolia pool from before the review is the old build and is not to be reused; a testnet rehearsal of the new build (`pool-evm.mjs deploy --chain sepolia`, test coins only) is worth doing first.

### Step 7: Solana Aretia Pool and `aretia-curve-grad` (needs a rebuild first)

**The committed builds cannot be deployed to mainnet.** `aretia_pool.so` is made for the devnet id `4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc` and `aretia_curve_grad.so` for the devnet id `Ak12tX3J3m5rSmWLXUttyDpVAsniszkfvVG1GgWmnuBm` pointing at the devnet pool. A programme's id is written into it at build time. `grad` has a `mainnet` feature that deliberately refuses to compile until both mainnet ids are written in. So:

1. Make two program keys on your machine, outside the repo, and note only the public addresses:
   ```powershell
   solana-keygen new --no-bip39-passphrase --outfile <folder>\aretia-pool-program.json
   solana-keygen new --no-bip39-passphrase --outfile <folder>\aretia-curve-grad-program.json
   solana address --keypair <folder>\aretia-pool-program.json
   solana address --keypair <folder>\aretia-curve-grad-program.json
   ```
2. Give the two **public** addresses to a Claude session (an address is not a secret). It will set `declare_id!` in `program/aretia-pool`, set `declare_id!` and `ARETIA_POOL_PROGRAM` in `program/aretia-curve-grad` and build with `--features mainnet`, and everything else that names the ids (Rust tests, the IDL, the Jupiter adapter), with the same toolchain and committed lockfiles (`cargo-build-sbf` 2.1.21, platform-tools v1.43), check the build log has no "Stack offset … exceeded" line, run the program tests, and commit the new `.so` files and their `.sha256`. After that the `STOP` line in `prepare` disappears.
3. Re-run `prepare` for each: `node scripts/pool-solana-mainnet.mjs prepare`, `node scripts/grad-solana-mainnet.mjs prepare` (costs in step 1). It prints the same deploy and hand-over commands as step 4 with `--max-len` set to the build size, using `aretia-pool-program.json` and `aretia-curve-grad-program.json`.
4. Deploy the pool first, hand over its authority, verify; then the graduation programme (deploy, hand over, verify with `--pool <mainnet pool id>`, which also checks the build points at that pool and not the devnet one):
   ```powershell
   node scripts/pool-solana-mainnet.mjs verify --program <POOL_ID>
   node scripts/grad-solana-mainnet.mjs verify --program <GRAD_ID> --pool <POOL_ID>
   ```
5. Wire the pool id after `Verified`: `node scripts/wire-solana-mainnet-id.mjs pool --address <POOL_ID> --i-ran-verify` (sets `ARETIA_POOL_PROGRAM_ID_MAINNET` in `walletAretiaPoolCore.ts` and flips its gate tests). The site does not name the graduation programme's id anywhere yet, so there is nothing to wire for it until the Launch flow offers it. Turn `PUBLIC_ARETIA_POOL_ENABLED=1` on only for a watched rehearsal.

Both are **unaudited**, and the Solana Aretia Pool has had no independent review at all (`docs/ARETIA_POOL.md` section 18). `docs/ARETIA_POOL.md` section 15 lists what was left out on purpose.

### Step 8: what Jupiter and DexScreener still need

None of this can be done by us; they decide. From `docs/ARETIA_POOL_INTEGRATION.md`:
- Jupiter: a mainnet pool program id, an independent audit, a public IDL (built: `program/aretia-pool/idl/aretia_pool.json`), an adapter in their `jupiter-amm-interface` format (built, with a placeholder `Swap::TokenSwap` that Jupiter assigns), live liquidity, and Jupiter's own router variant. They add the AMM through their own process.
- DexScreener and GeckoTerminal: the same pack per pool (program id, pool address, mints, reserves, swap events; the price is `(y + l) / (x + vx)`, not the vault ratio) plus a mainnet pool to look at. So this waits for step 7.
- Token logos: tokens without a hosted metadata JSON show blank in wallets. IPFS hosting is decided but not built (it needs a pinning-service key held server side, and the site is at the 12-function limit).
- Until Jupiter routes the Aretia Pool, Meteora stays the default for tokens that want outside reach (owner decision of 2026-10-18).

### Step 9: keys

Keep the EVM fee key (`0xeb8725…0945`) offline; never sign an EIP-7702 or "upgrade to smart account" request with it (the scripts stop if the address ever has code). Never close the Solana fee wallet's wrapped-SOL account. Keep the program key files and deployer keys outside the repo.

## 3. What only you can do

Fund the deployers; run every command that signs or spends (deploys, hand-overs, the Meteora test run, Supabase migrations, Vercel variables and flags, explorer verification with your own logins); keep the program-key files; sign in the Squads vault when an upgrade is ever needed; produce the two public Solana addresses for step 7; decide when each flag goes on; and make the Jupiter, DexScreener and audit requests.

## 4. What each check does not prove

`verify` scripts prove bytes and settings, not correctness. The tests prove behaviour in a local VM and on devnet or testnets, not on mainnet. Nothing here has had an independent audit, and a ChainSecurity review of the EVM curve is still in progress: do not describe any of it as audited, and keep the notice on every card until a report says otherwise.
