# ARETIA SWINGS: ARCHITECTURE REPORT (Milestone 53)

Written 8 October 2026, after milestones 28 to 52. It describes what exists, what each part is allowed to trust, what has been proven and how, and what is not done. Where a sentence says "built" it means written and tested with stand-ins; where it says "proven" it names the evidence. **No real money has been moved through any Swings flow.** See `production-readiness.md`.

## 1. What Swings is

An Aretia-owned layer inside the Aretia web wallet (an Astro site in `website/`) that finds routes, builds transactions and tracks them, for four jobs: swap on one network, move USDC between networks, buy or sell USDC with a bank or card, and chain those into a plan. The user's wallet signs everything. Aretia holds no keys and no funds. Providers move value; Aretia never custodies it.

## 2. Layers

```
Screens (src/scripts/): walletSwings (Swap, New Tokens, Markets, Activity), walletCrossChain (Move USDC), walletRamp (Buy & Sell)
   |
Plans         intent/parse   plan/planner   plan/executionQuote   plan/runner + state   plan/recovery   economics/act   intelligence/insights
   |
Engines       router (same-chain)    settlement/engine + safety    ramp/router         orchestrator (one cross-chain move, persisted)
   |
Providers     DexProvider: Aretia direct venues (Solana venues + EVM V2/V3), Jupiter, 0x
              SettlementProvider: Circle CCTP V2 (fast, standard)
              RampProvider: MoonPay (through /api/ramp)
   |
Edges         wallet/ (WalletAdapter, SolanaContextWallet, EvmBridgeWallet, WalletSessionManager, safety)   chains/ (EVM session, public RPC)   api/ (server)
Cross-cutting core/ (types, fee)   observability/   store/ + indexer/ (Aretia's own swap history)   db/ + supabase/migrations   readiness
```

Every provider sits behind an Aretia interface; nothing above the providers names Circle, MoonPay, Jupiter or 0x. Swings is not built around any one of them.

## 3. What each layer promises (and where the test is)

| Layer | Promise | Evidence |
|---|---|---|
| Wallet | One adapter shape for Solana and EVM wallets; a session manager that pins an action to the wallet, account and network it was prepared for (leases); network changes only with a yes and verified after | `wallet/wallet.test.ts`, `sessionManager.test.ts`, `security.test.ts` |
| Settlement domain and engine | A route is reported only if it can be executed now; every quote is re-checked (amount, expiry, limits, ends with the destination receiving); declines carry reasons | `settlement/engine.test.ts` |
| Circle CCTP | Support is decided from Aretia's tables, Circle's live fee service and the chain's own burn limit; exact approvals; completion only when the destination has used the message; no double mint | `cctp.test.ts`; `cctp.live.ts` against Circle and six chains, read-only |
| Settlement safety | Fails closed: anything it cannot verify blocks | `settlement/safety.test.ts` |
| Orchestrator | 12-state machine, nothing leaves a final state; a step is saved as "sending" before the wallet is asked, so a crash flags the step and never resends; two tabs cannot overwrite each other | `orchestrator/orchestrator.test.ts` |
| Ramps | Offered only if configured and the provider lists the token for the country today; unpriced quotes say so; a buy is done only when the balance rises; checkout links only on the provider's own domains | `ramp/ramp.test.ts`, `api/_ramp.test.ts` |
| Plans | Legs must connect or no quote is made; fees stay per asset; unknown stays unknown; strictly ordered legs; a failed leg stops the plan | `plan/*.test.ts`, `e2e.test.ts` |
| Intent | A fixed grammar, no AI; unknown text refused; missing fields listed; text is data | `plan/plan.test.ts` |
| Economics | One ACT allocation per plan at most; no second generic fee; every cost on its own line | `economics/act.test.ts` |
| Observability | Ids and states only; links lose their query strings; payment and identity fields removed | `observability/*.test.ts` |
| Whole system | Deterministic end-to-end journeys with fakes at the edges only | `e2e.test.ts` |

## 4. Chains and what is actually available

