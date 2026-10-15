/**
 * Says what is still missing before "Alerts on your phone" works, step by step, and what to do about each.
 *
 *   node scripts/alerts-check.ts                      what the live site reports
 *   TELEGRAM_BOT_TOKEN=... node scripts/alerts-check.ts   also asks Telegram about the bot and its webhook
 *
 * Nothing is changed and no secret is printed. SITE_ORIGIN defaults to https://aretiafinance.org.
 */
const origin = process.env.SITE_ORIGIN ?? 'https://aretiafinance.org';
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const lines: string[] = [];
let missing = 0;
const say = (ok: boolean | null, text: string, fix?: string): void => {
  if (ok === false) missing++;
  lines.push(`${ok === true ? '[ok]     ' : ok === false ? '[MISSING]' : '[?]      '} ${text}${ok === false && fix ? `\n           -> ${fix}` : ''}`);
};

try {
  const res = await fetch(`${origin}/api/swings-notify`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ op: 'config' }) });
  if (!res.ok) throw new Error(String(res.status));
  const c = (await res.json()) as { telegram?: boolean; webpush?: boolean };
  say(c.telegram === true, `Site: Telegram settings (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET)`, 'Set all three in Vercel (Production) and redeploy. See docs/alerts-to-phone.md, step 4.');
  say(c.webpush === true, `Site: browser alert keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)`, 'Run: node scripts/make-vapid-keys.ts, put its keys in Vercel (Production), and redeploy.');
} catch (e) {
  say(null, `Could not read ${origin}/api/swings-notify (${e instanceof Error ? e.message : 'error'}). The site may be down, or this machine may be offline.`);
}

if (!token) {
  say(null, 'Telegram: not checked. Run again with TELEGRAM_BOT_TOKEN set to also check the bot and its webhook.');
} else {
  try {
    const me = (await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json()) as { ok?: boolean; result?: { username?: string } };
    say(me.ok === true, `Telegram: the bot token works${me.result?.username ? ` (@${me.result.username})` : ''}`, 'Create the bot with @BotFather (/newbot) and use the token it gives you.');
    const hook = (await (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)).json()) as { result?: { url?: string; last_error_message?: string; pending_update_count?: number } };
    const url = hook.result?.url ?? '';
    say(url === `${origin}/api/swings-telegram`, `Telegram: webhook points at this site${url ? ` (now: ${url})` : ' (none set)'}`, 'Run: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-webhook.ts');
    if (hook.result?.last_error_message) say(false, `Telegram reports its last delivery failed: ${hook.result.last_error_message}`, 'Check TELEGRAM_WEBHOOK_SECRET matches the site setting exactly, then redeploy.');
  } catch (e) {
    say(null, `Telegram could not be reached (${e instanceof Error ? e.message : 'error'}).`);
  }
}

say(null, 'Database (migration 0010) and the every-minute schedule are not visible from here. Check them in Supabase: table notify_channels exists, and cron job "aretia-alerts" is listed.');
console.log(lines.join('\n'));
console.log(missing === 0 ? '\nNothing missing among what this check could see (lines marked [?] were not checked).' : `\n${missing} step${missing === 1 ? '' : 's'} still to do.`);

export {};
