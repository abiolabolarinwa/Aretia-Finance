/** The small part of Telegram's bot interface this site uses: sending a message, and reading what a person sent the bot. */

export interface TelegramUpdate {
  message?: { text?: string; chat?: { id?: number | string; type?: string } };
}

/** What a person said to the bot, when it is a plain text message in a private chat. Anything else is null. */
export function readUpdate(body: unknown): { chatId: string; text: string } | null {
  const m = (body as TelegramUpdate | null)?.message;
  const id = m?.chat?.id;
  if (!m || m.chat?.type !== 'private' || (typeof id !== 'number' && typeof id !== 'string') || typeof m.text !== 'string') return null;
  return { chatId: String(id), text: m.text.slice(0, 200) };
}

/** `/start <code>` as sent by the "Connect Telegram" link: the code, or null for any other message. */
export function startCode(text: string): string | null {
  const m = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/.exec(text.trim());
  return m ? m[1]! : null;
}

export const isStop = (text: string): boolean => /^\/(stop|unlink)(?:@\w+)?\s*$/i.test(text.trim());

/** Sends one plain-text message. Returns the status Telegram answered: 200 sent, 403 the person blocked the bot. */
export async function sendTelegram(fetchImpl: typeof fetch, botToken: string, chatId: string, text: string): Promise<number> {
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500), disable_web_page_preview: true }) });
  return res.status;
}

/** The link that opens the bot with the code filled in. */
export const telegramLink = (botUsername: string, code: string): string => `https://t.me/${botUsername.replace(/^@/, '')}?start=${code}`;
