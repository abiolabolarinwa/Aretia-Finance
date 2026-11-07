import { describe, expect, it } from 'vitest';
import { LaunchUploader } from './walletLaunchMeta';

describe('uploading to a Cloudflare R2 link', () => {
  it('sends the raw file with only the signed content type, not a form', async () => {
    const puts: { url: string; method?: string; headers: Record<string, string>; body: unknown }[] = [];
    const up = new LaunchUploader({
      fetchImpl: (async (url: string, init: RequestInit) => {
        puts.push({ url, method: init.method, headers: init.headers as Record<string, string>, body: init.body });
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
      session: async () => ({}) as never,
      call: async () => ({ uploadUrl: 'https://acct.r2.cloudflarestorage.com/b/img/x.png?X-Amz-Signature=s', url: 'https://assets.aretiafinance.org/img/x.png', raw: true }) as never,
    });
    const url = await up.put({ kind: 'image' }, new Uint8Array([1, 2, 3]), 'image/png');
    expect(url).toBe('https://assets.aretiafinance.org/img/x.png');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.method).toBe('PUT');
    expect(puts[0]!.headers).toEqual({ 'content-type': 'image/png' });
    expect(puts[0]!.body).toBeInstanceOf(Blob);
    expect((puts[0]!.body as Blob).size).toBe(3);
  });
});
