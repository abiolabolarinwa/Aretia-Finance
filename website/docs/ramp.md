# Buy USDT and USDC inside Aretia Pay (`/api/ramp`)

Aretia Pay lets people send crypto, and with this feature also **buy USDT and USDC with local
currency** through third-party fiat ramp providers, without leaving the page. **Aretia never holds
fiat or crypto.** The provider verifies the customer, takes the payment and sends the stablecoin
straight to the customer's own Solana wallet. Only USDT and USDC on Solana are offered, and that is
enforced on the server, not just in the page.

It is built but **hidden and switched off** until you turn it on.

## How the money moves

- **Buying:** the customer pays the provider (card or bank transfer, depending on country) and
  receives USDT or USDC in their wallet. No money goes into a bank account.
- **Selling (not built):** the customer sends USDT or USDC to a deposit address the provider gives,
  and the provider pays fiat into their bank account or card. MoonPay does not allow selling from
  Nigeria; an African off-ramp such as Yellow Card would be a separate adapter.

## Two switches, both default off

| Switch | Where | What it does |
|---|---|---|
| `PUBLIC_PAY_BUY=1` | Vercel build environment | Adds the **Buy or sell USDT / USDC** tab to the Pay page in `/wallet`. Without it the tab does not exist in the page at all. |
| `RAMP_ENABLED=1` | Vercel runtime environment | Lets `/api/ramp` answer. Without it the function replies `{"enabled":false}` to everything. |

Turn on both, plus at least one provider's keys, to open it. Changing `PUBLIC_PAY_BUY` needs a redeploy.

## Providers

A provider is listed only when its keys are set. Today one adapter is built.

### MoonPay (buy)

1. Create a MoonPay partner account and get a **publishable key** and a **secret key**
   (use `pk_test_` / `sk_test_` first; they use MoonPay's sandbox widget).
2. In Vercel, set (mark the secret **Sensitive**):
   - `MOONPAY_PUBLISHABLE_KEY`
   - `MOONPAY_SECRET_KEY`
   - `MOONPAY_ENV=production` only when using live keys
   - `MOONPAY_WIDGET_URL` (optional) to override the widget host if MoonPay changes it
3. **Allow the domain for embedding.** The checkout opens inside the Pay page in an iframe, so
   MoonPay must be told `https://aretiafinance.org` is an approved domain (MoonPay's dashboard, or
   ask your MoonPay contact). Without it MoonPay refuses to load inside the page ("refused to
   connect"). Apple Pay also needs a domain verification step with Apple.

The server builds the widget URL with the customer's wallet address and signs it with the secret key
(HMAC-SHA256 of the query string, base64, as MoonPay documents). The secret never reaches the
browser. The signing is tested against MoonPay's published test vector.

### How the checkout is embedded

The page frames only an `https://*.moonpay.com` address (anything else is refused client-side),
with `allow="payment; camera"` (card/wallet payments and the ID check) and a `sandbox` that allows
scripts, forms and pop-ups but **not** top-level navigation, so the provider cannot redirect the
Aretia page. A "Close checkout" button and an "Open in a new tab instead" link are always shown.

**Not yet tested against a live MoonPay account:** how every payment method and ID check behaves
inside the sandboxed frame. Test the full flow with sandbox keys before opening it to users; if a
step fails inside the frame, loosen the sandbox in `embedProvider` (`src/scripts/walletApp.ts`) or
use the new-tab link.

### Adding another provider

Add an adapter in `api/_ramp.ts`: list it in `configuredProviders` (only when its keys exist),
build its session URL or token in the `session` action, and add its asset codes next to
`RAMP_ASSETS`. Keep the rules that matter: only `USDC`/`USDT` on Solana, validate the wallet
address, never return a key. If its host is not `moonpay.com`, extend the host check in
`embedProvider`.

## What the server enforces

- `POST` only, from an allowed origin (same rule as `/api/rpc`), JSON, 4 KB at most, rate limited.
- Assets: only `USDC` and `USDT`. Anything else returns 400.
- Side: only `buy` for now.
- Wallet: must be a valid Solana address.
- Fiat code: three letters. Amount: a whole number from 1 to 1,000,000.
- A provider that is not configured is refused.

## Before you open it to users

- Read each provider's integrator terms and confirm your obligations with a lawyer, especially for
  the countries you serve. Provider marketing about "inheriting" their licences is not legal advice.
- Confirm the exact payment methods and fees for your target currencies (for example naira) with
  the provider in writing. The country list here comes from MoonPay's public API; it does not prove a
  given payment method is live.
- Decide how you earn (partner fees, referral share). None is configured here.
- Check the production MoonPay widget address (`https://buy.moonpay.com` is the default) against
  their current docs before going live.
