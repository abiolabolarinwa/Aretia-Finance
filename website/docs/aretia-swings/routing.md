# Routing

Pipeline: `QuoteRequest -> providers (concurrent) -> normalise -> filter executable -> rank -> best + alternatives`.

A quote is **executable** only if all of these hold: not expired, `minOut > 0`, token identities match the request (`chain + address`), amounts parse as bigint, price impact is under the hard cap, and it came from a provider that is currently healthy.

Ranking score (higher is better), in output-token terms: `expectedOut - networkFee - providerFee - aretiaFee`, then penalties for price impact, route complexity (hops), low liquidity and the provider's recent failure rate. Ties break on the fresher quote. The UI labels the result "best route found", never "best price".

Every decision stores route metadata (candidates, scores, rejects with reasons) for debugging and analytics. Split routing and multi-hop are used where the provider returns them; Aretia does not build its own splits in V1.

Quotes are cached for a few seconds at most, for display only. A quote is re-fetched, or re-validated against its `expiresAt`, immediately before signing.
