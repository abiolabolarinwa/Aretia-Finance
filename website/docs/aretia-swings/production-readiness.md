# Production readiness

## Update, 10 October 2026: the first real swap

**Verdict unchanged: not production ready.** One real swap now exists, and it is the only one.

- **What happened:** 0.0248417 BNB swapped to ARK on BNB Chain through PancakeSwap (BNB to BSC-USD to ARK), signed from a MetaMask account that batched everything into one transaction (type 4). Status success, block 126877670, hash `0xfca75f506bd227fbcbb6ca5d7701abf9caa4034332ebeacfb5a5ecdf9b48fcf7`. The status and block were read back from a BNB Chain node, not only from the explorer page.
- **The fee:** 0.00007204093 BNB went to `0xeB8725E16e504036c2166aa47804D88Ecc4D0945` in that transaction. That is exactly 0.29% of the 0.0248417 BNB entered, and it is the address the live site's bundle carries as the EVM fee address (`PUBLIC_ARETIA_EVM_FEE_ADDRESS`).
- **Gates recorded:** `real-swap-evm` and `aretia-fee-evm` in `readiness-attestations.json`, with the date, the hash and these limits. The `real-swap-evm` gate no longer says "(Base)": the first proof was BNB Chain.
- **Still not proven:** any Solana swap and the Solana fee wallet (`2tcBrd1J…`), Base and every other EVM network, selling a token (a token sale needs an approval and takes the fee in that token), a wallet that cannot batch (fee and swap as separate transactions), CCTP, ramps, the database, the external review.
- **Also found that day:** publicnode answered HTTP 403 for the receipt of a transaction it had not seen yet (BNB Chain, Base, Arbitrum, Optimism), which the page read as a failed swap. Fixed: receipts fall back to the wallet's own node, and public reads try a backup node. Test with a wallet that cannot batch before relying on it.

## Update, 8 October 2026 (Milestone 52)

**Verdict: still not production ready. Ready, in code, for a named first group once the first-use tests below are done.**

What changed since the milestone-25 checklist further down: wallet abstraction and session manager, Circle CCTP USDC settlement, a persisted cross-chain orchestrator, ramps (MoonPay), plans, an intent parser, a unified quote, recovery, ACT economics across plans, observability and a security test suite. Current gate: **622 tests in 48 files pass, typecheck 0 errors, API typecheck clean, lint clean, build passes.** Read-only live checks exist (`npm run test:live`) and need public nodes and Circle's service. `npm audit --omit=dev` still reports 11 advisories (7 moderate, 4 high), all in the existing wallet dependencies and unchanged.

**Run the check yourself.** `npm run readiness` reads the live `/api/swings-status` and the attestation file `docs/aretia-swings/readiness-attestations.json`, and prints each gate as PASS, FAIL or UNKNOWN. A gate that only a person can do (a real swap, a real CCTP move, a MoonPay sandbox buy, applying the database migrations, an audit) counts as not done until someone records it there with a date. Nothing is ready by default. On the day of writing it reported: first group NO (7 gates open), public NO (12 gates open).

### What is true today (nothing here is a promise)

| Area | State |
|---|---|
| Real money moved through any Swings flow | **One swap, on BNB Chain (10 October 2026).** No other swap, no CCTP move and no ramp order has been signed or paid on mainnet |
| Same-chain swaps | Built on Solana and eight EVM networks; simulated against real programs; signed once, on BNB Chain; nowhere else |
| USDC settlement (CCTP) | Quotes, limits and support checks proven against Circle and the real chains read-only; EVM to EVM and Solana to and from EVM; BNB Chain not offered. The Solana burn is proven by simulation on the real program and the Solana claim by identity with real past claims, but neither has been executed |
| Cross-chain orchestration | Tested with fakes at the edges only; never run with a real wallet |
| Ramps | MoonPay link building and signing tested; never run with real or sandbox keys; sell is off by default and unverified |
| Live site | EVM networks are all on by default (set `SWINGS_EVM_CHAINS=base` to narrow); only the two wallets on the staged-rollout list can sign |
| Aretia fee | 0.29% on every network, paid in the asset sold; the ACT buyback was removed; EVM needs `PUBLIC_ARETIA_EVM_FEE_ADDRESS` (set in production); collected once on a real BNB Chain swap, exactly 0.29%; never collected on Solana or any other EVM network |
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

The standalone engine is wired into the screen and has direct paths on all five chains, with Solana routing (direct, two-hop, atomic split) within 0.15% of Jupiter on the pairs tested. But it has not signed a single real swap, the Aretia fee has never been collected from a real swap, and the database schema has never been applied to Aretia's project. See `ARETIA_SWINGS_AUDIT_READINESS.md`.

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
| 12 | Fee accounting verified | **Not done**. The 0.29% fee is built and simulated on the real programs; no real fee has been collected |
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
4. Decide whether the Trade tab's 1% fee stays beside Swings' 0.29% fee, and set the EVM fee address.
5. For each EVM chain: key, verified contract list, wallet connection, fee config, a small real swap, then enable.
6. Add a SAST and secret scan to CI.
7. Commit, tag, and hand the tag to an external auditor (see `docs/audit/`).
