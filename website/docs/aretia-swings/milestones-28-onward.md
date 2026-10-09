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

## Milestone 50: security and threat model

**Status:** complete. `docs/aretia-swings/threat-model-cross-chain.md` lists what is protected, who must be trusted, 17 threats each with its defence and the test that proves it, and the residual risks that are not defended (a tampered page, a malicious extension, address poisoning, provider failure, public-node lies, the unverified sell flow, no server-side records, no audit, no real-money run). `src/swings/security.test.ts` (14 tests) tries to break the promises: the wallet gateway refuses empty declared addresses, another account, an unlisted contract, a transaction from another account or network, and a silent network switch; the ramp service never returns its secret, refuses disallowed origins, wrong content types and oversized bodies, and wrong-kind addresses or unlisted networks; static scans fail the build on dynamic code execution, raw HTML insertion, a secret named in the browser code, a host outside the list, or key material in saved records. The scan was checked by planting a violation (it failed as it should) and removing it.

## Milestone 51: end-to-end testing

**Status:** complete for deterministic CI. `src/swings/e2e.test.ts` (7 tests) runs real code from the typed request through the planner, the ramp router, the real Circle provider (with a fake Circle service and fake chain), the safety engine, the orchestrator, the plan runner, observability and recovery, with stand-ins only at the network, the wallet signature and the provider web services. Covered: a full buy, move, claim, swap journey that completes only when each step is proven; a burn that fails on the network; a closed tab resumed with nothing sent twice; Circle unreachable (no route offered, a tracked move stays "unknown"). A separate test proves no production module imports the test provider, so a fake provider cannot succeed in production.
**Not done:** testnet integration runs. The integration checks are read-only against mainnet (`npm run test:live`); there is no testnet harness for the cross-chain flows, and no real-money run.

## Milestone 52: production readiness

**Status:** complete as a runnable check; the verdict is still **not ready**. `npm run readiness` (`scripts/readiness.ts`, `src/swings/readiness.ts`) reads the live status endpoint and `docs/aretia-swings/readiness-attestations.json` and prints each gate; manual gates (real swaps, a real CCTP move, a MoonPay sandbox buy, database migrations, an audit, a content security policy, an incident plan) count as not done until someone records them with a date. Run on 8 October 2026 against the live site it reported: first group NO (7 gates open), public NO (12 open). It also showed that all seven EVM networks are on in production and outside aggregators are still on; `production-readiness.md` has the update and the quick switch-off steps. **Tests:** `readiness.test.ts` (7).

## Milestone 53: architecture report

**Status:** complete. `docs/aretia-swings/final-architecture-report.md` is rewritten for the current system: layers, what each layer promises and which test proves it, a chain-by-chain table of what is really available, the security model, the economics and the two open owner decisions, persistence, operations, a plain list of what is not done, and the extension points.

## Overall

Milestones 28 to 53 are implemented as tested code and documents. Final gate on 8 October 2026: 622 tests in 48 files pass; typecheck, API typecheck, lint and build pass. Nothing here has moved real money. The things that stand between this and a first real use are listed in `production-readiness.md` and are mostly yours to do: apply the database migrations, run the small real tests, supply MoonPay sandbox keys, decide the two economics questions, and commission a review.

## Follow-up work after milestone 53 (8 October 2026)

Items from the "still not done" list:

