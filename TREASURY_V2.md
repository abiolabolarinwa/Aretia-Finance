# Aretia Treasury v2 — Live Multisig Record

**Status:** ✅ Created on **Solana mainnet**, 9 Sept 2026. Distinct from, and unrelated in on-chain state to, the v1 treasury documented in `TREASURY.md` — v1 is being retired as part of the ACT v2 rebuild (see `WHITEPAPER.md` and the rebuild scripts under `scripts/rebuild-mint/`).

| Field | Value |
|---|---|
| Squad name | Aretia Finance Treasury (as labeled in the Squads UI — same display name as v1; disambiguate by address, not name) |
| Network | Solana Mainnet |
| Multisig PDA | `5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr` |
| Vault (index 0) | `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` |
| Threshold | 2 of 3 |
| Members | Founder (`4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG`), Co-signer 1 (`CAyPkS1VujDMNJ76QUq8vp4oeVpGeUsqffoAiVLKcB5r`), Co-signer 2 (`7Sn7H1idRb5Z8ysHfrGVgE8NuFu3vM2QQiPd6v87dVJx`) — the same three people as v1, deliberately, per the decision to keep signers unchanged while giving v2 its own clean multisig instance |

Note on the address that appears in the Squads UI's own URL bar (e.g. `/squads/GtKGE.../treasury`): that is the **vault** address, not the multisig PDA. The multisig PDA (`5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr`) is a separate account and is what scripts (e.g. `scripts/treasury-v2-setup/propose-test-transfer.mjs`) actually address directly. Both were confirmed independently on-chain — not assumed from the UI — by searching all Squads multisig accounts where the founder is a member and decoding each with `@sqds/multisig`.

## Verification — complete

- [x] Multisig confirmed on-chain distinct from v1 (different PDA, different vault) via a direct program-account search, not just trusted from the Squads UI.
- [x] Threshold and member set confirmed on-chain: 2-of-3, same three addresses as v1.
- [x] Full propose → review → approve → execute cycle tested with a real transaction: a 0.0001 SOL transfer from the vault back to the founder's own wallet, proposed via `scripts/treasury-v2-setup/propose-test-transfer.mjs`, approved independently by 2 of 3 signers in the Squads UI, executed on-chain. Confirmed via Solscan: a `vaultTransactionExecute` instruction, and the vault's resulting balance (0.0009 SOL) matches the expected pre-transfer balance minus the test amount exactly.

## Funding

- Vault received an initial ~0.001 SOL to cover multisig creation and the test transaction.
- Founder sent an additional 0.1032 SOL to the vault shortly after (9 Sept 2026), ahead of the real mint-creation costs (mint account rent, associated token accounts, Metaplex + Token-2022 metadata account rent). This has not yet been itemized against the actual mint-creation script's real cost — do that before assuming it's sufficient.

## Still open

- [ ] This multisig is not yet referenced as the transfer-fee-config / withdraw-withheld authority for any mint — that only happens once the v2 mint-creation script actually runs (see `scripts/rebuild-mint/`).
- [ ] Signer identity, independence, jurisdiction, and conflict-of-interest disclosure — same open item as `WHITEPAPER.md` §15.3's placeholder for v1, and equally unresolved here since it's the same three people.
- [ ] v1 retirement plan (what happens to the v1 mint, its 100M supply currently sitting in the v1 vault, and the v1 multisig itself once v2 is live) — not yet written.

Public addresses only. No private keys, seed phrases, or personal signer information belong in this file or this repository, ever.
