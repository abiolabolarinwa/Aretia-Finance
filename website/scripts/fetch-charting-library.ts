/**
 * Fetches TradingView's licensed Advanced Charts library into public/charting_library/ before a build.
 *
 * The library is TradingView's private, licensed code and may not be redistributed, and this repository is public, so
 * the files are never committed (public/charting_library/ is gitignored). Each build downloads the pinned release from
 * TradingView's private repository instead.
 *
 *   TRADINGVIEW_GITHUB_TOKEN   a GitHub token whose account TradingView granted access to tradingview/charting_library
 *                              (read-only is enough). Set it as a build variable on Vercel. On a developer machine
 *                              the signed-in `gh` account is used when this is not set.
 *
 * With no token, or if the download fails, the build still succeeds and the wallet falls back to an embedded chart.
 * Set TRADINGVIEW_REQUIRED=1 to make a missing library fail the build instead.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The release the wallet is built and tested against. Bump it deliberately; chart behaviour changes between releases. */
const VERSION = 'v32.2.0';
const REPO = 'tradingview/charting_library';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'charting_library');
const marker = join(target, 'charting_library.standalone.js');
const versionFile = join(target, '.aretia-version');

function token(): string | null {
  const env = process.env.TRADINGVIEW_GITHUB_TOKEN?.trim();
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function skip(reason: string): never {
  const message = `[charting-library] ${reason} The wallet will use its embedded fallback chart.`;
  if (process.env.TRADINGVIEW_REQUIRED === '1') {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

async function main(): Promise<void> {
  if (existsSync(marker) && existsSync(versionFile) && process.env.TRADINGVIEW_FORCE !== '1') {
    console.log(`[charting-library] already present, skipping download.`);
    return;
  }
  const t = token();
  if (!t) skip('No TRADINGVIEW_GITHUB_TOKEN and no signed-in `gh` account.');

  const tmp = mkdtempSync(join(tmpdir(), 'aretia-tv-'));
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/tarball/${VERSION}`, {
      headers: { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json', 'user-agent': 'aretia-finance-build' },
      redirect: 'follow',
    });
    if (!res.ok) skip(`GitHub answered ${res.status} for ${REPO}@${VERSION} (is the token's account approved by TradingView?).`);
    const archive = join(tmp, 'library.tgz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const out = join(tmp, 'src');
    mkdirSync(out);
    execFileSync('tar', ['-xzf', archive, '-C', out, '--strip-components=1'], { stdio: 'ignore' });
    if (!existsSync(join(out, 'charting_library', 'charting_library.standalone.js'))) skip('The download did not contain the expected files.');
    rmSync(target, { recursive: true, force: true });
    cpSync(join(out, 'charting_library'), target, { recursive: true });
    writeFileSync(versionFile, `${VERSION}\n`);
    console.log(`[charting-library] installed ${REPO}@${VERSION} into public/charting_library/`);
  } catch (e) {
    skip(`Could not fetch the library (${e instanceof Error ? e.message : String(e)}).`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
