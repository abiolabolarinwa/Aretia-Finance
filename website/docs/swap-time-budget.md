# Swap time budget

Goal: from pressing Swap to a confirmed result in under one minute, not counting the seconds you spend approving in your wallet. Every automatic step ends in a clear answer at its limit instead of waiting on.

| Step | Limit | Where |
| --- | --- | --- |
| Quote: after the first usable route, others get a short window; slower ones are left out | 4 s grace | `router.ts` `findRoutes`, `QUOTE_GRACE_MS` |
| Prepare the transaction | 12 s | `BUILD_TIMEOUT_MS` |
| EVM approval and fee receipts | 45 s each | `RECEIPT_TIMEOUT_MS` |
| EIP-5792 batch | 60 s | `BATCH_TIMEOUT_MS` |
| Waiting for confirmation | 45 s, polled every 1 s | `TRACK_TIMEOUT_MS` |

Typical time is a few seconds. The worst case is longer than a minute only when the chain itself is congested; then the screen says "Still waiting for confirmation" and the swap may still land, so check the transaction before trying again. Time in the wallet is yours and is not limited. The done banner shows the whole time and how much of it was in the wallet.

The Aretia Router for Solana keeps its own 25 s quote limit (two-hop quotes need it); it no longer holds up a swap when another route has already answered.
