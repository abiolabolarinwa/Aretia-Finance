# Mainnet runbook: Aretia Orders on Solana

**Status: prepared, never run.** Nothing in this repository has been deployed. Every step below is done by a person with the
right keys, on their own machine. The tools only build instructions and read state back; none of them holds a key or sends
a transaction. Owner decisions are in [ADR 0007](adr/0007-order-program.md).

## 0. Stop-and-check before anything

- [ ] **The curve comes first.** Orders trade against the web wallet's `aretia-curve` (id reserved as `CCBr6D…tVBu`). It is
      **unaudited and not deployed**. Deploy and verify it under its own plan; until then orders have nothing to fill against, and
      a token that never graduates never reaches the Meteora pool either.
- [ ] **The curve venue adapter** (`aretia-orders-web-curve-venue`) is only needed to fill SOL orders while a token is still on
      its curve. Skip it to start with graduated tokens only (the Meteora pool is called directly).
- [ ] Both programs are built from a clean checkout of the merged commit: `anchor build` (Anchor 1.2.0), then record the `.so` sha256.
- [ ] Decide who holds the **deployer key** (a throwaway wallet funded with enough SOL for rent of the program, about 3 x the `.so` size) and keep it offline afterwards.
- [ ] Multisig details: which multisig is the **upgrade authority** and which is the **admin** (A `4DoV9F…hdjG`, B `CAyPkS…cB5r`
      are the two supplied; the roles are not yet assigned), their thresholds, and the **72-hour timelock** (a Squads `time_lock`
      of 259200 seconds). **Set the time lock before handing over authority**, or the delay protects nothing.
- [ ] The Aretia Solana fee wallet is `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2` (owner decision). Its token accounts must not be frozen.

## 1. Deploy the program (deployer machine)

```
solana program deploy target/deploy/aretia_orders.so --program-id <KEYPAIR for the chosen address> --keypair <deployer> --url mainnet-beta
solana program show <PROGRAM_ID>        # authority must still be the deployer
sha256sum target/deploy/aretia_orders.so  # compare with `solana program dump` of the deployed bytes
```

## 2. Generate the set-up instructions (any machine, no keys)

```
SETUP_PROGRAM_ID=<id> SETUP_DEPLOYER=<deployer pubkey> SETUP_ADMIN=<admin multisig VAULT address> \
SETUP_FEE_RECIPIENT=2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2 SETUP_CURVE_PROGRAM=<curve id> \
SETUP_SOL_MIN_LAMPORTS=<about USD 50 of SOL today> SETUP_OUT=./order-setup \
npm run plan -w apps/order-keeper
```

It writes `1-initialize-config`, `2-set-venues`, `3-enable-assets` as readable JSON and as unsigned transactions (base64). The
instruction bytes are checked against the compiled program in `golden-admin-instructions.json`. Read the JSON before signing
anything: the admin address, the fee wallet, the curve program, and the venue list are the things to check.

## 3. Initialise (deployer signs)

Sign and send `1-initialize-config` with the deployer. It names the **admin multisig** at creation, so the admin never passes
through a personal key. Only the upgrade authority can run it, which stops anyone front-running the set-up.

## 4. Hand over the upgrade authority

```
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <upgrade-authority multisig vault> --keypair <deployer>
```

Do this **only after** the time lock is on that multisig. After this the deployer key cannot change the program.

## 5. Multisig proposals

Import `2-set-venues` and `3-enable-assets` as transactions in the admin multisig, approve to threshold, execute after the delay.
The venue list starts with Meteora DAMM v2 only (plus the curve adapter if step 0 allowed it). **Never whitelist a program without
its own tests**: a venue receives the order's signature during a fill.

## 6. Read it back (read-only)

```
VERIFY_RPC_URL=<rpc> VERIFY_PROGRAM_ID=<id> VERIFY_ADMIN=<admin vault> VERIFY_UPGRADE_AUTHORITY=<upgrade multisig> \
VERIFY_FEE_RECIPIENT=2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2 VERIFY_CURVE_PROGRAM=<curve id> \
npm run verify-setup -w apps/order-keeper
```

It exits non-zero and says what differs. Do not announce anything until it passes.

## 7. The keeper (Solana)

Create a **new Solana hot wallet** (the EVM address supplied for the keeper cannot sign Solana transactions), fund it with a
few SOL, and run the keeper **in dry-run first**, with the key in the host's secret store: `KEEPER_MODE=dry-run`. Switch to
`live` and `KEEPER_ALLOW_MAINNET=yes` only after a clean dry-run day. It needs the enabled assets, so step 5 first.

## 8. Day-one checks and rollback

- Place one order of the minimum size from a test wallet, then cancel it, and confirm the fee equals 0.58% of the unfilled amount.
- **Pause** is the first response to anything odd: `update_config(paused = true)` from the multisig stops new orders and fills;
  owners can still cancel (a pause never traps money).
- Fee changes apply to new orders only; open orders keep the fees they were made with.

## What this runbook does not cover

The EVM contract. With the proof change (`claude/orders-evm-create-proof`) it can be deployed against the live factories, but its deployment steps are not written yet: the constructor takes the admin multisig, the fee wallet, the token factory, the wrapped native token and the four fee numbers, and the admin then whitelists the router and enables the assets. See [known-limitations.md](known-limitations.md).
