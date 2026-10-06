# Threat model

| # | Threat | Actor | Impact | Defence | Residual |
|---|---|---|---|---|---|
| T1 | Provider returns a transaction that drains funds | Compromised or malicious routing API | Loss of user funds | Simulation judge (Solana); target/spender allow-list and value check (EVM); wallet shows the transaction | Subtle drains the judge does not model |
| T2 | Token metadata lies (decimals, name, symbol) | Token creator, indexer | Wrong amount, wrong token | On-chain decimals, `chain:address` identity, cleaned text, collision warnings | EVM decimals path not built in UI |
| T3 | Honeypot / tax / freezable token | Token creator | User cannot sell | Risk signals for authorities and selectors; "unavailable" for taxes | Not detected on EVM |
| T4 | Stale or tampered quote | Network, provider | Worse execution | Expiry, slippage floor check, executability filter | Provider-reported `minOut` on EVM is trusted after the floor check |
| T5 | Double execution | Bug, double click, race | Paid twice | Executed-set before signing, adapter guard, concurrency test | Wallet-level replays are the wallet's |
| T6 | Unlimited approval | Provider, UI bug | Future drain | Exact-amount approvals only | Existing approvals from other apps untouched |
| T7 | MEV sandwich | Searchers | Worse price within slippage | Slippage limits | Not mitigated |
| T8 | Secret leakage via logs | Developer error | Key exposure | `redact`, aggregate-only analytics | Rest of site unaudited |
| T9 | Abuse of server endpoints | Anyone | Cost, data exposure | Origin/secret checks, rate limits, generic errors | Fake headers from scripts |
| T10 | Hostile discovery data poisoning the registry | Indexer, token creators | Misleading rows | Validation, per-chain source check, no automatic "verified" | A hostile token can still be listed (that is the point of the risk warnings) |
| T11 | Fee misconfiguration sends funds to the wrong place | Operator error | Loss | No defaults for EVM addresses, enabled-but-incomplete blocks execution, 100 bps cap | An operator who enters a wrong address |
| T12 | Supply chain (npm) | Attacker | Code execution | Lockfile; `npm audit` run (see production-readiness) | 13 known advisories, mostly in existing Solana dependencies |
