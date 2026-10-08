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
