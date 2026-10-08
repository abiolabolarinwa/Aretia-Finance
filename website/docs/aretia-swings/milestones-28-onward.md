# Milestones 28 onward: completion reports

One report per milestone, written when the milestone is done and not before. "Done" means: tests, typecheck, lint and build all pass on the commit. Nothing here claims more than the tests and the checks show, and each report says what was NOT done.

State of 0 to 27 at the start (inspected, not assumed): the standalone engine (direct venues on eight chains, routing, split, simulation), the token registry and risk engine, indexers, the ACT buyback (Solana), the swap store, the Swings UI, protected sending, the quote API and the staged-rollout brake. Cross-chain existed only as interfaces (`crosschain/types.ts`) with nothing executable. Wallets existed as Solana host (`window.AretiaWallet`) and EIP-6963/EIP-1193 (`chains/evmWallet.ts`, `chains/evmSession.ts`).

---

## Milestone 28: Wallet integration foundation

**Status:** Done (abstraction, adapters, safety checks, provider list, tests). The Swings screen itself still uses `EvmSession` and the Solana host directly; moving it onto the manager is part of milestone 35, when the screen is next reworked. See "Known limitations".

**Implemented**
- One `WalletAdapter` interface (`src/swings/wallet/types.ts`): connect, restore (no prompt), disconnect, session, refresh, address, balance, sign transaction, sign message, send, switch network, change events.
- `WalletSession`: provider, address, all accounts, chain, network id, connection state, capabilities, signing capabilities, connected time, and a revision that changes whenever anything about the wallet changes.
- `SolanaContextWallet`: wraps the existing Aretia Wallet host. Every Solana Wallet Standard wallet (Phantom, Solflare, Backpack and others, and Ledger through those that support it) connects through the wallet page's own connect button; nothing was duplicated.
- `EvmBridgeWallet`: wraps the existing `EvmWalletAdapter`. Covers MetaMask, Coinbase Wallet, Rabby, Aretia Wallet (when it announces itself) and any EIP-1193 wallet, and Ledger through those. Listens to `accountsChanged` and `chainChanged`.
- Safety checks (`safety.ts`): `sessionProblems`, `transactionProblems`, `verifyBeforeExecute` (re-reads the wallet first), `ensureNetwork` (never switches without a confirmation callback returning true, then verifies the switch).
- Provider list (`providers.ts`): lists what is really present and says plainly what is not available.

**Files:** `src/swings/wallet/{types,solanaContextWallet,evmBridgeWallet,safety,providers}.ts`, `wallet.test.ts`.

**Interfaces added:** `WalletAdapter`, `WalletSession`, `WalletCapabilities`, `UnsignedTransaction`, `SignedTransaction`, `SolanaWalletHost`, `ExecutionExpectation`.

**Tests:** 29 for this milestone (fake wallets that change account, refuse, or return a swapped transaction).

**Security considerations**
- No key, seed phrase or signature is stored or exported by any of this code.
- A Solana wallet that returns a different transaction from the one asked for is refused.
- An EVM send is refused if the wallet's account or network changed since the transaction was built; nothing is sent in either case.
- Networks are never switched silently; a wallet that cannot switch says so.
- A wallet on a network Swings does not support has `chain: null` and is never treated as being on one.

**Known limitations**
- **WalletConnect is not built.** It is listed as unavailable with that reason. It needs the WalletConnect SDK and a project id.
- **Ledger** is supported only through wallets that connect to it (Phantom, MetaMask and others); there is no direct Ledger transport.
- Solana connection is by the wallet page's own connect button, because that is where the user already picks a wallet.
- The Swings UI is not yet switched over to the manager (see above).

**Next milestone:** 29.

---

## Milestone 29: Multiwallet session manager

**Status:** Done.

