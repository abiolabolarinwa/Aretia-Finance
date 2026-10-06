# Trust model

| Party | Trusted to | Not trusted to |
|---|---|---|
| The user's wallet | Hold keys, show and sign transactions | n/a (it is the user's) |
| Aretia code in the browser | Build requests, check results, ask the wallet to sign | Hold or see keys (it never does) |
| Aretia server functions | Hold API keys, answer from validated inputs | Be reachable by arbitrary callers (origin and secret checks) |
| Jupiter / 0x (routing APIs) | Supply routes and transaction data | Be honest: output is simulated, allow-listed (EVM) and bounded by the user's minimum |
| GeckoTerminal / token lists | Hint that a pool exists and when | Provide true names, decimals, symbols or safety: on-chain facts override, text is cleaned |
| RPC providers | Answer reads and relay broadcasts | Be truthful about state: a lying RPC is a residual risk |
| Supabase | Store registry rows | Be reachable from browsers (RLS on, service role only) |
| DEX and token contracts | Execute what they implement | Be audited by Aretia: they are not |
| Vercel | Host and keep env secrets | n/a |

Aretia makes no claim that any listed token is safe. The "verified" flag is a manual curation field that no automated path sets.
