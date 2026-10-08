# Audit package: Aretia Swings cross-chain, settlement, ramp and wallet layers

Prepared 8 October 2026 for an independent reviewer. **No external audit has been done.** This document is what a reviewer needs to start, and an honest account of what has and has not been checked. It is not a substitute for the review.

Repository: `abiolabolarinwa/Aretia-Finance`, directory `website/`. Review the commit you are given; the working tree at the time of writing was a few commits after `44de036` on branch `aretia-swings`, plus main.

## What the system is

A non-custodial web page (Astro, TypeScript strict). The user's own wallets sign every transaction; Aretia holds no keys and no funds. It (1) swaps tokens on one network, (2) moves native USDC between networks using Circle's CCTP V2 (EVM to EVM, and Solana to and from EVM), (3) buys and sells USDC through MoonPay, and (4) chains these into plans. Read `final-architecture-report.md` first, then `threat-model-cross-chain.md`.

## Suggested scope, highest risk first

| Priority | Area | Files (lines) | Why |
|---|---|---|---|
| 1 | Transaction construction for Circle on Solana | `src/swings/settlement/cctpSolana.ts` (308) | Hand-built instructions and PDA derivations; a wrong account or byte layout can burn USDC to an unclaimable place |
| 1 | Transaction construction for Circle on EVM, support decisions, tracking | `src/swings/settlement/cctp.ts` (420) | Calldata, the recipient encoding (a Solana recipient is a token account, not a wallet), when a route may be offered, when a move counts as complete |
| 1 | Signing gate | `src/swings/orchestrator/walletGateway.ts` (61), `src/swings/wallet/safety.ts` (100) | The last check before the wallet is asked: account, network, declared destinations |
| 1 | State machine and no-double-send logic | `src/swings/orchestrator/orchestrator.ts` (301), `states.ts` (103) | Crash and retry behaviour around real money |
| 2 | Wallet abstraction and leases | `src/swings/wallet/sessionManager.ts` (245), `evmBridgeWallet.ts` (230), `solanaContextWallet.ts` (221), `walletConnect.ts` (114) | Account and network changes between quote and signature |
| 2 | Server: ramp links and recovery copies | `api/_ramp.ts` (334), `api/_swingsRecords.ts` (128), `supabase/migrations/0005_swings_records.sql` | Secrets, URL signing, input validation, storage of user-related records |
| 2 | Safety engines and quote checks | `src/swings/settlement/engine.ts` (154), `safety.ts` (92), `src/swings/ramp/moonpay.ts` (132), `router.ts` (74) | Dishonest-provider handling; fail-closed behaviour |
| 3 | Plans | `src/swings/plan/` (runner 121, deferred 74, executors 118, state, recovery, executionQuote) | Multi-step logic; deferred pricing |
| 3 | Screens | `src/scripts/walletCrossChain.ts` (319), `walletPlan.ts` (326), `walletRamp.ts` (245), `crossChainRuntime.ts` (105) | What the user is told; DOM construction (no `innerHTML`) |
| 3 | Headers | `vercel.json` | A content security policy is enforced only in part (see below) |

Out of scope here, reviewed separately if at all: the earlier same-chain swap router and venue builders (`ARETIA_SWINGS_THREAT_MODEL.md`, `docs/audit/`), the discovery and indexing code, and third-party libraries.

## How to build and run the checks

```
cd website
npm ci
npm test                 # about 670 unit, property and end-to-end tests with deterministic stand-ins
npm run typecheck && npm run typecheck:api && npm run lint && npm run build
npm run test:live        # read-only checks against Circle's service and real chains/programs (needs internet)
npm run readiness        # prints the go/no-go checklist against the live site
```

## Evidence that exists