**Implemented**
- `WalletSessionManager` (`sessionManager.ts`): several wallets at once, each with its own session, never mixed; an active wallet; `walletFor(chain)` picks a wallet that can act on a chain (a Solana action never goes to an EVM wallet).
- Active account and chain are read from the active wallet's own session every time, never copied, so they cannot go stale.
- **Leases:** an action takes a lease (wallet, account, chain, session revision). `redeem` re-reads the wallet and refuses if anything changed in any way, even a change and change-back.
- Account-change and network-change detection (from the wallets' events and from re-reading before use).
- Reconnection: public information only is saved (provider ids and addresses); `restore()` reattaches with no prompt, and leaves a wallet disconnected if it is no longer authorised or is now on a different account.

**Files:** `src/swings/wallet/sessionManager.ts`, `sessionManager.test.ts`; `restore()` added to both adapters.

**Tests:** 13 for this milestone.

**Security considerations:** saved state contains no key, seed, signature or secret (a test checks the text); a changed account is never adopted silently, because the lease no longer matches; restoring never prompts.

**Known limitations:** persistence uses whatever `KeyValueStorage` is passed (the page will pass `localStorage`); a blocked or full storage is tolerated quietly and only costs the reconnection convenience.

**Next milestone:** 30.

## Milestones 30, 31 and 33: settlement domain, provider abstraction, quote engine

**Status:** complete (mock providers for tests only).
**Implemented:** `src/swings/settlement/types.ts` (intent, steps, route, quote, status, `SettlementProvider`), `engine.ts` (provider discovery, per-provider timeouts, quote validation that does not trust providers, risk gating, stated ranking), `testing.ts` (test double, imported by no production module, enforced by a test).
**Tests:** `engine.test.ts`, 11 tests including a property test on ranking. **Typecheck/Lint/Build:** pass.
**Security:** the engine rejects quotes that change the amount, pay out more than sent, are expired, lack a final destination-receive step, or name another provider. Declines carry reasons.
**Known limitations:** costs are never summed across assets; network fees are null unless a provider estimates them.

## Milestone 32: USDC settlement via Circle CCTP V2

**Status:** complete for EVM to EVM. Solana legs and BNB Chain are reported unsupported, with reasons, never offered.
**Implemented:** `src/swings/settlement/cctp.ts`: two providers (`circle-cctp-fast`, `circle-cctp-standard`). Support is decided per request from Aretia's domain table, Circle's live fee endpoint, and the chain's own burn limit. Exact-amount approval, `depositForBurn`, `receiveMessage`, tracking from Circle's attestation, completion only when the destination nonce is used, and no second mint.
**Tests:** `cctp.test.ts` (14, fake Circle and chain) and `cctp.live.ts` (3, real Circle and chains: standard offered from all six EVM chains, a real 100 USDC Ethereum to Base quote, BNB refused). **Typecheck/Lint/Build:** pass.
**Security:** nothing is signed or sent here; approvals are for exactly the amount; the claim never repeats a used message.
**Known limitations:** the Solana CCTP builders are not written; network fees are not estimated; no real burn has been signed on mainnet. The contract addresses were checked by live reads, not by a mainnet transfer.
**Next:** Milestone 34, the cross-chain execution orchestrator with a persisted state machine.

## Milestone 34: cross-chain execution orchestrator

**Status:** complete as a tested library. It is not yet wired into the Swings screen (that is Milestone 35), and records are kept in the browser, not in Aretia's database.
**Implemented:** `src/swings/orchestrator/`: `states.ts` (the 12 states, a checked transition table, bigint-safe save format), `store.ts` (in-memory and browser-storage stores with version-checked writes), `orchestrator.ts` (create, start, advance, claim, resolve-attention, record-refund), `walletGateway.ts` (signing through the wallet session manager with the account, network and destination checks). `SettlementProvider` gained `allowedDestinations(chain)`; a transaction calling any other address is refused, and a provider declaring none cannot be signed for.
**Rules enforced and tested:** no way out of a final state; COMPLETED only from the destination states and only on the provider's report that the destination has the value; a quote can expire only before anything is sent; a step is saved as `sending` before the wallet is asked, so a crash flags the step for the user instead of resending; an approval already sent is never sent again; a declined signature returns to QUOTED; two simultaneous runs and two-tab overwrites are refused; an unknown provider answer changes nothing.
**Tests:** 18 new (497 in total), including a property test on the transition table. **Typecheck/Lint/Build:** pass.
**Security considerations:** only public data is stored. Signing is refused unless the connected wallet is the account named in the quote.
**Known limitations:** Solana confirmation is not wired; there is no server-side copy of executions, so clearing the browser loses the record (the transactions themselves are on-chain and the execution id can be rebuilt from the burn hash); REFUNDED is reachable only through an explicit `recordRefund` with a transaction hash, since no provider reports refunds yet.
**Next milestone:** 35, the cross-chain Swing screen on top of this, and moving the Swings UI onto the wallet session manager.

## Milestone 35: cross-chain Swing experience

**Status:** built, typechecked and built into the site; not clicked through in a browser here (the preview browser refused localhost) and never run with a real wallet and real funds.
**Implemented:** a "Move USDC" tab in Swings (`src/scripts/walletCrossChain.ts`, wired in `walletSwings.ts` and `wallet/index.astro`): pick two EVM networks and an amount, see every quote with its fees listed separately, the steps, the trust statement and the risks, start the move, follow it, claim on the destination, resume after a reload, and resolve a step Aretia could not determine. All wording comes from `src/swings/crosschain/view.ts` (exact amounts, no floating point; a status says the funds arrived only when COMPLETED). It never switches network without a confirmation prompt. It honours the staged-rollout list and the operator's network switches.
**Tests:** `crosschain/view.test.ts` (8, with property test on amount formatting). **Typecheck/Lint/Build:** pass.
**Known limitations:** EVM to EVM only; BNB Chain and Solana are not offered; the claim step needs the user's gas on the destination.

## Milestone 36: settlement safety engine

**Status:** complete and wired into the Move USDC start button.
**Implemented:** `src/swings/settlement/safety.ts`: `assessSettlement` returns allow, confirm or block. It blocks on anything it cannot verify (no balance, no cap configured, no declared provider addresses), a network that is off, an invalid address, a recipient the user did not choose, an amount over the cap (`MOVE_CAP_RAW`, 250 USDC while proving), too little balance, a nearly-expired quote, a high-risk route, a fee above 1% and a duplicate in-flight move. It asks for acknowledgement when there is no gas to claim with, the recipient is another account on purpose, or the route is medium risk.
**Tests:** `safety.test.ts`, 7. **Typecheck/Lint/Build:** pass.

## Milestones 37 to 41: ramps (domain, first provider, routing, Buy, Sell)

**Status:** domain, provider, router and screen built and tested with fakes. **Never run against a real MoonPay account**: no keys are in the repo, and the sell widget is off until the operator turns it on.
**M37 domain** (`src/swings/ramp/types.ts`): `RampProvider`, `RampIntent`, `RampQuote`, `RampSession`, `RampOrderStatus`. Rules in the file header: a provider is offered only if configured and listing the token today; Aretia never holds fiat or crypto; no invented prices (a quote without a provider price says `priced: false`); verification is the provider's.
**M38 first provider** (`ramp/moonpay.ts`, plus `api/_ramp.ts`): MoonPay, reached only through Aretia's own `/api/ramp`, which holds the keys. The existing Solana buy backend was extended to USDC on Ethereum, Arbitrum, Base, Optimism, Polygon and Avalanche, using MoonPay's own currency codes and contract addresses read from its public list on 8 Oct 2026; the catalog now returns only tokens MoonPay lists as live, and per-country buy and sell. Checkout links are accepted only on MoonPay's own domains. Selling is behind `MOONPAY_SELL_ENABLED=1` (the sell widget's parameters are unverified).
**M39 routing** (`ramp/router.ts`): asks every provider, keeps reasons for declines, checks each quote, ranks priced above unpriced, then by provider id; a failing or hanging provider cannot block the others.
**M40 Buy / M41 Sell** (`src/scripts/walletRamp.ts`, "Buy & Sell" tab): country, currency, network, amount; options with disclosures; opens the provider's page; a purchase finishes only when the wallet balance rises (`ramp/watch.ts`); a sale shows only that the crypto left the wallet and says plainly that the payout is the provider's to confirm.
**Tests:** `ramp/ramp.test.ts` (13), `api/_ramp.test.ts` (8, including an independent check of the HMAC signing). **Typecheck/Lint/Build:** pass.
**Security considerations:** keys stay server-side; the secret never appears in a URL; only fixed token codes can be requested; wallet addresses are validated per network; the watch stores public data only.
**Known limitations:** no price is available from MoonPay without an authenticated quote call, so quotes are unpriced; orders cannot be followed, so completion is balance-based; Solana balance watching is not wired (the user is told to check the wallet); a Nigerian user cannot sell through MoonPay (provider restriction).

