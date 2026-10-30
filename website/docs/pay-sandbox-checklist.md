# Pay: MoonPay sandbox buy, step by step

Goal: prove the buy flow once, end to end, with **sandbox** keys and no real money, before anything is switched on for users. Nothing in Pay has been run against a MoonPay account yet. Record the outcome, with a date, in `docs/aretia-swings/readiness-attestations.json`.

> MoonPay-side values below (test cards, KYC, special amounts) come from MoonPay's developer docs as read on 11 Oct 2026 ([sandbox testing guide](https://dev.moonpay.com/widget/sandbox-testing), [test mode](https://dev.moonpay.com/platform/overview/test-mode)). The two pages did not fully agree with each other, so if a card is refused, use the other page's card or ask your MoonPay contact. Never use test cards or test KYC data with live keys: MoonPay blocks accounts that do.

## 0. What you need
- A MoonPay partner account with **sandbox** keys: a publishable key (`pk_test_…`) and a secret key (`sk_test_…`).
- A Solana wallet (for USDC/USDT on Solana) and, to also try the Ethereum-style networks, a wallet with an Ethereum-style account (MetaMask has both).
- Access to the Vercel project's environment variables.

## 1. Switch it on in the sandbox (Vercel, Runtime environment)
| Variable | Value |
|---|---|
| `RAMP_ENABLED` | `1` |
| `MOONPAY_PUBLISHABLE_KEY` | your `pk_test_…` |
| `MOONPAY_SECRET_KEY` | your `sk_test_…` (mark **Sensitive**) |
| `MOONPAY_ENV` | leave **unset** (unset means the sandbox widget, `buy-sandbox.moonpay.com`) |
| `MOONPAY_SELL_ENABLED` | leave **unset** (sell stays off) |

Redeploy. Do not use a Preview deployment for the real-money switch later; this is the sandbox only.

## 2. Check the server side (2 minutes, no wallet)
Open `https://aretiafinance.org/wallet`, DevTools > Network, then Pay > **Cash out or top up**. Find the `POST /api/ramp` call whose body is `{"action":"status"}`. Expect:
- `enabled: true` and one provider, MoonPay, with `sides: ["buy"]`.
- `keyCheck` showing `pk_test_` for the publishable key and `sk_test_` for the secret key, with plausible lengths. A wrong prefix means a key is in the wrong field or from another account. (`keyCheck` is only sent while `MOONPAY_ENV` is not `production`.)
- The `catalog` call returns countries, currencies and tokens.

## 3. Buy, one row per case
Use a small whole amount (for example 50). In Pay, choose the Stablecoin, Network and Country, then **See options**, then **Continue to MoonPay**; the MoonPay page opens in a **new tab** at `buy-sandbox.moonpay.com`.

| # | Case | Expect |
|---|---|---|
| 1 | USDC, Solana, United States, USD 50 | See options lists MoonPay with "fee shown on the provider's page"; the new tab opens the sandbox widget with your Solana address already filled in |
| 2 | USDT, Solana | Same, with USDT |
| 3 | USDC on Base, Ethereum, Polygon | Same, using the connected Ethereum-style account (USDT is not offered there) |
| 4 | A country MoonPay does not serve | A plain "does not sell crypto to customers in …", no checkout |
| 5 | Amount `0`, `1.5`, empty | "Enter a whole amount of at least 1." |
| 6 | Complete the purchase in the widget | See the next section |
| 7 | Back in Pay: **Check my wallet** | See the next section |
| 8 | Close the tab, reload Pay | The "Waiting for your …" card is still there |

### In the MoonPay widget (sandbox)
- Use a **US or UK** address for the sandbox account; MoonPay says those work best with its test cards.
- KYC data is not really verified in the sandbox. If it asks for documents, use **Skip document submission**.
- Test card from MoonPay's docs: Visa `4000 0200 0000 0000`, any future expiry, any 3-digit CVC. The sandbox guide also lists 3-D Secure cards (Mastercard challenge `5385 3083 6013 5181`, Visa frictionless `4485 0403 7153 6584`, CVC `123`) and decline cards by reason.
- MoonPay's special amounts (test mode only): **48** triggers a wallet-ownership challenge and **49** a CVV re-entry challenge. Try both once.

### What "done" looks like, and what the sandbox cannot prove
- Passing means: the checkout opens from Aretia with the right address, asset and network; MoonPay's own page reaches its "success" state with the test card.
- **Check my wallet** (row 7) only turns green if the sandbox actually delivers tokens to your wallet. MoonPay's docs say test-mode purchases deliver a fraction of the quoted amount, and a sandbox may not deliver on-chain at all. If nothing arrives, that is not an Aretia failure: record "checkout reached success, delivery not observable in sandbox", and prove delivery with one small live purchase after the legal and production steps in `ramp.md`.

## 4. If something fails
| Symptom | Likely cause |
|---|---|
| Cash out or top up says "not switched on" | `RAMP_ENABLED` unset, or not redeployed |
| No MoonPay in the list | a key is missing or empty; check `keyCheck` |
| MoonPay page says "signature invalid" or refuses the link | the secret key does not match the publishable key (different accounts) |
| Country list is empty / catalog 502 | MoonPay's public currency list was unreachable; retry |
| The new tab is blocked | the browser blocked the pop-up; use the "open MoonPay" link under the button |

## 5. Not yet to be switched on
- **Sell:** `MOONPAY_SELL_ENABLED=1` only after the sell link has been tried in the sandbox, including the refund address.
- **Production:** `MOONPAY_ENV=production` only with live keys, the production widget host checked against MoonPay's current docs, and the legal and fee points in `ramp.md`.

## Send (no keys needed)
Send a few cents of SOL and of USDC to a second address you own: review screen, simulation, wallet approval, confirmation. Then the failures: your own address, an Ethereum-style address, a mistyped address, too many decimals, more than you hold.
