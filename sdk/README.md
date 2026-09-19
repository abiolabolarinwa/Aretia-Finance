# Aretia Finance -- SDKs and IDLs

Unofficial, community-maintained TypeScript clients and Anchor IDLs for Aretia Finance's two Solana programs.

| Program | npm package | SDK source | IDL | Status |
|---|---|---|---|---|
| `act-staking` | [`@aretiafinance/act-staking-sdk`](https://www.npmjs.com/package/@aretiafinance/act-staking-sdk) | [`act-staking/`](act-staking/) | [`idl/act_staking.json`](idl/act_staking.json) | Devnet-verified, full automated test suite passing, independent review confirmed. Not yet on mainnet -- see [`../STAKING_DESIGN.md`](../STAKING_DESIGN.md). |
| `act-presale` | [`@aretiafinance/act-presale-sdk`](https://www.npmjs.com/package/@aretiafinance/act-presale-sdk) | [`act-presale/`](act-presale/) | [`idl/act_presale.json`](idl/act_presale.json) | Devnet-verified end to end. Not yet on mainnet -- see [`../PRESALE_DESIGN.md`](../PRESALE_DESIGN.md). |

## Why these exist, and an important caveat

Before this, integrating with either program meant reverse-engineering instruction discriminators and account layouts from the Rust source by hand -- which is literally what every script in `../program/*/scripts/` had to do, since **no Anchor CLI was available in the environment these programs were built in**. There's no `anchor build`-generated IDL to start from, and no generated TypeScript client either.

Both the IDLs and the SDK clients here were **hand-authored** against the actual `lib.rs` source of each program, not machine-generated. The one part that isn't guesswork: every instruction/account discriminator was computed programmatically (`sha256("global:<name>")[0..8]` / `sha256("account:<name>")[0..8]`, matching Anchor's own convention exactly), not hand-typed -- see the comment at the top of each `client.ts`. The SDK clients additionally reuse the exact PDA-derivation and instruction-building logic already proven correct against real, confirmed devnet transactions in each program's own test scripts, rather than being written from scratch.

Still: **treat the Rust source as the ground truth.** If anything here ever disagrees with `lib.rs`, the source wins, and it's a bug in this SDK/IDL worth reporting.

## Structure

```
sdk/
  idl/
    act_staking.json     -- Anchor IDL for act-staking
    act_presale.json     -- Anchor IDL for act-presale
  act-staking/
    src/client.ts         -- ActStakingClient
    README.md
  act-presale/
    src/client.ts         -- ActPresaleClient
    README.md
```

## Building

Each package builds independently:

```bash
cd sdk/act-staking && npm install && npm run build
cd sdk/act-presale && npm install && npm run build
```
