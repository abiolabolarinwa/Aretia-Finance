# Production readiness

## Verdict: NOT production ready

The standalone engine is wired into the screen and has direct paths on all five chains, with Solana routing (direct, two-hop, atomic split) within 0.15% of Jupiter on the pairs tested. But it has not signed a single real swap, the ACT buyback has never been enabled, and the database schema has never been applied to Aretia's project. See `ARETIA_SWINGS_AUDIT_READINESS.md`.

Aretia Swings must not be described as live or production-ready. Critical checks below have not been done, and most of them need things only the owner can supply (keys, funds, a database, EVM addresses).

## Checklist (Milestone 25)

| # | Check | Result |
|---|---|---|
| 1 | Complete test suite | **Pass**: 261 tests in 15 files, plus about 50 read-only live checks (`npm run test:live`; it depends on public nodes and can fail on their rate limits) |
| 2 | Typecheck | **Pass**: 0 errors, 0 warnings (1 style hint) |
| 3 | Lint | **Pass** |
| 4 | Production build | **Pass** |
| 5 | Dependency audit | **Not clean**: after `npm audit fix`, `npm audit --omit=dev` reports 11 advisories (7 moderate, 4 high), down from 13. Direct: `@bonfida/spl-name-service`, `@solana/web3.js`. Transitive: `bigint-buffer`, `jayson`, `uuid` and the Solana token packages. Every remaining fix is a breaking major upgrade of existing wallet dependencies (`@solana/web3.js` 3.x). Not caused by the Swings additions (dev dependencies `vitest` and `fast-check` only). Needs its own migration and testing |
| 6 | Security scanners | **Configured, not yet run**: CodeQL (`security-extended`) and gitleaks are in `.github/workflows/` and run on GitHub after a push. ESLint and TypeScript strict pass locally. No external audit |
| 7 | All five chains tested | **Partial**: on all five chains the exact transaction Aretia builds is accepted by the real venue programs in simulation. **No swap has been signed or sent on any chain.** EVM chains are off by default |
| 8 | Real mainnet quotes | **Done for the direct paths**: real quotes from the venues on all five chains, compared with the venues' own routers. Jupiter quotes also verified. No 0x quote (needs a key) |
| 9 | Small-value real transactions | **Not done** |
| 10 | Confirmations verified | **Not done** (logic unit-tested with fakes) |
| 11 | Balances verified after a swap | **Not done** |
| 12 | Fee accounting verified | **Not done**. Swings charges nothing; the buyback is disabled and has no executor |
| 13 | Token discovery verified | **Partial**: the real GeckoTerminal feed parses on all five chains; real Solana and EVM mints were enriched on-chain. Nothing has been written to a database |
| 14 | Risk classifications verified | **Partial**: checked against real ACT (Token-2022, mint authority revoked) and real USDC on Ethereum. That found and fixed two defects. Not checked against a broad sample of new tokens |
| 15 | Provider failover verified | **Partial**: unit-tested (timeouts, circuit breaker, explicit fallback offer); no live outage test |
| 16 | Error states verified | **Partial**: router and adapters tested; UI error states only partly exercised, and only without a connected wallet |
| 17 | No sensitive information logged | **Partial**: redaction tested for Swings code; the rest of the site was not reviewed |

## Test inventory
- Unit: quote executability, ranking, fee policy, token identity, adapters, providers, risk scoring, registry, discovery worker, parsers.
- Failure: expired quote, failed simulation, rejected signature, ambiguous failure (no retry), invalid token, decimal mismatch, hostile transaction shapes, provider outage, all providers down, circuit breaker, missing fee config.
- Property and fuzz (fast-check): fee never above rate or amount and monotonic, identity normalisation, amount round-trips, ranking order independence, slippage floor, hostile 0x responses, hostile discovery payloads, text cleaning, redaction.
- Concurrency: simultaneous execution of one quote reaches the wallet once.
- Not covered: UI behaviour with a connected wallet, real network integration, EVM wallet flows against a real wallet, database integration.

## Before any launch (in order)
1. Triage the dependency advisories.
2. Run a small real Solana swap through Swings; verify balances and the confirmation.
3. Apply the schema, set env vars, run discovery, and inspect real rows against a block explorer.
4. Resolve the Trade-tab 1% fee versus the 87 bps buyback, and review the buyback execution design.
5. For each EVM chain: key, verified contract list, wallet connection, fee config, a small real swap, then enable.
6. Add a SAST and secret scan to CI.
7. Commit, tag, and hand the tag to an external auditor (see `docs/audit/`).
