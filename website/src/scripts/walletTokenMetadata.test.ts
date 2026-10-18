import { describe, expect, it } from 'vitest';
import { buildMetadataJson, checkMetadataFile, imageTypeOf, isFetchableLink, metadataNotes } from './walletTokenMetadata';

const good = { name: 'Greenleaf', symbol: 'GRN', description: 'A test token.', image: 'https://example.com/logo.png' };

describe('links', () => {
  it('accepts https and ipfs only, within the length, with no control characters', () => {
    for (const ok of ['https://example.com/a.png', 'ipfs://bafybeigdyrzt/logo.webp']) expect(isFetchableLink(ok), ok).toBe(true);
    for (const bad of ['', 'http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://x/a.png', 'not a url', `https://example.com/${'a'.repeat(200)}`, 'https://example.com/a\u0000.png']) expect(isFetchableLink(bad), bad).toBe(false);
  });
  it('reads the image type from the extension', () => {
    expect(imageTypeOf('https://x.io/a.PNG')).toBe('image/png');
    expect(imageTypeOf('https://x.io/a.jpeg?x=1')).toBe('image/jpeg');
    expect(imageTypeOf('https://x.io/a.svg')).toBeNull();
    expect(imageTypeOf('https://x.io/a')).toBeNull();
  });
});

describe('buildMetadataJson', () => {
  it('builds the standard file, with stable text', () => {
    const r = buildMetadataJson({ ...good, website: 'https://greenleaf.example', twitter: 'https://x.com/greenleaf' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.json).toEqual({
      name: 'Greenleaf',
      symbol: 'GRN',
      description: 'A test token.',
      image: 'https://example.com/logo.png',
      external_url: 'https://greenleaf.example',
      extensions: { website: 'https://greenleaf.example', twitter: 'https://x.com/greenleaf' },
      properties: { files: [{ uri: 'https://example.com/logo.png', type: 'image/png' }], category: 'image' },
    });
    expect(r.text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(r.text)).toEqual(r.json);
    expect(buildMetadataJson({ ...good, website: 'https://greenleaf.example', twitter: 'https://x.com/greenleaf' })).toEqual(r);
  });
  it('leaves out what was not given', () => {
    const r = buildMetadataJson(good);
    expect(r.ok && 'external_url' in r.json).toBe(false);
    expect(r.ok && 'extensions' in r.json).toBe(false);
  });
  it('accepts an ipfs logo with no extension', () => {
    const r = buildMetadataJson({ ...good, image: 'ipfs://bafybeigdyrzt' });
    expect(r.ok && r.json.properties.files[0]!.type).toBe('image/png');
  });
  it('says what to fix, for each field', () => {
    const cases: [Partial<typeof good> & Record<string, string>, RegExp][] = [
      [{ name: '' }, /name/],
      [{ name: 'x'.repeat(33) }, /name/],
      [{ symbol: '' }, /symbol/],
      [{ symbol: 'ABCDEFGHIJK' }, /symbol/],
      [{ description: 'd'.repeat(501) }, /description/],
      [{ image: '' }, /logo/],
      [{ image: 'http://example.com/a.png' }, /logo/],
      [{ image: 'https://example.com/a.svg' }, /\.png/],
      [{ image: 'https://example.com/a' }, /\.png/],
      [{ website: 'javascript:alert(1)' }, /website/],
      [{ twitter: 'nope' }, /Twitter/],
      [{ telegram: 'ftp://t' }, /Telegram/],
    ];
    for (const [over, re] of cases) {
      const r = buildMetadataJson({ ...good, ...over });
      expect(r.ok, JSON.stringify(over)).toBe(false);
      if (!r.ok) expect(r.problems.join(' ')).toMatch(re);
    }
  });
  it('counts characters, not bytes, for the name', () => {
    expect(buildMetadataJson({ ...good, name: '🌿'.repeat(32) }).ok).toBe(true);
    expect(buildMetadataJson({ ...good, name: '🌿'.repeat(33) }).ok).toBe(false);
  });
});

describe('metadataNotes (from the mint alone)', () => {
  it('is empty for a token with a usable link', () => {
    expect(metadataNotes({ name: 'A', symbol: 'A', uri: 'https://example.com/m.json' })).toEqual([]);
    expect(metadataNotes({ name: 'A', symbol: 'A', uri: 'ipfs://bafy' })).toEqual([]);
  });
  it('warns about no metadata, no link, and a link wallets will not load', () => {
    expect(metadataNotes(null).join(' ')).toMatch(/no name or symbol/);
    expect(metadataNotes({ name: 'A', symbol: 'A', uri: '' }).join(' ')).toMatch(/no metadata link/);
    expect(metadataNotes({ name: 'A', symbol: 'A', uri: 'http://example.com/m.json' }).join(' ')).toMatch(/not an https or ipfs link/);
  });
});

describe('checkMetadataFile (a hosted file against its token)', () => {
  const token = { name: 'Greenleaf', symbol: 'GRN' };
  it('accepts a file that matches', () => {
    expect(checkMetadataFile({ name: 'Greenleaf', symbol: 'GRN', description: 'x', image: 'https://example.com/l.png' }, token)).toEqual([]);
  });
  it('finds each problem', () => {
    expect(checkMetadataFile('nope', token).join(' ')).toMatch(/JSON metadata file/);
    expect(checkMetadataFile(null, token).join(' ')).toMatch(/JSON metadata file/);
    const base = { name: 'Greenleaf', symbol: 'GRN', description: 'x', image: 'https://example.com/l.png' };
    expect(checkMetadataFile({ ...base, image: undefined }, token).join(' ')).toMatch(/no usable logo/);
    expect(checkMetadataFile({ ...base, image: 'http://x/l.png' }, token).join(' ')).toMatch(/no usable logo/);
    expect(checkMetadataFile({ ...base, name: 'Other' }, token).join(' ')).toMatch(/name in the file/);
    expect(checkMetadataFile({ ...base, symbol: 'X' }, token).join(' ')).toMatch(/symbol in the file/);
    expect(checkMetadataFile({ ...base, description: ' ' }, token).join(' ')).toMatch(/no description/);
  });
});
