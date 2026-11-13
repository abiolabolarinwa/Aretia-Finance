import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = resolve(__dirname, '../content/guides');
const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
const slugs = new Set(files.map((f) => f.replace(/\.md$/, '')));

describe('the guides', () => {
  it('has a title and a description of a useful length in each, and a date', () => {
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), 'utf8');
      const title = /^title: "(.+)"$/m.exec(text)?.[1] ?? '';
      const description = /^description: "(.+)"$/m.exec(text)?.[1] ?? '';
      expect(title.length, f).toBeGreaterThan(10);
      expect(description.length, f).toBeGreaterThan(60);
      expect(description.length, f).toBeLessThan(300);
      expect(/^date: \d{4}-\d{2}-\d{2}$/m.test(text), f).toBe(true);
    }
  });

  it('only links to guides that exist', () => {
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), 'utf8');
      for (const m of text.matchAll(/\]\(\/learn\/([a-z0-9-]+)\)/g)) expect(slugs.has(m[1]!), `${f} links to /learn/${m[1]}`).toBe(true);
    }
  });

  it('makes no promise of returns, and no call to buy, anywhere', () => {
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), 'utf8').toLowerCase();
      for (const phrase of ['guaranteed return', 'you will earn', 'sure thing', 'to the moon', 'risk-free', 'can\'t lose', 'buy now']) expect(text.includes(phrase), `${f}: "${phrase}"`).toBe(false);
    }
  });
});
