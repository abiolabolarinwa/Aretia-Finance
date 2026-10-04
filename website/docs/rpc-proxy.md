# Solana RPC proxy (`/api/rpc`)

The web wallet (`/wallet`) reads the chain and submits transactions through a small Vercel
function, `api/rpc.ts`, instead of calling a public endpoint directly. The function forwards to a
paid RPC provider using a key that lives only in a server environment variable, so the key never
reaches the browser.

If the proxy is unavailable, refuses a request or is rate-limited, the page falls back to the free
public endpoint (`https://solana-rpc.publicnode.com`), so the wallet keeps working. Without
`SOLANA_RPC_URL` set, the function itself forwards to that public endpoint, so deploying it changes
nothing until you add a key.

## Set it up (one time)

1. Create an account with an RPC provider (Helius, Triton, QuickNode, Alchemy, ...) and make a
   Solana **mainnet** endpoint. It must allow `getTokenAccountsByOwner`, `getTokenLargestAccounts`
   and `simulateTransaction`.
2. In the provider's dashboard, restrict the key if it lets you: allowed domains
   (`aretiafinance.org`), a requests-per-second limit and a monthly cap. The proxy's own checks stop
   other websites in a browser, but a script can fake headers, so the provider-side limits are the
   real protection for your bill.
3. In Vercel -> the project -> Settings -> Environment Variables, add:
   - `SOLANA_RPC_URL` = the full provider URL including the key. Mark it **Sensitive**.
     Add it for Production, and for Preview if you want previews to use it.
   - `RPC_ALLOWED_ORIGINS` (optional) = comma-separated extra origins that may call the proxy,
     for example a preview URL: `https://aretia-finance-git-x.vercel.app`.
4. Redeploy. Check it:
   ```bash
   curl -s https://aretiafinance.org/api/rpc -H 'origin: https://aretiafinance.org' \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}'
   ```
   A number in `result` means it works. Rotate the key in the provider dashboard if it is ever
   exposed, then update the Vercel variable.

## What the proxy allows

- `POST` only, from `https://aretiafinance.org` and `https://www.aretiafinance.org` (plus
  `RPC_ALLOWED_ORIGINS`; `localhost` only outside production).
- One JSON-RPC 2.0 object per request (no batches), at most 16 KB.
- Only these methods: `getAccountInfo`, `getMultipleAccounts`, `getBalance`, `getBlockHeight`,
  `getEpochInfo`, `getFeeForMessage`, `getLatestBlockhash`, `getMinimumBalanceForRentExemption`,
  `getRecentPrioritizationFees`, `getSignatureStatuses`, `getSignaturesForAddress`, `getSlot`,
  `getTokenAccountBalance`, `getTokenAccountsByOwner`, `getTokenLargestAccounts`, `getTransaction`,
  `isBlockhashValid`, `sendTransaction`, `simulateTransaction`. `getProgramAccounts` and everything
  else is refused. Edit `ALLOWED_METHODS` in `api/_rpcProxy.ts` to change this.
- 120 requests per minute per IP, held in memory per serverless instance, so it is a best-effort
  brake and not an exact limit.
- Only the validated `jsonrpc`, `id`, `method` and `params` are forwarded. Upstream error pages are
  never relayed.

## What it does not cover

- The Jupiter swap widget talks to its own endpoint directly (it uses methods outside the list).
- Request bodies are not logged. Vercel's own function logs still record request metadata.