## Milestones 42 to 46: plans (ramp + settlement + swap), intents, unified quote, plan state machine, recovery

**Status:** complete as tested libraries. The planner, runner and recovery advice are not yet driven from a screen; the existing Move USDC and Buy & Sell tabs still work one step at a time.
**M42 ramp + settlement + swings** (`src/swings/plan/planner.ts`, `executors.ts`): `planRoutes` finds every ordered set of steps from where the money is to where it should be, using only what the capabilities say is possible now (a ramp that lists USDC for the country and currency, a settlement route, a swap route). USDC is the bridge. It returns the reasons when it finds nothing and never invents a step. Executors: `SettlementLegExecutor` (drives the milestone-34 orchestrator) and `BalanceLegExecutor` (for steps the user completes elsewhere: finishes only when the balance proves it).
**M43 intent layer** (`src/swings/intent/parse.ts`): a fixed grammar for buy, sell, swap and move. No AI. Same text, same answer; unknown text is refused with examples; missing fields are listed, not guessed; a symbol is never turned into an address; text inside the request is data and does nothing.
**M44 unified ExecutionQuote** (`plan/executionQuote.ts`): joins ramp, settlement and swap quotes. Legs must connect (asset, chain, no leg taking more than the one before delivers) or no quote is made. Fees stay per asset, never summed across assets; unknown stays unknown; the swap shows its worst case; expiry is the earliest, risk the worst.
**M45 execution state machine** (`plan/state.ts`, `runner.ts`, `store.ts`): PLANNED, RUNNING, WAITING_USER, COMPLETED, FAILED, CANCELLED, EXPIRED. Legs run strictly in order, once; a failed leg stops the plan; a plan cannot be cancelled or expire after a step begins; an executor that throws changes nothing; version-checked, bigint-safe storage.
**M46 recovery** (`plan/recovery.ts`): says where the funds are first; never suggests sending again when a send may have gone through; never uses the word lost; flags records that disagree; flags a ramp open for a day.
**Tests:** `plan/plan.test.ts` (18), `plan/runner.test.ts` (21), including property tests. **Typecheck/Lint/Build:** pass.
**Known limitations:** quotes for a whole plan must be fetched leg by leg by the caller (the planner gives shapes, not prices); the settlement executor needs the original settlement quote object, which is held in memory, so a plan resumed after a reload with an expired quote needs a fresh quote (reported as needs-requote); no screen yet drives a multi-step plan end to end.

