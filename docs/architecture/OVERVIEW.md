# Architecture Overview — Aretia Finance

Source of truth for diagrams and dependency rules: [`PROPOSAL.md`](PROPOSAL.md) §2. Baseline facts: [`BASELINE.md`](BASELINE.md).

**System context.** Aretia Finance is a Solana protocol workspace (Token-2022 ACT mint; Squads-multisig treasury; the repository itself contains no on-chain programs) plus a website that hosts the Aretia Swings swap engine and a non-custodial web wallet front end. The browser extension wallet lives in the separate `aretia-wallet` repository.

**Dependency direction (enforced by ESLint rule, report-only):** `website/src/swings/**` ← `website/src/scripts/**` ← `website/src/pages/**`. Swings must not import upward. 3 documented exceptions remain (see [`BOUNDARY_EXCEPTIONS.md`](BOUNDARY_EXCEPTIONS.md)).

**Trust boundaries.** (1) User's wallet signs; the site never holds keys (inspected). (2) Browser → Vercel API: provider keys (0x, RPC, Supabase service role) exist only server-side. (3) Operator workstation → mainnet: deployer/signer keys, multisig. (4) Third-party data (quotes, token metadata) is untrusted input.

**Blockchain interactions.** Solana (swaps via Jupiter/direct venues), EVM chains via 0x and direct venues, CCTP settlement for USDC. Chain-specific code lives under `swings/{solana,dex,chains,settlement}`.

**What is not implemented.** See `AUDIT_SCOPE.md` "do not audit as if present".