| | Swap | Move USDC (CCTP) | Buy / sell USDC (MoonPay) |
|---|---|---|---|
| Solana | Built (direct venues, multi-hop, split); simulated against real programs | **Not offered** (builders not written) | Buy and sell listed by MoonPay; Solana balance watching not wired |
| Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche | Built (V2/V3 venues); simulated | Offered EVM to EVM; fast transfer from Ethereum, Optimism, Arbitrum, Base | Buy on all six; sell on Ethereum, Arbitrum, Base, Polygon (MoonPay lists no sell on Optimism or Avalanche) |
| BNB Chain | Built | **Not offered** (Circle does not support USDC there) | Not offered |

## 5. Security model

See `threat-model-cross-chain.md` (this layer) and `ARETIA_SWINGS_THREAT_MODEL.md` (same-chain). The structural choices: non-custodial; every provider answer treated as untrusted and re-checked; signing allowed only for the account named in the quote and only to addresses the provider declared from Aretia's own table; fail-closed safety checks; secrets only on the server; a staged-rollout list and per-network switches the operator controls without a deploy. The largest unaddressed risk is a tampered page (no content security policy or subresource integrity yet) and the absence of any external review.

## 6. Economics

Policy is in one file (`core/fee.ts`): 0.55% (55 bps) of qualifying swap value is used to buy ACT; no other Aretia fee exists. The milestone specification said 0.87%; the product runs the 0.55% the owner set and the new code reads that value rather than copying a number. **Open for the owner:** confirm 0.55% versus 0.87%; and which step of a multi-step plan carries the allocation (today the first eligible swap; ramps and settlements carry none). The allocation is Solana-only today; EVM stays off until addresses and ACT liquidity exist. No unattended buyback can run: it is refused unless production configuration enables it, and nothing calls it.

## 7. Data and persistence

Browser: executions, plans, ramp watches and wallet reconnection hints, public data only, version-checked. Server: `/api/ramp` (stateless), `/api/swings-*` (quotes, status, tokens, events), optional Supabase tables (token registry, cursors, swaps) through repositories; migrations 0001 to 0004 are validated on a local Postgres engine and **not applied** to Aretia's project. Aretia's own swap history (read from pool vault balance changes) and candles are built and proven against real pools, but not yet stored server-side.

## 8. Operations

Operator controls (Vercel environment variables): `SWINGS_EVM_CHAINS`, `SWINGS_CANARY_WALLETS`, `SWINGS_AGGREGATORS`, `SWINGS_PROTECTED_SUBMIT`, `RAMP_ENABLED`, `MOONPAY_*`, `MOONPAY_SELL_ENABLED`, `SWINGS_AUTOMATIC_BUYBACK`. `npm run readiness` prints the go/no-go checklist from the live site and a signed-off attestation file. Telemetry is in memory unless an operator adds a reviewed sink.

## 9. Not done, stated plainly

- No real swap, CCTP move or ramp order has been executed; no sandbox ramp run; sell flow unverified.
- Solana CCTP builders; WalletConnect (listed as unavailable); Solana confirmation inside the orchestrator gateway; Solana balance watching for ramps.
- A screen that drives a multi-step plan end to end (the pieces exist and are tested; the Move USDC and Buy & Sell tabs are separate).
- Server-side storage of executions and plans; Aretia-owned candles served from stored swaps; EVM swap-log indexing.
- Raydium AMM v4 and CLMM, Manifest, Uniswap V4 routing.
- Content security policy, subresource integrity, external audit, dependency advisories (11).
- Testnet integration runs: integration checks are read-only against mainnet; no testnet harness exists.

## 10. Extension points

New settlement route (a bridge, a liquidity network): implement `SettlementProvider` (support check with reasons, quote, build, track, `allowedDestinations`) and add it to the list; the engine, safety checks, orchestrator and screen do not change. New ramp: implement `RampProvider`. New DEX: implement `DexProvider`. Universal, Pay, Shield, SafeSend, limit orders, DCA and institutional features are not implemented; the plan layer (legs, executors, recovery) is where they would attach.
