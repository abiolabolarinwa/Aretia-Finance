# ADR-0002: Solana primitives live in `swings/core`, with a compatibility re-export
- Status: accepted (implemented, M-02)
- Date: 2026-10-11
## Context
`SWAP_FEE_WALLET`, `KNOWN_TOKENS`, `isSolanaAddress`, `ataAddress`, `TOKEN_PROGRAM_ID` lived in a UI-script module but were consumed by 21+ Swings files, inverting the intended layering and placing the fee destination in a UI helper.
## Decision
Move the module verbatim to `src/swings/core/solanaTools.ts`; `src/scripts/walletTools.ts` becomes `export * from '../swings/core/solanaTools.js'`. A characterization test pins values and binding identity.
## Alternatives considered
Leave in place and allow the dependency (rejected: contradicts documented layering); split fee config from address helpers (deferred: would change more than a structural move).
## Consequences
Old importers unchanged; new code imports from core. Fee wallet is now in the layer that audits scope as "core".
## Security implications
Fee destination must not change silently: guarded by `solanaTools.test.ts`; CODEOWNERS covers `swings/core`. Values identical to before.
## Migration implications
None for callers. Remove the re-export once no importer remains in `src/scripts`.
