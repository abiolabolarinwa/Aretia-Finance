# Alerts to a phone: Telegram and browser notifications

Price alerts that arrive while the wallet is closed. The page's own alerts only work while it is open; these are sent by the
site's server, on a schedule, to a Telegram chat or a browser the person has linked.

## What it watches, for each person who links a place

- Their **favourites** (the ones saved to their wallet): a message when one moves by the chosen percentage (2, 5, 10 or 20%)
  from where it was when it last alerted.
- Their **price orders** ("tell me when it reaches this price", on the Swap page): copied to the server when the wallet is signed
  in, and reported once when the price is reached.

Linking needs the wallet signed in (the same free message that saves favourites), so the server knows whose favourites to watch.
A message only carries a title, some numbers and a link to the site. It never asks the person to sign or approve anything.

## One-time setup

1. **Database.** Run `supabase/migrations/0010_notifications.sql` in the Supabase SQL editor (after 0008 and 0009).
2. **Telegram bot.** In Telegram, message @BotFather, send `/newbot`, and pick a name and a username ending in `bot`. Keep the
   token it gives you.
3. **Browser alerts keys.** Run `node scripts/make-vapid-keys.ts` and keep its three lines.
4. **Settings on the site (Vercel, Production):**

   | Setting | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | the token from BotFather |
   | `TELEGRAM_BOT_USERNAME` | the bot's username, without the `@` |
   | `TELEGRAM_WEBHOOK_SECRET` | any long random string (letters, digits, `_`, `-`) |
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | from step 3 |
   | `VAPID_SUBJECT` | `mailto:` and a contact address |
   | `CRON_SECRET` | already set for discovery; the checker uses the same one |

   Redeploy after setting them.
5. **Telegram webhook.** Once deployed: `TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-webhook.ts`.
   It should answer `200` and `"ok":true`.
6. **Schedule.** Run `supabase/cron/alerts-every-minute.sql` in the SQL editor (fill in the two placeholders). The GitHub workflow
   `alerts-run.yml` is a backup that runs every five minutes, when GitHub gets to it.

## Checking the setup

`node scripts/alerts-check.ts` (or `npm run alerts:check`) lists what is still missing and what to do about each item. Add
`TELEGRAM_BOT_TOKEN=...` in front to also check the bot and its webhook.

## Trying it

Open the wallet, sign in ("Save to my wallet"), go to **Favourites**, and use **Alerts on your phone**: *Connect Telegram* opens the
bot, press Start; *Turn on browser alerts* asks the browser for permission. *Send a test* sends one message to everything linked.

On an iPhone, browser alerts only work once Aretia has been added to the Home Screen (Share, then Add to Home Screen) and is opened
from there. Telegram works without that.

## Limits to know about

- Prices come from DexScreener, one lookup for every token anyone watches, each run. A token it cannot price is skipped, never
  treated as zero.
- A run sends at most five messages to one person, then a line saying how many more there were.
- A move that could not be delivered is not remembered as sent, so it is tried again on the next run. A person who blocks the bot
  or a browser that has gone is removed automatically. Send `/stop` to the bot to stop Telegram alerts.
- WhatsApp and iMessage are not part of this. SMS or WhatsApp could be added as more channels later.

## Market alerts: new launches, large buys, liquidity taken out

Each person can also switch on, in the same card on the Favourites page:

- **New launches** on the networks they tick (Solana, Ethereum, Base, BNB Chain, Polygon, Robinhood Chain), optionally only when
  the new pool already holds at least $1K, $5K, $10K or $50K of liquidity. A run looks back 30 minutes.
- **Large buys of a favourite**: a single buy of $1K, $5K, $10K or $50K or more in one of the favourite's two deepest pools. A run
  looks back 15 minutes. The dollar value is the quote amount times the quote token's price as the index last computed it.
- **Liquidity taken out of a favourite's pool**: 30%, 50% or 80% of it, measured from the most the pool held in the last day.
  Liquidity counts as taken out only when both sides of the pool shrink together; a heavy sell (token side grows) does not count.
  Liquidity **locks are not tracked** anywhere in the index, so there is no "lock ended" alert.

All three are read from Aretia's own market index (`mi_pools`, `mi_tokens`, `mi_trades`), never from an outside service. The index
server is small (1 vCPU, 2 GB), so a run asks it at most: one question for new pools (100 rows), one for their names, and per network
one for the favourites' pools and one for their recent buys (300 rows). The favourites read per run are capped at 60 tokens, shared
round-robin between people. Nothing is asked when nobody has a market alert on.

Limits: at most 4 market messages per person per run (the last one says how many more there were; many launches on one network
become one line) and 12 per hour. Each launch, buy or drop is sent to a person once. A failure here (the index slow or down, or the
migration below not run) is reported in the run's answer as `market` and leaves the price alerts untouched.

Setup: apply migration `0026_market_alerts.sql` to whichever database `SUPABASE_URL` points at: on the self-hosted data server,
`./bin/update.sh` applies it and reloads Caddy (whose list now includes the three new tables); on Supabase, `npm run db:migrate`
or paste it in the SQL editor. Until then the card says market alerts are
not switched on, and the run skips them. The index is read with `MI_DATA_URL` and `MI_DATA_SERVICE_ROLE_KEY` (the same settings the
Markets list uses).
