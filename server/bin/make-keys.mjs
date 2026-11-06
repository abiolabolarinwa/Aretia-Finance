#!/usr/bin/env node
// Writes server/.env with fresh random secrets and a signed service_role key. Nothing is printed except where the file went.
//   node bin/make-keys.mjs                  create .env from .env.example (refuses to overwrite an existing .env)
//   node bin/make-keys.mjs --print-key      print only the service_role key from an existing .env (to paste into Vercel as SUPABASE_SERVICE_ROLE_KEY)
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const b64 = (b) => Buffer.from(b).toString('base64url');

/** HS256 JWT, the format PostgREST verifies. No expiry: the key is revoked by changing JWT_SECRET. */
export function signKey(secret, role) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ role, iss: 'aretia', iat: Math.floor(Date.now() / 1000) }));
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

function main() {
  if (process.argv.includes('--print-key')) {
    const m = /^SERVICE_ROLE_KEY=(.+)$/m.exec(readFileSync(envPath, 'utf8'));
    if (!m) throw new Error('no SERVICE_ROLE_KEY in .env');
    process.stdout.write(m[1] + '\n');
    return;
  }
  const rnd = (n) => randomBytes(n).toString('base64url');
  const jwt = rnd(48);
  const values = { POSTGRES_PASSWORD: rnd(24), AUTHENTICATOR_PASSWORD: rnd(24), JWT_SECRET: jwt, SERVICE_ROLE_KEY: signKey(jwt, 'service_role'), CRON_SECRET: '', MI_CRON_SECRET: '' };
  let text = readFileSync(join(root, '.env.example'), 'utf8');
  for (const [k, v] of Object.entries(values)) if (v) text = text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
  try {
    // 'wx': create only; never overwrites an existing .env (and no check-then-write gap).
    writeFileSync(envPath, text, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') throw new Error('.env already exists; not overwriting it (delete it first if you really want new secrets: that logs everyone out and needs a new key in Vercel).');
    throw e;
  }
  try { chmodSync(envPath, 0o600); } catch { /* not supported on this file system */ }
  console.log(`Wrote ${envPath} with new random secrets (file mode 600). Open it to fill in DATA_HOSTNAME and the other blanks.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
