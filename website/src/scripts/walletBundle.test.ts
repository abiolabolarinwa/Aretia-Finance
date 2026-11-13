import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The first script of the wallet page (walletApp.ts) must stay small: the swap engine, the launch tools and Shield are large and are
 * downloaded after the first screen (or when first used), never with it. Importing one of them normally (not `import type`, not `import()`)
 * would put it back into the first download, so this guards the import lines.
 */
const source = readFileSync(resolve(__dirname, 'walletApp.ts'), 'utf8');
const staticImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]!);

describe('the wallet page first script', () => {
  it.each(['./walletSwings', './walletLaunchCluster', './walletShield', '../swings/live.js', '../swings/live'])('does not import %s with the first script', (name) => {
    expect(staticImports).not.toContain(name);
  });
  it('loads those parts with import() instead', () => {
    for (const name of ['./walletSwings', './walletLaunchCluster', './walletShield']) expect(source).toContain(`import('${name}')`);
  });
  it('does not start the launch tools with the first screen, only on use or when someone points at Launch', () => {
    expect(source).toMatch(/lazyApi<LaunchCluster>\([\s\S]*?\}, false\);/);
    expect(source).toContain("launchLoad.warm()");
  });
});
