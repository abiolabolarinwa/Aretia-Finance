# ARETIA SWINGS: SECURITY MODEL

Written by the builders; not an independent review. The detailed control table for the aggregator-client path is `security-model.md`; the threat table for the direct engine is `ARETIA_SWINGS_THREAT_MODEL.md`.

## Boundaries
- **Signing boundary.** Aretia builds transactions; the user's own wallet signs. No Aretia code holds, derives or stores a key, seed or signature. Wallet code is the existing Wallet Standard / EIP-6963 layer.
- **Authority boundary.** A venue adapter can read pools. A builder can produce a plain transaction request. Neither can send. Sending requires the wallet and, in the router, an explicit confirmation naming one quote, once.
- **Trust boundary.** Chain state read from a node is trusted only as far as the node is; reads and simulation use the same node, so a lying node is a residual risk. Third-party text (token names, logos) is untrusted and cleaned. Aggregator output (Jupiter, 0x) is untrusted and, in the new design, optional.

## Controls specific to the direct engine
1. **Own maths, proven against the venue.** Constant-product quotes are exact integer maths matching the venue router's own `getAmountsOut` (live test, four chains, equal bit for bit).
2. **Own calldata, proven against the venue.** Built swaps are decoded back to their parts (`inspectV2Swap`) and accepted by the real routers in simulation; a floor above the pool's output is refused by the router.
3. **Mandatory floors.** The builder refuses `minOut = 0`, an expired deadline, a native-path mismatch, repeated tokens, and malformed addresses.
4. **Deterministic routing with reasons.** One scoring formula, no hidden inputs, every adjustment logged.
5. **Freshness and health.** Pools carry their read time and block; stale pools are ignored or penalised; unhealthy venues are skipped or penalised; any venue can be removed by deleting a registry entry.
6. **No aggregator dependency in the engine.** `engine/`, `dex/` and `execution/` import nothing from `providers/` or the aggregator wiring (checked by search).

## Honest limits
- No swap has been signed or sent through any direct path. The evidence is simulation against the real programs and read-only comparison with the venues' own routers, which is strong for correctness of construction and silent about everything that only shows up with real funds (wallet behaviour, confirmation timing, front-running in practice).
- Splits are priced but cannot yet be executed atomically. Pool authenticity does not imply token safety. There is no protection against sandwiching beyond slippage.
- Solana direct coverage is two venues; the venues that hold SOL and USDC liquidity are not integrated, so an aggregator can still pay more (and, while enabled, is allowed to compete). DAMM v2 and Uniswap V3 are priced by the venues themselves, not by Aretia's maths.
- The ACT buyback has no executor. The EVM indexer is the only indexer.
- Aggregator output (Jupiter, 0x), while enabled, is untrusted: it is rebuilt and simulated like any other quote, and the operator can turn it off.