## Milestone 47: ACT economic integration

**Status:** complete. **Rate discrepancy to resolve:** the milestone specification says 0.87%; the product runs the 0.55% (55 bps) the owner set, read from `core/fee.ts`. This work uses the configured rate and never copies a number: a test fails if any new module hard-codes one. Confirm which rate is intended; changing it is one line in `core/fee.ts`.
**Implemented:** `src/swings/economics/act.ts`. No second generic fee exists. The ACT allocation applies to a plan on at most ONE swap step (the first on a network where it is switched on and ready), so a multi-step plan does not charge the same money twice; ramps and settlements carry no Aretia charge. A blocked allocation (missing address) is reported, not silently zero. `disclose()` lists the amount, network fees, venue fees, settlement fees, provider (ramp) fees and the ACT allocation each on their own line and in their own asset. `assertAutomaticBuybackAllowed` refuses any unattended buyback unless `SWINGS_AUTOMATIC_BUYBACK=on` and an executor are set; nothing calls it, because today the allocation rides inside the user's own signed swap.
**Owner decision needed:** which step of a multi-step plan should carry the allocation (today: the first eligible swap), and whether a plan with no swap (only a ramp and a USDC move) should carry one (today: none).
**Tests:** `economics/act.test.ts` (8). 

## Milestone 48: execution intelligence

**Status:** complete, deterministic, no model. `src/swings/intelligence/insights.ts`: a cautious provider reliability score (lower confidence bound, so two successes are not trusted like two hundred; only the last 7 days count), a plain comparison of what choosing one route costs or saves in amount and time, and warnings for a single option, an outlier, a risky or slow route. It advises only; it never overrides the engines' checks or executes anything. **Tests:** `intelligence/insights.test.ts` (6, with property tests).

## Milestone 49: observability

**Status:** complete. `observability/execution.ts` records every settlement and plan state change exactly once (through store wrappers), failures with whether funds may be at risk, search outcomes with the providers' reasons, and recovery flags: ids and states only, never addresses, hashes, amounts or links. `redact` was strengthened: links lose their query string (checkout links carry the provider key and a signature), bearer tokens are removed, and payment and identity fields (card, cvv, iban, account number, passport, session, cookie, otp) are removed by name. A broken sink cannot break an execution. **Tests:** `observability/execution.test.ts` (8). Nothing is sent anywhere: the data stays in memory unless a reviewed server sink is added.
