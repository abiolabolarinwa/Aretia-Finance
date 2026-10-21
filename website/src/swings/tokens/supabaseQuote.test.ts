import { describe, expect, it } from 'vitest';
import { ilikeContains, SupabaseTokenRepository } from './supabase.js';

/** Reads one double-quoted PostgREST value back as PostgREST does: up to the first unescaped quote, `\x` meaning x. */
function unquote(v: string): { value: string; rest: string } {
  expect(v.startsWith('"')).toBe(true);
  let out = '';
  for (let i = 1; i < v.length; i++) {
    if (v[i] === '\\') out += v[++i];
    else if (v[i] === '"') return { value: out, rest: v.slice(i + 1) };
    else out += v[i];
  }
  throw new Error('unterminated');
}

describe('I-24: token search values are quoted for PostgREST', () => {
  it('keeps crafted text inside one value, whatever it contains', () => {
    for (const evil of ['abc),verified.eq.true', 'x",symbol.eq.ACT,name.ilike."', 'back\\slash"quote', 'a*b%c_d', '(),.:']) {
      const { value, rest } = unquote(ilikeContains(evil));
      expect(rest).toBe('');
      expect(value.startsWith('*') && value.endsWith('*')).toBe(true);
      expect(value.slice(1, -1)).not.toContain('*');
    }
    expect(unquote(ilikeContains('50%_off')).value).toBe('*50\\%\\_off*');
  });

  it('is what the repository sends', async () => {
    let url = '';
    const repo = new SupabaseTokenRepository('https://x.supabase.co', 'sb_secret_x', (async (u: string) => {
      url = u;
      return new Response('[]');
    }) as unknown as typeof fetch);
    await repo.searchText('a),verified.eq.true', 5);
    const or = decodeURIComponent(/or=([^&]+)/.exec(url)![1]!);
    expect(or).toBe(`(symbol.ilike.${ilikeContains('a),verified.eq.true')},name.ilike.${ilikeContains('a),verified.eq.true')})`);
  });
});
