# Co-Funding Vault — Record

**Status:** ✅ Address re-derived against the v2 treasury multisig (see `TREASURY_V2.md`) after the v1→v2 rebuild. Not yet funded — no contributions have been solicited or received. The original v1-multisig-derived address (`27e1P7arTqPVdKNBEmQhtrjMXnVycrbuqkEHoCVdZSPY`) is superseded along with the rest of v1 and should not be used.

| Field | Value |
|---|---|
| Purpose | Receives direct co-funding contributions (grants, sponsorships, donations) from anyone who wants to support the catalyst fund without going through liquidity provision or holding ACT. Kept structurally separate from protocol-generated fee capital. |
| Address | `2QxsK5UMUh8D6Mpjwqt8DEYkzeyFEDR6EGWZjggp6zFg` |
| Custody | Squads vault index 1, under the same multisig as the treasury (`5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr`) — same 2-of-3 signer set, same governance, no new keys or signers. |
| Relationship to main treasury | Vault index 0 (`GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`) holds the ACT supply and protocol-fee-derived catalyst fund capital. Vault 1 holds only externally contributed capital. Both are controlled by the same multisig, so disbursement from either still requires 2-of-3 approval. |
| Network | Solana Mainnet |
| Current balance | 0 — account does not yet exist on-chain (Squads vaults activate on first use) |

## How the address was derived

Squads V4 vaults are deterministic PDAs derived from the multisig address and a vault index — they don't require a separate "creation" transaction to exist as an address; they become active the moment they're referenced in a transaction or receive funds. The derivation was computed offline (no RPC call needed, just the `@sqds/multisig` SDK's `getVaultPda`) and cross-checked: deriving vault index 0 against the v2 multisig with the same code reproduces `GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA` exactly, the same address already confirmed live in `TREASURY_V2.md` and `MINT_V2.md`. That match is what makes vault index 1's address trustworthy without needing to execute anything on-chain first. See `scripts/management-fee-proposal/derive-vault.mjs` (update its `MULTISIG_PDA` constant to the v2 multisig before re-running).

## Why a separate vault instead of the main treasury vault

Mirrors the same reasoning as the management-fee wallet: money the protocol *generates* (the 2% catalyst-fund share of the transfer fee) and money someone *gives* it are different things, and keeping them in different addresses makes that true structurally, not just in reporting. Once the transparency dashboard exists, "funded by trading activity" and "funded by outside contributions" can be shown as genuinely separate on-chain totals.

It also matters for anyone actually contributing: a foundation, company, or individual sending money here can verify, before and after sending, that their contribution landed in an account that holds nothing but co-funding, not one that's already carrying protocol fee revenue.

## What happens to money sent here

Same milestone-verified disbursement process as the main treasury (see `WHITEPAPER.md` Section 6): grants and on-chain credit retirements, released in tranches against independent verification, never as a lump sum, always via 2-of-3 multisig approval. No return, token, or equity is given in exchange for a contribution — this is a donation-style contribution, not an investment.

## Still open

- [ ] Not yet funded — nothing to disburse from here yet.
- [ ] No public-facing "how to co-fund" page exists yet describing this vault to a prospective giver.
- [ ] Reference this vault on the transparency dashboard as its own line, once that's built, alongside the treasury vault and the management-fee wallet.

Public address only. No private keys, seed phrases, or personal signer information belong in this file or this repository, ever.
