# Known risks and limitations

1. **No EVM swap has ever been run.** The page, adapters and provider are built and unit-tested, and reads were checked live, but 0x was never called (no key). The 0x trust list was filled from documentation and still needs confirming on each chain's explorer. Chains are off unless the operator enables them.
2. **No real swap has run through the new router.** The Solana pieces it wraps are the existing, working code.
3. **MEV is not mitigated** beyond slippage limits. The review screen estimates and warns; swaps are not sent through a protected route.
4. **EVM token risk is incomplete:** holder concentration and transfer restrictions are not measured; taxes and source verification only when optional keys are set (not yet run live). Bytecode selector checks follow proxies but can still miss obfuscated code or misfire.
5. **Discovery detects only pool base tokens** reported by GeckoTerminal. A new token that appears only on the quote side is missed. Detection is as timely as that feed and the polling schedule, not block-level.
6. **Holder concentration on Solana** excludes program-controlled accounts when owners can be read; the rule is a heuristic and is labelled as such. If owners cannot be read, the overall figure is used and says it may include pools.
7. **Price impact for Jupiter is estimated** from the trade against a 1/100th-size trade (the existing method), not taken from Jupiter, and may be unavailable.
8. **Rate limits are in-memory per serverless instance**: a brake, not a guarantee.
9. **Analytics** are in-memory in the session unless the operator enables the anonymous event sink, which stores allow-listed aggregate fields only.
10. *(resolved)* EIP-55 checksums are verified; a mixed-case address with a wrong checksum is rejected.
11. **The Trade tab still charges the old 1% fee**, which conflicts with the stated 87 bps buyback model. Decision pending.
12. **The ACT buyback has no execution path.** Its economics (funding source, slippage, failure and circular-route handling) are unreviewed.
13. **Dependency advisories:** 11 reported by `npm audit --omit=dev` (7 moderate, 4 high), through `@solana/web3.js` and `@bonfida/spl-name-service`; every remaining fix is a breaking major upgrade.
14. **A lying RPC** can misreport state; simulation and broadcast use the same RPC.
15. **The existing wallet connection (`wallet.js`) and the rest of the site were not audited** as part of this work.
