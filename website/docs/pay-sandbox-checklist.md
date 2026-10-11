# Pay: sandbox test checklist

Nothing in Pay has been run against a real or sandbox MoonPay account yet. Work through this once with **sandbox** keys
(`pk_test_…` / `sk_test_…`) before turning anything on for users. Record each result with a date in
`docs/aretia-swings/readiness-attestations.json` (a gate counts as not done until someone records it).

## Set up
1. Vercel runtime environment: `RAMP_ENABLED=1`, `MOONPAY_PUBLISHABLE_KEY`, `MOONPAY_SECRET_KEY` (Sensitive). Leave `MOONPAY_ENV` unset (sandbox) and `MOONPAY_SELL_ENABLED` unset. Redeploy.
2. Open `/wallet#/send`, choose **Cash out or top up**. Expect a Buy tab, a Stablecoin box (USDC, USDT), a Network box, a Country box and "See options".
3. The status call in the browser's network tab (`POST /api/ramp {"action":"status"}`) should show `enabled: true` and a `keyCheck` with `pk_test_` and `sk_test_` prefixes. A wrong prefix means a key was pasted in the wrong field.

## Buy, one row per case (Solana wallet, then an Ethereum-style wallet)
| Case | Expect |
|---|---|
| USDC on Solana, US, USD 50 | "See options" lists MoonPay with "fee shown on the provider's page"; Continue opens `buy-sandbox.moonpay.com` in a new tab with your wallet address filled in |
| USDT on Solana | Same, with USDT. USDT is not offered on the Ethereum-style networks |
| USDC on Base / Ethereum / Arbitrum / Polygon | Same, using the connected Ethereum-style account |
| Country MoonPay does not serve | A plain "does not sell crypto to customers in …" message, no checkout |
| Amount `0`, `1.5`, empty | "Enter a whole amount of at least 1." |
| Finish the sandbox payment | USDC lands (sandbox sends test funds); "Check my wallet" shows "arrived" with the amount, then clears |
| Close the tab, come back, reload | The "Waiting for your …" card is still there until the balance rises |

## Not yet to be switched on
- **Sell**: `MOONPAY_SELL_ENABLED=1` only after the sell link has been tried in the sandbox, including the refund address.
- **Production**: `MOONPAY_ENV=production` only with live keys, the production widget host checked against MoonPay's current docs, `aretiafinance.org` allowed for embedding, and the legal points in `ramp.md`.

## Send (no keys needed)
Send a few cents of SOL and of USDC to a second address you own: review screen, simulation, wallet approval, confirmation. Then the failures: your own address, an Ethereum-style address, a mistyped address, too many decimals, more than you hold.
