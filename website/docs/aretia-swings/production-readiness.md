# Production readiness

## Update, 8 October 2026 (Milestone 52)

**Verdict: still not production ready. Ready, in code, for a named first group once the first-use tests below are done.**

What changed since the milestone-25 checklist further down: wallet abstraction and session manager, Circle CCTP USDC settlement, a persisted cross-chain orchestrator, ramps (MoonPay), plans, an intent parser, a unified quote, recovery, ACT economics across plans, observability and a security test suite. Current gate: **622 tests in 48 files pass, typecheck 0 errors, API typecheck clean, lint clean, build passes.** Read-only live checks exist (`npm run test:live`) and need public nodes and Circle's service. `npm audit --omit=dev` still reports 11 advisories (7 moderate, 4 high), all in the existing wallet dependencies and unchanged.

**Run the check yourself.** `npm run readiness` reads the live `/api/swings-status` and the attestation file `docs/aretia-swings/readiness-attestations.json`, and prints each gate as PASS, FAIL or UNKNOWN. A gate that only a person can do (a real swap, a real CCTP move, a MoonPay sandbox buy, applying the database migrations, an audit) counts as not done until someone records it there with a date. Nothing is ready by default. On the day of writing it reported: first group NO (7 gates open), public NO (12 gates open).

### What is true today (nothing here is a promise)

| Area | State |
|---|---|
| Real money moved through any Swings flow | **Never.** No swap, no CCTP move and no ramp order has been signed or paid on mainnet |
| Same-chain swaps | Built on Solana and seven EVM networks; simulated against real programs; not signed |
| USDC settlement (CCTP) | Quotes, limits and support checks proven against Circle and the real chains read-only; EVM to EVM only; Solana and BNB Chain not offered |
| Cross-chain orchestration | Tested with fakes at the edges only; never run with a real wallet |
| Ramps | MoonPay link building and signing tested; never run with real or sandbox keys; sell is off by default and unverified |
| Live site | EVM networks are all on by default (set `SWINGS_EVM_CHAINS=base` to narrow); only the two wallets on the staged-rollout list can sign |
| ACT buyback | On for Solana at 0.55%; EVM off; never exercised with a real swap |
| Database | Migrations validated on a local Postgres engine; not applied to Aretia's project |
| External review | None |

### Gates for a named first group (small amounts, listed wallets)
1. Staged-rollout list set (done) and EVM networks narrowed to one proven network.
2. A real small Solana swap and a real small Base swap, signed and confirmed (`real-swap-runbook.md`).
3. A real small CCTP move, burn to claim.
4. A MoonPay sandbox buy delivered to a test wallet.
5. Database migrations applied.

### Additional gates for the public
Sell checked in the sandbox; a real fast-transfer move; an independent review of the wallet, settlement, orchestrator and ramp code; a content security policy with subresource integrity; a named incident owner and a written plan, including how to switch everything off (`SWINGS_EVM_CHAINS=none`, `RAMP_ENABLED` unset, `SWINGS_CANARY_WALLETS` set to an address nobody holds).

### How to switch things off quickly
Set the variable in Vercel and redeploy: `SWINGS_EVM_CHAINS=none` turns every EVM network off; `SWINGS_CANARY_WALLETS` to an address nobody holds stops everyone signing; removing `RAMP_ENABLED` turns off buying and selling; `MOONPAY_SELL_ENABLED` unset turns off selling. The code cannot be rolled back by a setting, so keep the previous deployment available.

---

# Milestone 25 checklist (historical; figures below are from that date)

## Verdict: NOT production ready

The standalone engine is wired into the screen and has direct paths on all five chains, with Solana routing (direct, two-hop, atomic split) within 0.15% of Jupiter on the pairs tested. But it has not signed a single real swap, the ACT buyback has never been enabled, and the database schema has never been applied to Aretia's project. See `ARETIA_SWINGS_AUDIT_READINESS.md`.

Aretia Swings must not be described as live or production-ready. Critical checks below have not been done, and most of them need things only the owner can supply (keys, funds, a database, EVM addresses).

## Checklist (Milestone 25)

| # | Check | Result |
|---|---|---|
| 1 | Complete test suite | **Pass** (at that date): 261 tests in 15 files, plus about 50 read-only live checks (`npm run test:live`; it depends on public nodes and can fail on their rate limits) |
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
4. Resolve the Trade-tab 1% fee versus the 55 bps buyback, and review the buyback execution design.
5. For each EVM chain: key, verified contract list, wallet connection, fee config, a small real swap, then enable.
6. Add a SAST and secret scan to CI.
7. Commit, tag, and hand the tag to an external auditor (see `docs/audit/`).
