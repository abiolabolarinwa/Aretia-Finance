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

  it('never promises returns or tells the reader to buy: such words appear only in a line that warns against them', () => {
    // A guide may name these claims in order to warn against them ("ignore anyone promising guaranteed returns"); the same words in a
    // line with no warning in it would be Aretia making the promise, and fail.
    const promises = ['guaranteed return', 'you will earn', 'sure thing', 'to the moon', 'risk-free', "can't lose", 'buy now', 'safest', 'best crypto'];
    const warns = ['never', 'ignore', 'scam', 'claim', 'promis', 'anyone', 'impersonat', 'not '];
    for (const f of files) {
      const lines = readFileSync(resolve(dir, f), 'utf8').toLowerCase().split('\n');
      for (const line of lines) {
        for (const phrase of promises) {
          if (line.includes(phrase)) expect(warns.some((w) => line.includes(w)), `${f}: "${phrase}" in: ${line.slice(0, 90)}`).toBe(true);
        }
      }
    }
  });
});
