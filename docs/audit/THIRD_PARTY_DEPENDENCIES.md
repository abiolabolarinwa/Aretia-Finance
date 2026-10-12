# Third-Party Dependencies — Aretia Finance

`npm audit --omit=dev` counts, 2026-10-11 (advisories ≠ exploitability; none triaged for reachability yet).

| Project | mod | high | crit | Notes |
|---|---|---|---|---|
| website | 3 | 0 | 0 | `jayson`→`stream-json` via `@solana/web3.js` 1.99.x. CI blocks at high |
| scripts/launch-pool | 8 | 7 | 0 | operator tool |
| scripts/management-fee-proposal | 7 | 4 | 0 | handles signer keys |
| scripts/rebuild-mint | 14 | 5 | 0 | 13 low |
| scripts/treasury-v2-setup | 6 | 4 | 0 | |

No Rust or on-chain program dependencies remain (programs removed 2026-10-12).
Trust assumptions: Token-2022 (fee extension semantics), Pyth (SOL/USD feed integrity), Squads (multisig execution), Jupiter/0x/GeckoTerminal (untrusted quote/metadata data), Supabase/Vercel (hosting, secrets), RPC providers (availability, honesty of reads).
Policy: dependency updates by reviewed PR (dependabot grouped); no auto-merge; do not upgrade solely because newer.
