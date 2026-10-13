/**
 * Tells Telegram where to send the alerts bot's messages. Run it once after the bot exists and the site has been deployed with
 * the settings below:
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-webhook.ts
 *
 * TELEGRAM_WEBHOOK_SECRET is any long random string you choose (letters, digits, _ and -); it must match the site's setting of
 * the same name, because the site only believes messages that carry it. SITE_ORIGIN defaults to https://aretiafinance.org.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const origin = process.env.SITE_ORIGIN ?? 'https://aretiafinance.org';
if (!token || !secret) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be 16 to 256 letters, digits, _ or -.');
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${origin}/api/swings-telegram`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }) });
console.log(res.status, await res.text());

export {};
