# Threat model: wallet, settlement, ramps and plans (milestones 28 to 49)

This extends `ARETIA_SWINGS_THREAT_MODEL.md` (same-chain swaps) to the cross-chain, USDC settlement, buy/sell and plan layers. It says what is protected, who might attack, where trust sits, what each defence is, which test proves it, and what is **not** defended. It has had no external review.

## What is protected

1. The user's funds and keys. Aretia holds neither: wallets sign, providers move value.
2. The right destination: funds go to the account the user chose, on the network they chose.
3. The truth of the screen: a status never claims funds arrived before they did.
4. Provider secrets (MoonPay keys), which live only on the server.
5. Privacy: no addresses, hashes, amounts, links or payment details in logs.

## Trust boundaries (who must be trusted)

| Party | Trusted for | If it fails or lies |
|---|---|---|
| The user's wallet | Showing and signing what is asked | Aretia cannot see what it shows; the user must read it |
| Circle (CCTP) | Honest attestations; USDC itself | Circle can blacklist addresses and pause contracts. A false "complete" from its API makes a claim revert; it cannot mint without a valid attestation, which the on-chain contract checks |
| MoonPay | Taking payment, identity checks, delivering crypto | Aretia cannot see or reverse an order; completion is judged from the wallet balance |
| Public RPC nodes | Balances, receipts | A lying node can show a wrong balance or receipt; checks that use them fail toward "pending" or "unreadable", not "done", and signing re-reads the wallet |
| Aretia's own page | Not being tampered with | See residual risks |
| Vercel / hosting | Serving the real page and keeping secrets | Out of Aretia's control |

## Threats and defences

| # | Threat | Defence | Proven by |
|---|---|---|---|
| 1 | A provider returns a dishonest quote (pays out more, wrong amount, expired, ends before the destination) | The engine re-checks every quote itself and drops bad ones with the reason | `settlement/engine.test.ts` |
| 2 | Funds sent to the wrong account | The gateway signs only for the account named in the quote; a different recipient is blocked unless chosen on purpose and acknowledged | `security.test.ts`, `settlement/safety.test.ts` |
| 3 | A transaction that calls an unexpected contract | Each provider declares the only addresses its transactions may call (from Aretia's own table, never the quote); anything else is refused; a provider declaring none cannot be signed for | `security.test.ts`, `cctp.test.ts` |
| 4 | Wrong network, or a silent network switch | Switching needs a yes from the user and is verified afterwards | `security.test.ts` |
| 5 | Double send after a crash or reload | A step is saved as "sending" before the wallet is asked; on resume it is flagged for the user, never retried; an approved allowance is not re-sent | `orchestrator/orchestrator.test.ts` |
| 6 | Double claim / double mint | The claim is built only if the destination has not used the message; one claim in flight at a time | `cctp.test.ts`, `orchestrator.test.ts` |
| 7 | "Complete" shown too early | Completion needs the provider's report that the destination has the value; a ramp buy needs a balance rise; status text is tested for every state | `crosschain/view.test.ts`, `ramp.test.ts` |
| 8 | Two tabs corrupt a record | Version-checked writes; one run per record at a time | `orchestrator.test.ts`, `plan/runner.test.ts` |
| 9 | A checkout link to a look-alike site | Only `https` links on MoonPay's own hosts are accepted | `ramp/ramp.test.ts` |
| 10 | Secrets leak to the browser or logs | Secrets are read only in `api/`; no cross-chain, ramp or plan file in `src` names them; links lose their query string in logs; card, bank, identity and token fields are removed by name | `security.test.ts`, `observability/execution.test.ts` |
| 11 | Hidden instructions in typed requests | The intent grammar is fixed and treats text as data; unknown text is refused | `plan/plan.test.ts` |
| 12 | A request for a token that merely shares a name | A symbol is never turned into an address; the user picks the exact token | `plan/plan.test.ts` |
| 13 | Abuse of the ramp endpoint | Origin allow-list, JSON only, size cap, rate limit, fixed token table, per-network address checks | `api/_ramp.test.ts`, `security.test.ts` |
| 14 | Oversized or runaway moves | A per-move cap, a fee ceiling, balance and gas checks, duplicate detection; anything that cannot be verified blocks | `settlement/safety.test.ts` |
| 15 | Same money charged the ACT allocation twice in a plan | At most one step carries it | `economics/act.test.ts` |
| 16 | Unattended buyback | Refused unless production configuration enables it; nothing calls it today | `economics/act.test.ts` |
| 17 | Dynamic code, raw HTML, unlisted hosts in new code | Static scans fail the build | `security.test.ts` |

## Residual risks (not defended, or only partly)

- **A tampered page.** Aretia is a non-custodial web page. If the page or its hosting is compromised, an attacker can change what is shown and what is built. The wallet's own confirmation screen is the last line of defence. There is no subresource pinning or signed-release check yet.
- **A malicious browser extension or compromised wallet** can alter what the user sees or approves.
- **Browser storage is not secret.** Records hold public data only, but a script running on the page (cross-site scripting) could change them. Signing re-reads the wallet and re-checks the account, network and destination, so a changed record cannot widen what is signed, but it could cause a refusal or a misleading screen.
- **Address poisoning and clipboard attacks** on addresses the user pastes: Aretia shows the destination, but cannot know it is the user's.
- **Provider insolvency or shutdown** (Circle, MoonPay): outside Aretia's control.
- **Public RPC availability**: reads can fail; Aretia then says "unreadable" and does nothing. Receipts from a lying node could mislead a confirmation step; the chain's own contract still enforces the real result.
- **Ramp price and order status are unknown to Aretia.** It cannot warn about a bad rate or follow an order.
- **The sell flow is unverified** against a real MoonPay account and is off unless the operator turns it on.
- **No server-side copy of executions.** Clearing the browser loses the local record; the transactions remain on-chain.
- **No external audit, no formal verification, and no real-funds mainnet run** of any cross-chain flow has been done.

## Before turning cross-chain on for the public

1. Run every flow with a small amount on a test wallet that is on the staged-rollout list (`real-swap-runbook.md`).
2. Test MoonPay with sandbox keys, buy first; turn sell on only after its widget has been checked.
3. Add a content security policy and subresource integrity for the page.
4. Get an independent review of `settlement/cctp.ts`, `orchestrator/`, `wallet/` and `api/_ramp.ts`.
