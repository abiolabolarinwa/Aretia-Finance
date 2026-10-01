# Launch pools (Meteora DAMM v2, single-sided)

`create-pools.mjs` creates two pools from the treasury vault:

| Pool | Address (deterministic) | Opens at |
| --- | --- | --- |
| ACT/USDC | `6n8Mvd7xmZs66E5VLGQGvtE31gbKMcTL4S97W4oV6ivX` | 0.005 USDC per ACT |
| ACT/SOL | `ECJYQzo2YfWTChEnNsaThC5Aeng1hxfbfNG8DQVgkSkb` | $0.005 per ACT in SOL, at the SOL price when you run it |

Each pool is **single-sided**: only ACT goes in, priced from the floor up to the protocol maximum.
Nobody can buy below the floor. Buyers pay in USDC or SOL, which builds the other side of the
pool. The treasury vault owns both positions (through their position NFTs).

Defaults (override with env vars): `ACT_PER_POOL=5000000` (10M total), `FLOOR_USD=0.005`,
`POOL_FEE_BPS=25` (0.25% pool trading fee), `POOLS=usdc,sol`.

## Liquidity lock (optional, permanent)

`LOCK_LIQUIDITY=permanent` adds Meteora's `permanentLockPosition` right after each pool is created,
in the same Squads proposal. After that, **nobody can ever withdraw the liquidity, the treasury
included**: the ACT and all the USDC/SOL buyers put in stay in the pool for good. The position can
still claim its trading fees. Off by default; it cannot be undone. Simulated OK on 1 Oct 2026
(one extra instruction per pool, no extra SOL).

```powershell
$env:LOCK_LIQUIDITY = "permanent"
node create-pools.mjs
```

## Dry run (safe, sends nothing)

```powershell
cd scripts/launch-pool
npm install
node create-pools.mjs
```

Builds every instruction and simulates it against live mainnet **as the treasury vault**, with no
keys. It prints the exact SOL rent needed, how much ACT leaves the treasury and how much lands in
each pool after ACT's own transfer fee.

Dry run on 1 Oct 2026 (epoch 1046, fee 3.5%): both pools simulated OK; ~0.035 SOL rent in total
(vault had 0.0627 SOL); per pool ~4,993,423 ACT left the treasury and ~4,818,653 ACT landed in the
pool (174,770 ACT withheld at 3.5%). At 1.5% the pool keeps ~4.92M.

## Execute (drafts Squads proposals; nothing moves until 2-of-3 approve)

```powershell
$env:PROPOSER_KEYPAIR_PATH = "C:\path\to\signer.json"
node create-pools.mjs --execute
```

- Refuses while ACT's active fee isn't 150 bps (i.e. before epoch 1048) unless `ALLOW_OLD_FEE=1`.
- Creates one proposal per pool. Each uses one Squads **ephemeral signer** for the position NFT.
- In Squads: check each proposal's instructions, approve 2-of-3, then execute. Pool creation is
  compute-heavy (~125k CU); if Squads' execute runs out of compute, raise its compute limit.
- Re-run the dry run right before executing so the SOL pool uses the current SOL price.

After execution, check both pools on Meteora and Solscan, then publish the website's trading
changes with the two pool addresses.
