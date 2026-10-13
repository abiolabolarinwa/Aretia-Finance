import { describe, expect, it, vi } from 'vitest';
import { isStop, readUpdate, sendTelegram, startCode, telegramLink } from './telegram.js';

describe('telegram', () => {
  it('reads a private text message and nothing else', () => {
    expect(readUpdate({ message: { text: '/start abc', chat: { id: 42, type: 'private' } } })).toEqual({ chatId: '42', text: '/start abc' });
    expect(readUpdate({ message: { text: 'hi', chat: { id: 1, type: 'group' } } })).toBeNull();
    expect(readUpdate({ message: { chat: { id: 1, type: 'private' } } })).toBeNull();
    expect(readUpdate(null)).toBeNull();
    expect(readUpdate({ edited_message: {} })).toBeNull();
  });
  it('takes the link code from /start', () => {
    expect(startCode('/start abcdef0123456789abcdef')).toBe('abcdef0123456789abcdef');
    expect(startCode('/start@AretiaBot abcdef0123456789')).toBe('abcdef0123456789');
    for (const bad of ['/start', '/start short', '/start has space inside1234567890', 'hello', '/start <script>1234567890123456']) expect(startCode(bad)).toBeNull();
  });
  it('knows a stop request', () => {
    expect(isStop('/stop')).toBe(true);
    expect(isStop('/unlink@AretiaBot')).toBe(true);
    expect(isStop('stop it')).toBe(false);
  });
  it('sends through the bot api and reports the status', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    expect(await sendTelegram(f, '123:tok', '42', 'hello')).toBe(200);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:tok/sendMessage');
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', text: 'hello' });
  });
  it('builds the connect link', () => {
    expect(telegramLink('@AretiaBot', 'code1234567890abcd')).toBe('https://t.me/AretiaBot?start=code1234567890abcd');
  });
});
