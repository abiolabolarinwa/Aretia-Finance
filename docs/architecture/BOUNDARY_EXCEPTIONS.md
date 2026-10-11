# Boundary Exceptions

Rule: `website/src/swings/**` must not import `src/scripts/**` or `src/pages/**` (lint rule in `website/eslint.config.js`, currently `warn`).
History: 25 violations at baseline → 3 after M-02. Promote the rule to `error` when this list is empty.

| File | Imports | Why it exists | Plan |
|---|---|---|---|
| `src/swings/live.ts` (2 imports) | `scripts/walletSend`, `scripts/walletSwap` | Composition root that wires the live Solana path to the existing UI-script implementations | Extract `fetchAccount/loadWeb3/rpcCall`, `fetchQuote/planSwap/signAndSubmitSwap` into `swings/solana/*`, leave re-exports in scripts (needs tests per function; signing path → owner review) |
| `src/swings/shield/liveDeps.ts` | `scripts/walletSend` (`rpcCall`, `resolveName`) | Live dependency wiring for Shield | Same extraction |
