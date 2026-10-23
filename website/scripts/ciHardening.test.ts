import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { gateProblems, highAdvisories } from './auditGateCore.mjs';

const workflowsDir = new URL('../../.github/workflows/', import.meta.url);

describe('ARETIA-SEC-007: every third-party action is pinned to a commit', () => {
  it('has no `uses:` line with a tag or branch instead of a 40-character commit', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(workflowsDir).filter((n) => n.endsWith('.yml'))) {
      for (const [i, line] of readFileSync(new URL(f, workflowsDir), 'utf8').split(/\r?\n/).entries()) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
        if (m && !m[1]!.startsWith('./') && !/@[0-9a-f]{40}$/.test(m[1]!)) offenders.push(`${f}:${i + 1} ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('has Dependabot watching the actions and the website packages', () => {
    const cfg = readFileSync(new URL('../dependabot.yml', workflowsDir), 'utf8');
    expect(cfg).toMatch(/package-ecosystem:\s*"?github-actions"?/);
    expect(cfg).toMatch(/package-ecosystem:\s*"?npm"?/);
  });
});

describe('ARETIA-SEC-008: the dependency-advisory gate', () => {
  const report = {
    vulnerabilities: {
      toml: { via: [{ source: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 'bad parse' }] },
      jayson: { via: ['stream-json', { url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'moderate', title: 'slow' }] },
    },
  };
  it('lists only high and critical advisories', () => {
    expect(highAdvisories(report).map((a: { id: string }) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });
  it('fails an advisory that is not accepted, and accepts one with a reason', () => {
    expect(gateProblems(report, { accepted: [] })).toHaveLength(1);
    expect(gateProblems(report, { accepted: [{ id: 'GHSA-aaaa-bbbb-cccc', reason: 'Not reachable: the site parses no TOML at all.' }] })).toEqual([]);
  });
  it('fails an accepted entry that has no real reason', () => {
    expect(gateProblems(report, { accepted: [{ id: 'GHSA-aaaa-bbbb-cccc', reason: 'ok' }] })).toHaveLength(1);
  });
  it('every entry of the committed allow-list names a GHSA id and gives a real reason', () => {
    const allow = JSON.parse(readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8')) as { accepted: { id: string; reason: string }[] };
    expect(allow.accepted.length).toBeGreaterThan(0);
    for (const a of allow.accepted) {
      expect(a.id).toMatch(/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
      expect(a.reason.length).toBeGreaterThan(40);
    }
  });
});
