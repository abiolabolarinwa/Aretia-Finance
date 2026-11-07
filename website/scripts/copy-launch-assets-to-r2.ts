/**
 * Copies every Launch picture and details file from the old Supabase Storage bucket to the Cloudflare R2 bucket, same paths.
 * Run it on your own machine (Node 22 or newer). Safe to run again: a file already in R2 with the same size is skipped, so an
 * interrupted run simply continues. Nothing is ever deleted, in either place. See docs/R2_LAUNCH_ASSETS.md.
 *
 *   OLD_STORAGE_URL=https://<project>.supabase.co  OLD_STORAGE_SERVICE_KEY=...  [OLD_BUCKET=launch-assets]
 *   R2_ACCOUNT_ID=...  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  R2_BUCKET=...
 *   node scripts/copy-launch-assets-to-r2.ts [--dry-run]
 *
 * Values come from the environment only. They are never printed or written anywhere; the output is counts, plus the path of a file
 * that failed. Paths are only hashes and addresses, never secrets.
 */
import { presignUrl } from '../src/swings/launchmeta/r2sign.ts';

const env = (name: string): string => (process.env[name] ?? '').trim();
const missing = ['OLD_STORAGE_URL', 'OLD_STORAGE_SERVICE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((n) => !env(n));
if (missing.length > 0) {
  console.error(`These are not set: ${missing.join(', ')}. Nothing was changed.`);
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');
const oldBase = env('OLD_STORAGE_URL').replace(/\/+$/, '').replace(/\/storage\/v1.*$/, '');
const oldKey = env('OLD_STORAGE_SERVICE_KEY');
const oldBucket = env('OLD_BUCKET') || 'launch-assets';
const r2Host = `${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
const r2Bucket = env('R2_BUCKET');

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', json: 'application/json' };
/** The paths Aretia's Launch page ever writes (src/swings/launchmeta/core.ts). Anything else in the bucket is counted and left alone. */
const LAYOUT = /^(img\/[0-9a-f]{64}\.(png|jpg|gif)|meta\/[0-9a-f]{64}\.json|evm\/[a-z]+\/0x[0-9a-fA-F]{40}\.json)$/;

const authHeaders = { authorization: `Bearer ${oldKey}`, apikey: oldKey };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(500 * 2 ** i);
    }
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : 'failed'}`);
}

interface Entry {
  name: string;
  id: string | null;
}
/** Every file path under `prefix`, walking folders (Supabase lists a folder as an entry with no id). */
async function* walk(prefix: string): AsyncGenerator<string> {
  for (let offset = 0; ; offset += 100) {
    const entries = await retry('list', async () => {
      const res = await fetch(`${oldBase}/storage/v1/object/list/${encodeURIComponent(oldBucket)}`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the old bucket answered ${res.status}`);
      return (await res.json()) as Entry[];
    });
    for (const e of entries) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) yield* walk(path);
      else yield path;
    }
    if (entries.length < 100) return;
  }
}

const r2Url = (method: 'GET' | 'PUT' | 'HEAD', path: string, headers?: Record<string, string>) =>
  presignUrl({ method, host: r2Host, path: `/${r2Bucket}/${path}`, region: 'auto', service: 's3', accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY'), expires: 600, now: new Date(), signedHeaders: headers });

/** The size of the object already in R2, or null when it is not there. */
async function r2Size(path: string): Promise<number | null> {
  return retry('check', async () => {
    const res = await fetch(await r2Url('HEAD', path), { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 answered ${res.status}`);
    return Number(res.headers.get('content-length'));
  });
}

const counts = { found: 0, copied: 0, alreadyThere: 0, unexpected: 0, failed: 0 };
const failures: string[] = [];

for await (const path of walk('')) {
  counts.found++;
  const type = TYPES[path.split('.').pop() ?? ''];
  if (!LAYOUT.test(path) || !type) {
    counts.unexpected++;
    continue;
  }
  try {
    const res = await retry('download', async () => {
      const r = await fetch(`${oldBase}/storage/v1/object/${encodeURIComponent(oldBucket)}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: authHeaders, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`the old bucket answered ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    if (res.length === 0 || res.length > MAX_BYTES) {
      counts.unexpected++;
      continue;
    }
    if ((await r2Size(path)) === res.length) {
      counts.alreadyThere++;
      continue;
    }
    if (!dryRun) {
      await retry('upload', async () => {
        const put = await fetch(await r2Url('PUT', path, { 'content-type': type, 'content-length': String(res.length) }), { method: 'PUT', headers: { 'content-type': type }, body: res, signal: AbortSignal.timeout(120_000) });
        if (!put.ok) throw new Error(`R2 answered ${put.status}`);
      });
    }
    counts.copied++;
  } catch (e) {
    counts.failed++;
    failures.push(`${path} (${e instanceof Error ? e.message : 'failed'})`);
  }
}

console.log(`${dryRun ? 'DRY RUN, nothing written. ' : ''}Files found in the old bucket: ${counts.found}`);
console.log(`  ${dryRun ? 'would copy' : 'copied now'}: ${counts.copied}`);
console.log(`  already in R2 (skipped): ${counts.alreadyThere}`);
console.log(`  not an Aretia Launch file (left alone): ${counts.unexpected}`);
console.log(`  failed: ${counts.failed}`);
for (const f of failures) console.log(`    ${f}`);
if (counts.failed > 0) {
  console.log('Run the same command again: files already copied are skipped.');
  process.exit(1);
}
