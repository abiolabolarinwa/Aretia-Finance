import { describe, expect, it } from 'vitest';
import { EVM_FACTORIES, TOKEN_CREATED_TOPIC } from '../launchbox/core.js';
import { creationVerified, launchLookup } from './launchLink.js';

const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
const utf8hex = (s: string): string => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
const str = (s: string): string => w(new TextEncoder().encode(s).length) + utf8hex(s).padEnd(Math.ceil(utf8hex(s).length / 64) * 64, '0');
function eventData(name: string, symbol: string): string {
  const a = str(name);
  const b = str(symbol);
  return '0x' + w(128) + w(128 + a.length / 2) + w(18) + w(10n ** 24n) + a + b;
}
const addrTopic = (a: string): string => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ab'.repeat(32);

const createdLog = (over: Record<string, unknown> = {}) => ({ address: EVM_FACTORIES.bnb, topics: [TOKEN_CREATED_TOPIC, addrTopic(TOKEN), addrTopic(CREATOR)], data: eventData('Aretia Coin', 'ARC'), blockNumber: '0x10', transactionHash: TX, logIndex: '0x1', ...over });

describe('Launch Box association (read only)', () => {
  it('verifies a creation on-chain through the approved factory', async () => {
    const read = async () => ({ status: '0x1', logs: [createdLog()] });
    expect(await creationVerified(read, 'bnb', TOKEN, TX)).toBe(true);
  });

  it('refuses a failed transaction, a different token, a different emitter or no receipt', async () => {
    expect(await creationVerified(async () => ({ status: '0x0', logs: [createdLog()] }), 'bnb', TOKEN, TX)).toBe(false);
    expect(await creationVerified(async () => ({ status: '0x1', logs: [createdLog()] }), 'bnb', '0x3333333333333333333333333333333333333333', TX)).toBe(false);
    expect(await creationVerified(async () => ({ status: '0x1', logs: [createdLog({ address: '0x4444444444444444444444444444444444444444' })] }), 'bnb', TOKEN, TX)).toBe(false);
    expect(await creationVerified(async () => null, 'bnb', TOKEN, TX)).toBe(false);
  });

  it('links only Launch Box rows that pass, and only reads Launch Box tables', async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      urls.push(url);
      methods.push(init.method ?? 'GET');
      return new Response(JSON.stringify([{ chain: 'bnb', address: TOKEN, tx: TX, pending: false, checked_at: null }, { chain: 'bnb', address: '0x5555555555555555555555555555555555555555', tx: TX, pending: false, checked_at: null }]), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = launchLookup({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', fetchImpl, readFor: () => async () => ({ status: '0x1', logs: [createdLog()] }) });
    const found = await lookup.find('bnb', [TOKEN, '0x5555555555555555555555555555555555555555']);
    // The second row's transaction does not show it being created: it is not linked.
    expect([...found.entries()]).toEqual([[TOKEN, `bnb:${TOKEN}`]]);
    expect(methods).toEqual(['GET']);
    expect(urls[0]).toContain('launchbox_tokens?chain=eq.bnb');
  });

  it('links a Solana row only after Launch Box has judged it', async () => {
    const MINT = 'So11111111111111111111111111111111111111112';
    const fetchImpl = (async () => new Response(JSON.stringify([{ chain: 'solana', address: MINT, tx: null, pending: false, checked_at: 5 }, { chain: 'solana', address: 'Other1111111111111111111111111111111111111', tx: null, pending: true, checked_at: null }]), { status: 200 })) as unknown as typeof fetch;
    const found = await launchLookup({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', fetchImpl, readFor: () => null }).find('solana', [MINT, 'Other1111111111111111111111111111111111111']);
    expect([...found.keys()]).toEqual([MINT]);
  });

  it('does nothing for a chain Launch Box does not cover, and tolerates missing tables', async () => {
    const never = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
    expect((await launchLookup({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', fetchImpl: never, readFor: () => null }).find('base', [TOKEN])).size).toBe(0);
    const missing = (async () => new Response('{"code":"PGRST205"}', { status: 404 })) as unknown as typeof fetch;
    expect((await launchLookup({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', fetchImpl: missing, readFor: () => null }).find('bnb', [TOKEN])).size).toBe(0);
  });
});
