# @aretiafinance/act-presale-sdk

Unofficial TypeScript client for Aretia Finance's `act-presale` Solana program. Published to npm as [`@aretiafinance/act-presale-sdk`](https://www.npmjs.com/package/@aretiafinance/act-presale-sdk) -- `npm install @aretiafinance/act-presale-sdk`, or clone this repo and build it yourself (see below).

**Status: devnet-verified, not yet on mainnet.** See [`../../PRESALE_DESIGN.md`](../../PRESALE_DESIGN.md) for the full verification history, the deployment sequence, and exactly what "explicit, separate approval" gate still stands between this and mainnet before you rely on it for anything real.

## Why this exists

Every instruction here was previously only buildable by hand, the way `../../program/act-presale/scripts/exercise-devnet-*.mjs` had to build them -- discriminator computation, account ordering, borsh encoding, none of it generated. This package wraps that same proven logic in a reusable client.

**How it was built:** no Anchor CLI was available in the environment this program was developed in, so there's no `anchor build`-generated IDL or TypeScript client to start from. This SDK's instruction builders were hand-written directly against [`lib.rs`](../../program/act-presale/programs/act-presale/src/lib.rs), not generated from the IDL at `../idl/act_presale.json` at runtime. Treat the source as authoritative if the two ever disagree.

## Install

```bash
cd sdk/act-presale
npm install
npm run build
```

## Usage

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { ActPresaleClient } from "./dist";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const client = new ActPresaleClient(connection);

const config = await client.fetchConfig();
const myBuyerAccount = await client.fetchBuyerAccount(myWallet.publicKey);

// Build a buy instruction (USDC/USDT) -- you sign and send it yourself
const ix = client.ixBuy(
  myWallet.publicKey,
  usdcMint,
  usdcVault,
  myUsdcAta,
  TOKEN_PROGRAM_ID,
  10_000_000n // 10 USDC, 6 decimals
);
```

## What's covered

Buyer-facing instructions as convenience builders: `buy`, `buy_with_sol`, `refund`, `refund_sol`, `claim`, plus `set_paused`/`set_config_authority`. Account decoders for `PresaleConfig` and `BuyerAccount`, and every PDA derivation the program uses.

## What's deliberately not included

`initialize_presale`, `initialize_payment_currency`, `fund_act_reserve`, `finalize`, and `sweep_unsold_act` don't have convenience builders. These are one-time or low-frequency admin operations run directly against the Squads treasury multisig in practice (see `PRESALE_DESIGN.md`), not something a buyer-facing integration typically needs. Build them the same way `program/act-presale/scripts/` does if you need them -- same discriminator + borsh-args convention as every instruction that is covered.

## SOL payments need a live Pyth price update

`buy_with_sol` requires a `PriceUpdateV2` account posted on-chain immediately before (or in the same transaction as) your call -- see the module-level doc comment in `lib.rs` and `program/act-presale/scripts/exercise-devnet-buy-with-sol.mjs` for a full working example using `@pythnetwork/pyth-solana-receiver` and `@pythnetwork/hermes-client`.
