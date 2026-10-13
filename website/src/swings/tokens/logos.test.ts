import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedLogo, ensureLogos, nativeLogo, parseDexLogos, parseGeckoLogos, resetLogos } from './logos.js';
import { EVM_NATIVE_ADDRESS } from '../core/types.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const EVM = '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913';
const pairs = (rows: [string, string | null][]) => rows.map(([address, url]) => ({ baseToken: { address }, ...(url ? { info: { imageUrl: url } } : {}) }));
const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => resetLogos());
/** How many requests went to DexScreener (the second source, GeckoTerminal, is asked only about what DexScreener left without a picture). */
const dexCalls = (f: ReturnType<typeof vi.fn>): number => f.mock.calls.filter((c) => String(c[0]).includes('dexscreener')).length;

describe('native coin logos', () => {
  it('use the network own picture, with no lookup', () => {
    expect(nativeLogo('solana', 'So11111111111111111111111111111111111111112')).toBe('/assets/chains/solana.png');
    expect(nativeLogo('bnb', EVM_NATIVE_ADDRESS)).toBe('/assets/chains/bnb.png');
    expect(nativeLogo('base', EVM_NATIVE_ADDRESS.toUpperCase().replace('0X', '0x'))).toBe('/assets/chains/ethereum.png');
    expect(nativeLogo('solana', BONK)).toBeNull();
    expect(nativeLogo('solana', '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG')).toBe('/assets/logo-mark.png');
    expect(cachedLogo('polygon', EVM_NATIVE_ADDRESS)).toBe('/assets/chains/polygon.png');
  });
});

describe('looking up pictures', () => {
  it('reads each pair first token and its https picture, ignoring anything else', () => {
    expect(parseDexLogos(pairs([[BONK, 'https://cdn.dexscreener.com/a.png'], ['x', 'http://insecure/a.png'], ['y', null]]))).toEqual([{ address: BONK, url: 'https://cdn.dexscreener.com/a.png' }]);
    expect(parseDexLogos({ nope: 1 })).toEqual([]);
    expect(parseDexLogos(pairs([[BONK, 'javascript:alert(1)']]))).toEqual([]);
  });

  it('finds a picture once, remembers it, and does not ask again', async () => {
    const f = vi.fn(reply(pairs([[BONK, 'https://cdn.dexscreener.com/a.png']])));
    expect(await ensureLogos('solana', [BONK], f)).toBe(true);
    expect(cachedLogo('solana', BONK)).toBe('https://cdn.dexscreener.com/a.png');
    expect(await ensureLogos('solana', [BONK], f)).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('asks for up to 30 tokens in one request, and matches EVM addresses whatever their capitals', async () => {
    const f = vi.fn(reply(pairs([[EVM.toLowerCase(), 'https://cdn.dexscreener.com/u.png']])));
    await ensureLogos('base', [EVM], f);
    expect(cachedLogo('base', EVM.toLowerCase())).toBe('https://cdn.dexscreener.com/u.png');
    const many = Array.from({ length: 65 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    const g = vi.fn(reply([]));
    await ensureLogos('base', many, g);
    expect(dexCalls(g)).toBe(3);
  });

  it('does not keep asking about a token with no picture, but tries again later; a failing service never throws', async () => {
    const f = vi.fn(reply(pairs([[BONK, null]])));
    expect(await ensureLogos('solana', [BONK], f, () => 0)).toBe(false);
    await ensureLogos('solana', [BONK], f, () => 1000);
    expect(dexCalls(f)).toBe(1);
    await ensureLogos('solana', [BONK], f, () => 11 * 60_000);
    expect(dexCalls(f)).toBe(2);
    await expect(ensureLogos('solana', ['other'], (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).resolves.toBe(false);
    await expect(ensureLogos('solana', ['another'], reply({}, 429))).resolves.toBe(false);
  });
});

describe('GeckoTerminal pictures', () => {
  it('reads the https picture of each token and skips the placeholder', () => {
    const body = { data: [{ attributes: { address: '0xaa', image_url: 'https://assets.geckoterminal.com/a.png' } }, { attributes: { address: '0xbb', image_url: 'https://assets.geckoterminal.com/missing.png' } }, { attributes: { address: '0xcc', image_url: null } }, { attributes: { address: '0xdd', image_url: 'http://insecure/a.png' } }] };
    expect(parseGeckoLogos(body)).toEqual([{ address: '0xaa', url: 'https://assets.geckoterminal.com/a.png' }]);
    expect(parseGeckoLogos(null)).toEqual([]);
    expect(parseGeckoLogos({ data: 'x' })).toEqual([]);
  });

  it('asks GeckoTerminal about a token DexScreener has no picture for', async () => {
    const f = vi.fn(async (url: string) => (url.includes('dexscreener') ? new Response('[]') : new Response(JSON.stringify({ data: [{ attributes: { address: EVM.toLowerCase(), image_url: 'https://assets.geckoterminal.com/x.png' } }] })))) as unknown as typeof fetch;
    expect(await ensureLogos('bnb', [EVM], f)).toBe(true);
    expect(cachedLogo('bnb', EVM)).toBe('https://assets.geckoterminal.com/x.png');
  });
});
