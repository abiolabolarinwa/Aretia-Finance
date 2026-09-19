# @aretiafinance/act-staking-sdk

Unofficial TypeScript client for Aretia Finance's `act-staking` Solana program. Published to npm as [`@aretiafinance/act-staking-sdk`](https://www.npmjs.com/package/@aretiafinance/act-staking-sdk) -- `npm install @aretiafinance/act-staking-sdk`, or clone this repo and build it yourself (see below).

**Status: devnet-verified, not yet on mainnet.** See [`../../STAKING_DESIGN.md`](../../STAKING_DESIGN.md) and [`../../program/act-staking/README.md`](../../program/act-staking/README.md) for the full verification history before using this against anything but devnet.

## Why this exists

Before this, the only way to interact with `act-staking` was to hand-build every instruction (discriminator, account order, borsh args) from scratch, the way every script in `../../program/act-staking/scripts/` had to. This package packages that same, already-proven logic into a reusable client.

**How it was built:** no Anchor CLI was available in the environment this program was developed in, so there's no `anchor build`-generated IDL or TypeScript client to start from. This SDK's instruction builders were hand-written directly against [`lib.rs`](../../program/act-staking/programs/act-staking/src/lib.rs) and cross-checked against the discriminators/account layouts already proven correct in the devnet test scripts -- not generated from the IDL at `../idl/act_staking.json` at runtime. Treat the source as authoritative if the two ever disagree, and please open an issue if you find a discrepancy.

## Install

```bash
cd sdk/act-staking
npm install
npm run build
```

## Usage

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ActStakingClient } from "./dist";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const client = new ActStakingClient(connection); // defaults to the real program ID

// Read state
const config = await client.fetchStakeConfig();
const myStake = await client.fetchUserStake(myWallet.publicKey);

// Build a stake instruction (you sign and send it yourself)
const ix = client.ixStake(myWallet.publicKey, actMint, myAta, 1_000_000_000n, 90);
```

## What's covered

All six instructions: `initialize_config`, `update_tier_config`, `set_paused`, `set_config_authority`, `stake`, `unstake` -- plus decoders for both account types (`StakeConfig`, `UserStake`) and every PDA derivation the program uses.

## What's not included

Convenience `send*` wrappers exist only for `stake`/`unstake` (the two instructions a typical integration actually needs at runtime). Admin instructions (`initialize_config`, `update_tier_config`, `set_paused`, `set_config_authority`) are exposed as raw instruction builders only, since real usage runs them through the treasury multisig, not a plain keypair signature.
