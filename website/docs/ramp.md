# Aretia Marketplace: buy and sell USDT and USDC (`/api/ramp`)

The Aretia Marketplace lets people buy USDT and USDC with local currency through third-party fiat
ramp providers. **Aretia never holds fiat or crypto.** The provider verifies the customer, takes the
payment and sends the stablecoin straight to the customer's own Solana wallet. Only USDT and USDC
on Solana are offered, and that is enforced on the server, not just in the page.

It is built but **hidden and switched off** until you turn it on.

## Two switches, both default off

| Switch | Where | What it does |
|---|---|---|
| `PUBLIC_MARKETPLACE=1` | Vercel build environment | Includes the **Marketplace** tab in `/wallet`. Without it the tab does not exist in the page at all. |
| `RAMP_ENABLED=1` | Vercel runtime environment | Lets `/api/ramp` answer. Without it the function replies `{"enabled":false}` to everything. |

Turn on both, plus at least one provider's keys, to open it. Changing `PUBLIC_MARKETPLACE` needs a redeploy.

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
3. In MoonPay's dashboard, add `aretiafinance.org` where it asks for allowed domains.

The server builds the widget URL with the customer's wallet address and signs it with the secret key
(HMAC-SHA256 of the query string, base64, as MoonPay documents). The secret never reaches the
browser. The implementation is tested against MoonPay's published test vector.

**What is not built:** selling (off-ramp) for any provider. MoonPay does not allow selling from
Nigeria; an African off-ramp such as Yellow Card would be a separate adapter. Onramper, Transak and
Yellow Card are not built either, because each needs its own account and keys first.

### Adding another provider

Add an adapter in `api/_ramp.ts`: list it in `configuredProviders` (only when its keys exist),
build its session URL or token in the `session` action, and add its asset codes next to
`RAMP_ASSETS`. Keep the rules that matter: only `USDC`/`USDT` on Solana, validate the wallet
address, never return a key.

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
