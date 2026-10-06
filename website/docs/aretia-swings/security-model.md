# Security model and review

This is a design-level review written by the people who built the code, not an independent audit. "Mitigated" means a control exists in code and a test exercises it. It does not mean the control is proven against a determined attacker. Nothing here has been externally reviewed.

## Principles
- Keys never enter Aretia code. Signing happens in the user's own wallet. For Solana the page checks the wallet returned the exact transaction it was shown (`signAndSubmitSwap`).
- Everything a provider, indexer or token list says is untrusted data until checked.
- A quote is bound to a request, an expiry, and the tokens asked for. A swap needs an explicit confirmation naming that quote and executes at most once.
- No automatic broadcast retry. A resubmission needs a new user action.
- Aretia's economics live in one config (`core/fee.ts`), capped, shown before signing, and fail closed when incomplete.

## Review against the Milestone 18 list

| Risk | Control | Status |
|---|---|---|
| Transaction manipulation (Solana) | Simulated on the RPC with the wallet's balances watched; `judgeSwapSimulation` blocks over-spend, extra SOL use, reduced other balances, output below minimum; signer count checked; wallet-returned message compared to the built one | Mitigated (unit-tested; not exercised on a live swap through the new router) |
| Transaction manipulation (EVM) | Swap target and approval spender must be on a per-chain allow-list that ships empty; native value must equal the amount only when selling native; `eth_call` simulation when no approval is needed | Mitigated in code. Allow-list is empty, so EVM is blocked until the owner fills it |
| Malicious token contracts | Risk engine flags mint/freeze authority, Token-2022 extensions, EVM mint/blacklist/pause/proxy via bytecode selectors | Partial. Bytecode checks follow proxies to their implementation; obfuscated code can still be missed. Tax data comes from 0x when it reports it (sell tax 50% or more blocks the swap) and is otherwise reported as unavailable. Transfer restrictions are not detected |
| Quote manipulation | Strict response parsing (`parseZeroXQuote`, fuzz-tested); router rejects quotes that are inconsistent, for other tokens or amounts, or allow more slippage than chosen | Mitigated |
| Stale quotes | `expiresAt` checked at search, build and execute; UI countdown disables signing at expiry | Mitigated |
| Slippage attacks | Minimum must honour the chosen slippage; slippage capped at 50%; never raised silently; defaults are visible | Mitigated |
| Approval risks | Exact-amount approvals only (`encodeApprove` refuses 2^256); spender allow-list; approval must be mined before the swap is sent | Mitigated. No UI yet to review or revoke existing approvals |
| Token decimal attacks | Solana: decimals read from the mint at selection and again at build, mismatch blocks (`decimalsMismatch`). EVM: not yet implemented in the UI path | Mitigated on Solana. On EVM the page reads decimals from the contract itself at selection |
| Fake token metadata | Names/symbols cleaned (control and direction-override characters removed, length-capped); only https logos; "verified" is a curated field discovery cannot set; on-chain metadata is never overwritten by API text | Mitigated |
| Symbol collisions | Identity is `chain:address`; search flags symbols shared by several tokens and shows addresses | Mitigated |
| Malicious RPC responses | Balance and receipt responses are validated before use; Solana reads go through the allow-listed proxy | Partial. A malicious RPC can still lie about state; simulation runs on the same RPC |
| Provider compromise | Providers can only produce data, never sign or send; output is simulated and (EVM) allow-listed | Partial. A compromised Jupiter could craft a transaction that passes balance checks but differs in other ways; the simulation judge limits but does not eliminate this |
| Route manipulation | The route shown is provider-reported text and is labelled as such; the router never switches route silently; a worse fallback is only offered with the percentage shown | Mitigated |
| Transaction replay / duplicate execution | One execution per quote id, set before the wallet is asked, cleared only after a declined signature; adapters keep their own guard; concurrent calls tested | Mitigated |
| Incorrect fee calculation | bigint maths, rounded down, capped at 100 bps, validated, property-tested; the existing 1% Trade-tab fee is unchanged and is a separate path | Mitigated for Swings. **Trade tab fee conflicts with the 87 bps policy** (decision pending) |
| Insufficient balance | UI pre-check from holdings; simulation catches the rest; EVM balance issue becomes a blocker | Mitigated |
| Transfer-restricted tokens | Freeze authority and Token-2022 extensions flagged on Solana | Partial (see malicious tokens) |
| MEV / front-running | Only slippage limits. No private transaction submission, no sandwich detection | **Not mitigated.** The review screen estimates exposure from slippage and trade size and warns; there is no private submission. Large trades in thin pools are exposed |
| Cross-chain message risks | Cross-chain execution is hard-disabled (`CrossChainRouter.EXECUTION_ENABLED = false`) | N/A until a bridge path is reviewed |
| Secrets in logs | `redact()` removes secret-named fields and masks long blobs; telemetry stores aggregates and no wallet addresses; tested | Mitigated for Swings code. The rest of the site was not audited |
| API keys in the browser | 0x and Supabase keys exist only in server env; endpoints return generic errors and never relay upstream bodies | Mitigated |
| Abuse of server endpoints | Origin allow-list and per-IP limits (best-effort, in-memory per instance); discovery endpoint requires `CRON_SECRET` | Partial. Scripts can fake origins; provider-side limits are the real protection |

## Known residual risks
See `docs/audit/known-risks.md`.