- **Solana burn:** `cctpSolana.live.ts` simulates `deposit_for_burn` from the account of a real USDC holder against the real program with signature checking off; the program logs the DepositForBurn instruction, returns no error, and uses 20k to 250k compute units.
- **Solana claim:** the same file rebuilds the claim from the message of real past claims on mainnet and checks that all 20 account keys, in order, and the instruction data are identical to the real transactions.
- **Derived accounts:** each PDA is matched to a real account owned by the real program; the burn limit, mint and fee recipient are read out of real accounts with the layouts the builders assume.
- **EVM:** burn limits are read from Circle's token minter on six chains; quotes against Circle's fee endpoint; calldata is built with Aretia's own ABI encoder (covered by tests against known selectors).
- **Program source:** addresses, seeds and layouts were taken from `circlefin/solana-cctp-contracts` (programs/v2) on 8 Oct 2026, not from memory.

## What has NOT been checked (please do not assume)

- **No real money has moved through any cross-chain, ramp or plan flow**, on mainnet or testnet. There is no testnet harness for them. The Solana claim has been compared with real claims but never itself executed.
- The MoonPay sell widget parameters are unverified; the sell flow is off unless an operator sets `MOONPAY_SELL_ENABLED=1`. No MoonPay keys have been used.
- Wallet behaviour with real wallets: some wallets rewrite Solana transactions (for example adding guard instructions), which the signing check would refuse; this has not been exercised.
- Browser behaviour of the new tabs has not been clicked through in a real browser by the author of this package.
- The content security policy is enforced only for `object-src`, `base-uri`, `frame-ancestors` and `form-action`. The full policy is reported (not enforced) and still allows inline scripts.
- Dependencies: 3 moderate advisories remain, all in `jayson` / `stream-json` inside `@solana/web3.js`, used only by that library's Node-side RPC server code, not by the browser client the page uses. They were reduced from 11 by dependency overrides; one override replaces `bigint-buffer` with the maintained fork `@trufflesuite/bigint-buffer`.

## Specific questions for the reviewer

1. In `buildDepositForBurn`, is anything signed by the throwaway message-event key that the user could be harmed by, and can the same key ever be reused? (It is generated per burn and never stored.)
2. Is claiming only into `ATA(recipientOwner, USDC)` (and refusing any message that names another account) the right invariant for Solana claims? What if the recipient closes their account between burn and claim?
3. Can a message from Circle's service for a different burn be substituted for the right one? (The EVM side trusts Circle's attestation; the Solana side additionally checks domain, program and amount.)
4. `maxFee` is taken from Circle's fee endpoint and the program enforces its own minimum. Is there a scenario where the cap is too high for the user?
5. The orchestrator marks a step `sending` before the wallet is asked, and treats any non-`SwingsError` failure as ambiguous (never retried). Is that classification sound for every wallet/RPC error shape?
6. `WalletExecutionGateway` re-checks account, network, and declared destinations immediately before signing. Is there a time-of-check/time-of-use gap with wallets that switch accounts during signing?
7. Recovery records (`/api/swings-records`): the 128-bit random id is the only access control. Is that acceptable given records contain two wallet addresses, amounts and hashes?
8. `api/_ramp.ts`: the signature covers exactly the query string sent. Any parameter-injection or open-redirect risk in `walletAddress`, `refundWalletAddress`, currency or amount fields?

## Known issues found and fixed during preparation (self-review)

- A claim into Solana originally assumed the burn named the recipient's wallet; the live comparison against real claims showed it names the USDC token account. Fixed, and the claim now refuses any message that does not pay the recipient's own standard USDC account.
- Unclear send failures (for example a network error while submitting a Solana transaction) used to reset the step to pending, which could allow a second burn. They now flag the step for the user and never retry.
- Execution and plan ids used a non-secure random source; they now use 128 bits from the platform's secure generator, since the id doubles as the recovery code.

## Contact and handover

The owner of this repository is the commissioning party. Findings are best returned as a list with severity, file and line, and a concrete failure scenario, in the same style as `ARETIA_SWINGS_AUDIT_READINESS.md`.
