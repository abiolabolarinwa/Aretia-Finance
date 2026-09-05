# Aretia Treasury — Live Multisig Record

**Status:** ✅ Created on **Solana mainnet**, 1 Sept 2026.

| Field | Value |
|---|---|
| Squad name | Aretia Treasury |
| Network | Solana Mainnet |
| Multisig address | `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg` |
| Threshold | 2 of 3 |
| Members | Founder (`4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG`), Co-signer 1 (`CAyPkS1VujDMNJ76QUq8vp4oeVpGeUsqffoAiVLKcB5r`), Co-signer 2 (`7Sn7H1idRb5Z8ysHfrGVgE8NuFu3vM2QQiPd6v87dVJx`) |

Signed [SIGNER_AGREEMENT_TEMPLATE.md](SIGNER_AGREEMENT_TEMPLATE.md) copies with both co-signers are tracked separately (not in this repo).

## Verification — complete

- [x] Both co-signers connected their own wallets and confirmed membership visibility.
- [x] Full propose → review → approve → execute cycle tested with a real small transaction, approved by 2 of 3 signers independently. Working as designed.

## Still open

- [ ] Top up the founder wallet — was down to ~0.005 SOL after the deploy fee; keep it funded for future transaction fees.
- [x] Set up a separate, lighter-weight wallet for the 0.1% management/operations fee, distinct from this 2-of-3 governance multisig — see `MANAGEMENT_FEE.md`.
- [x] Update `TOKENOMICS.md`, `PROTOCOL.md`, and the website to reference this real address.

Public address only. No private keys, seed phrases, or personal signer information belong in this file or this repository, ever.
