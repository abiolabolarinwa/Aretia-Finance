import { describe, expect, it } from 'vitest';
import { bearerMatches, sameSecret } from './_secrets.js';
import { handleLaunchboxRun } from './_launchbox.js';
import { handleTelegramWebhook } from './_swingsNotify.js';

describe('I-22: secrets are compared in constant time', () => {
  it('matches only the exact secret, of any length, and never an empty one', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abd', 'abc')).toBe(false);
    expect(sameSecret('abcd', 'abc')).toBe(false);
    expect(sameSecret('', '')).toBe(false);
    expect(sameSecret(null, 'abc')).toBe(false);
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches(null, undefined)).toBe(false);
  });

  it('guards the cron and Telegram endpoints', async () => {
    const never = (async () => new Response('[]')) as unknown as typeof fetch;
    const base = { method: 'GET', origin: null, ip: 'x', fetchImpl: never, now: 1, query: {}, body: {} };
    expect((await handleLaunchboxRun({ ...base, authorization: 'Bearer wrong', env: { CRON_SECRET: 'right' } } as never)).status).toBe(401);
    expect((await handleTelegramWebhook({ ...base, method: 'POST', authorization: null, telegramSecret: 'wrong', env: { TELEGRAM_WEBHOOK_SECRET: 'right', TELEGRAM_BOT_TOKEN: 't' } } as never)).status).toBe(401);
  });
});