- **Solana CCTP: done as code, not executed.** `settlement/cctpSolana.ts` builds the burn and the claim from Circle's published program source. `cctpSolana.live.ts` checks it against mainnet: derived accounts match real accounts; the burn is simulated on the real program from a real USDC holder and succeeds; the claim, rebuilt from the messages of real past claims, has identical accounts (20, in order) and identical instruction data. That check also found and fixed a wrong assumption (a Solana burn names the recipient's USDC token account, not the wallet). The provider offers Solana to and from the six EVM networks when given the Solana tools, and the Move USDC tab now includes Solana. No Solana move has been executed with real funds.
- **WalletConnect: built, off until a project id is set** (`PUBLIC_WALLETCONNECT_PROJECT_ID`, see `setup.md`). Loaded only on use; saved sessions reconnect without a prompt; every existing safety check applies. Tested with a fake provider only.
- **A screen that runs a multi-step plan end to end: done** (Plan tab): buy USDC on one network with a bank or card and have it end up on another. The move step is priced and safety-checked when the money has arrived (`plan/deferred.ts`). EVM networks only; swap steps are not in the screen.
- **Server-side storage of executions: done as opt-in recovery copies** (migration `0005_swings_records.sql`, `/api/swings-records`, recovery code and restore in Move USDC). The migration is not applied to Aretia's database yet.
- **Content security policy: partly done.** `object-src`, `base-uri`, `frame-ancestors` and `form-action` are enforced; the full policy is sent as report-only because it still needs inline scripts and could not be tested in a browser here. An enforced full policy needs script nonces or hashes.
- **External audit: cannot be done by me.** `audit-package.md` gives a reviewer the scope, the evidence, the gaps and specific questions. Preparing it, a self-review fixed two real problems: an unclear send failure used to reset the step (which could allow a second burn) and now flags it instead; and record ids now come from the secure random generator since the id doubles as the recovery code.
- **Dependency advisories: 11 down to 3** (moderate, in a library's Node-only server code) by overrides, including replacing `bigint-buffer` with a maintained fork.

## Follow-up: pump.fun bonding curve (Solana)

Tokens that have not yet filled their pump.fun curve now have a direct venue, `pump-curve` (`src/swings/solana/pumpCurve.ts`). The curve account is derived from the mint, parsed against the program's published IDL, and swapped with `buy_exact_sol_in` and `sell`; the program itself prices the swap by simulation from the user's account. Proven live by simulation only (`pumpCurve.live.ts`): a real open curve accepts the Aretia-built buy, a buy and sell in one transaction, and the router quotes and builds a curve swap. Nothing was signed or sent.

Stated limits: SOL-priced curves only; completed curves are served by PumpSwap; the program needs two accounts after the ones its IDL lists (`bonding_curve_v2`, the buyback fee recipient), found by simulation, so a program change shows up as "route not offered", not as a wrong swap.

Other launchpads seen as separate venues on GeckoTerminal's Solana list, not yet integrated: Raydium LaunchLab (letsbonk-fun), Meteora Dynamic Bonding Curve, Moonshot, Boop, Bags, Moonit, StonkFun, Virtuals (Solana). On other networks: Four.meme and Flap (BNB Chain), Virtuals (Base), Arena (Avalanche); their contracts have not been studied or proven here.

## Follow-up: Four.meme launchpad (BNB Chain)

Tokens still on a Four.meme curve now have a direct venue, `fourmeme-bnb` (`src/swings/dex/evmFourMeme.ts`). The launchpad's own helper contract (`getTokenInfo`, `tryBuy`, `trySell`) is the quoter, and its token manager is the counterparty: `buyTokenAMAP` for buys and the floor-carrying form of `sellToken` for sells. The contract enforces the floor itself. Proven live by simulation only (`fourMeme.live.ts`): the router quotes a BNB buy on a real open curve, builds a transaction the real contract accepts, a sell is accepted with a simulated balance and approval, and both refuse an impossible floor. Nothing was signed or sent.

Stated limits: BNB-priced curves of the current token manager only; swaps against native BNB only (not token-to-token); older managers and curves priced in other coins are not offered; a graduated token is served by PancakeSwap. The sell-side simulation uses state overrides on the public node and assumes the token's balance and allowance mappings sit at slots 0 and 1 (checked for the tokens tested).

## Follow-up: Raydium LaunchLab and Meteora Dynamic Bonding Curve (Solana)

Two more Solana launchpad venues, each proven live by simulation only (nothing signed or sent): a real open pool accepts the Aretia-built buy, a buy and sell in one transaction, and the router quotes and builds a swap.

- `raydium-launchlab` (`raydiumLaunchlab.ts`): pools derived from the mint and a quote token (SOL or USDC); `buy_exact_in` / `sell_exact_in`. The live program needs three accounts after the ones its IDL lists (the system program, then the platform and creator fee vaults), found by simulation.
- `meteora-dbc` (`meteoraDbc.ts`): a DBC pool cannot be derived from the pair, so candidate pool addresses come from DexScreener and every one is verified on-chain (owner program, the token's own mint, the config's quote token) before use; `swap2` in exact-in mode. This also covers Bags, which launches on DBC.

Stated limits: curves still trading only; DBC tokens with a transfer hook are not covered; the DBC venue needs DexScreener to answer. Not built: Moonshot, Boop, Moonit (no public program definitions were available to prove against), and on other chains Flap (BNB Chain), Virtuals (Base), Arena (Avalanche).
