# Pay: cash in and out when MoonPay is not working

Written 2026-11-13 from a short web search. **None of the providers below has been tried with Aretia, and the search results are vendor pages and comparisons, so check every claim against the provider's own current documents before committing.**

## First, find out why MoonPay is not working
Pay > Cash out or top up already reports what is wrong. Open DevTools > Network on that tab and find the `POST /api/ramp` call with body `{"action":"status"}`:
- `enabled: false` means `RAMP_ENABLED` / `PUBLIC_PAY_BUY` is not set on the server or the build (see `docs/ramp.md`).
- `keyCheck` shows the key prefixes: `pk_test_` and `sk_test_` for sandbox. A wrong prefix is a key in the wrong field.
- A catalog or quote that returns nothing for a country usually means MoonPay does not serve that country or asset.
Send me that response (it holds no secret) and I can say whether it is a setup fault. That is cheaper than a new provider.

## What an alternative must offer to fit Aretia
Aretia never holds keys or funds. So the provider takes the card or bank payment and the identity check on its own page, and sends the stablecoin to the person's own wallet. Aretia only builds the link. Pay already has the plumbing for more than one provider (`src/swings/ramp/router.ts`, one adapter built: `moonpay.ts`); a provider is listed only when its keys are set.

## Shortlist (to check)
| Provider | What the search says | What Aretia would need |
|---|---|---|
| [Transak](https://docs.transak.com/guides/how-to-create-a-widget-url-and-test-different-scenarios) | Hosted widget, opened in a new tab with a redirect back to the site. Staging keys and sandbox KYC are available straight after signup. A signed or API-created widget URL is required (query-string parameters are described as no longer supported), made on the server; the site's domain must match the referrer. | A Transak partner account, a server-side call to create the widget URL, a new adapter next to `moonpay.ts`. |
| Ramp Network | Widget with buy and sell, many countries; described as having an EU licence under MiCA. | A partner account and a new adapter. Details not read. |
| Stripe crypto onramp | One embed, Stripe does the identity check and settlement; mainly USDC or ETH; coverage described as US plus limited others. | A Stripe account approved for it. Narrow coverage for Aretia's users. |
| Mercuryo | Described as available in 150+ countries. | A partner account and a new adapter. Details not read. |
| Coinbase | One source says the hosted guest checkout ended in June 2026 and the headless API replaced it. | Not a fit without more reading. |

The EU rules matter: from 1 July 2026 a provider serving EU customers needs MiCA authorisation, so confirm that for every country Aretia wants to serve.

## What I need from the owner to build the second provider
1. Which countries matter most.
2. A sandbox or staging account at the chosen provider and its keys, put in the server settings (never in a file in the repository).
3. A decision on sell (cash out): MoonPay's sell is off today; some providers' widgets support it, some do not.
Without keys I can build the adapter but cannot test it, and Pay lists it only when its keys are set, so building it early is safe.
