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

## Operator-script advisories (F-08 triage, 2026-10-12)

Method: `npm audit --omit=dev` per project, plus a grep of which affected packages each script imports and calls. This is a reachability review by reading, not an exploit attempt. Triage records exploitability; it does not remove the advisories.

| Advisory (package) | Projects | Affected code path in our scripts | Assessment |
|---|---|---|---|
| `bigint-buffer` `toBigIntLE()` buffer overflow (GHSA-3gc7-fjrx-p6mg), via `@solana/spl-token` → `buffer-layout-utils` | launch-pool, management-fee-proposal, rebuild-mint, treasury-v2-setup | Reachable in principle: scripts call `getMint` / `getAccount` / `unpackAccount`, which decode on-chain account data with these layouts | Input is account data returned by the operator's configured RPC, read on an operator workstation. No network listener, no untrusted user input. Low practical exploitability; the risk is a hostile or compromised RPC crashing the tool. Use a trusted RPC. |
| `@coral-xyz/anchor` / `toml` (GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j), via `@meteora-ag/cp-amm-sdk` | launch-pool, devnet-amm | `toml` parses `Anchor.toml`-style files; no script reads TOML | Not reached by our code. Accepted; no non-breaking fix. |
| `@solana/web3.js` transitive (via `jayson`) | all | Used throughout for RPC and signing | Same trust model as above; see the website triage. |
| `ws` memory disclosure / exhaustion DoS (GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p), via `@irys/*` → `@ethersproject/providers` | rebuild-mint | `upload-metadata.mjs` uploads to Irys as a **client** | Needs a malicious server to exploit. **No non-breaking fix:** `@ethersproject/providers` pins `ws` to exactly 8.18.0, and `npm audit fix` (checked on a scratch copy, 2026-10-12) leaves `ws` at 8.18.0 and only bumps the Metaplex `umi*` packages 1.5.1 → 1.6.0, so it was not applied. `ws` 8.21.3+ exists; reaching it needs an `overrides` entry or a newer `@irys/*` release. Accepted for now; owner decision. |
| `@sqds/multisig` / `@metaplex-foundation/beet-solana` | launch-pool, management-fee-proposal, treasury-v2-setup | Transaction construction for Squads proposals | Same `bigint-buffer` root cause; no separate path. |

Unresolved and for the owner: whether to move to a newer `@solana/spl-token` / `@sqds/multisig` line when one that drops `bigint-buffer` exists (a dependency-version change, deliberately not made here), and whether to force `ws` 8.21.3+ with an `overrides` entry (untestable here: the Irys upload path cannot be exercised offline). Nothing here lets a remote party reach these tools; the main control is running them only with a trusted RPC endpoint and with signing keys handled per the operator runbook.
