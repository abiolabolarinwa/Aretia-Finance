/**
 * Guards for the self-hosted data server kit in ../server: the public allow-list matches the migrations, the compose file exposes
 * only what it should, the key generator signs what PostgREST verifies, and the backup script's keep-14/keep-8 logic works
 * (run against stand-ins for docker, age and rclone: no real Docker, Postgres or cloud drive is touched here).
 */
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { signKey } from '../../server/bin/make-keys.mjs';

const server = resolve(__dirname, '../../server');
const migrationsDir = resolve(__dirname, '../supabase/migrations');
const sql = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');
const caddy = readFileSync(join(server, 'caddy/Caddyfile'), 'utf8');
const compose = readFileSync(join(server, 'docker-compose.yml'), 'utf8');

const names = (re: RegExp): string[] => [...sql.matchAll(re)].map((m) => m[1]!).sort();
const listed = (label: string): string[] => {
  const m = new RegExp(`path_regexp ${label} \\^/rest/v1/(?:rpc/)?\\(([^)]*)\\)\\$`).exec(caddy);
  return (m?.[1] ?? '').split('|').sort();
};

describe('server/caddy/Caddyfile', () => {
  it('lists exactly the tables and views the migrations create (so none is forgotten and none is invented)', () => {
    const tables = names(/create table if not exists public\.([a-z_0-9]+)/gi).filter((t) => t !== 'aretia_schema_migrations');
    const views = names(/create or replace view public\.([a-z_0-9]+)/gi);
    expect(listed('data')).toEqual([...new Set([...tables, ...views])].sort());
  });
  it('lists exactly the functions the migrations create', () => {
    expect(listed('rpc')).toEqual([...new Set(names(/create or replace function public\.([a-z_0-9]+)/gi))].sort());
  });
  it('keeps a request-size limit, a per-address rate limit and a 404 for everything else', () => {
    expect(caddy).toMatch(/request_body\s*\{\s*max_size/);
    expect(caddy).toContain('rate_limit');
    expect(caddy).toMatch(/handle \{\s*respond 404/);
    expect(caddy).not.toContain('storage/v1');
  });
});

describe('server/docker-compose.yml', () => {
  it('publishes only 80 and 443 to the world, and Postgres on 127.0.0.1', () => {
    const ports = [...compose.matchAll(/^\s+- "([^"]+:\d+:\d+|\d+:\d+)"/gm)].map((m) => m[1]);
    expect(ports.sort()).toEqual(['127.0.0.1:5432:5432', '443:443', '80:80']);
  });
  it('has no secrets in it: every credential is read from the environment', () => {
    for (const k of ['POSTGRES_PASSWORD', 'AUTHENTICATOR_PASSWORD', 'JWT_SECRET']) expect(compose).toMatch(new RegExp(`${k}[^\\n]*\\$\\{${k}`));
    expect(compose).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe('server/bin/make-keys.mjs', () => {
  it('signs an HS256 token whose signature verifies with the secret and which carries the role', () => {
    const token = signKey('secret-for-test', 'service_role') as string;
    const [h, b, s] = token.split('.');
    expect(token.startsWith('eyJ')).toBe(true); // the site sends a key that starts with eyJ as both apikey and Bearer
    expect(JSON.parse(Buffer.from(b!, 'base64url').toString()).role).toBe('service_role');
    expect(createHmac('sha256', 'secret-for-test').update(`${h}.${b}`).digest('base64url')).toBe(s);
  });
});

const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
describe.skipIf(bash.status !== 0)('server/bin/backup.sh (with stand-ins for docker, age and rclone)', () => {
  it('uploads an encrypted dump and keeps 14 daily and 8 weekly files', () => {
    const root = mkdtempSync(join(tmpdir(), 'aretia-kit-'));
    const posix = (p: string): string => p.replace(/\\/g, '/');
    const srv = join(root, 'server');
    mkdirSync(join(srv, 'bin'), { recursive: true });
    for (const f of ['lib.sh', 'backup.sh']) copyFileSync(join(server, 'bin', f), join(srv, 'bin', f));
    writeFileSync(join(srv, 'docker-compose.yml'), '');
    const remote = join(root, 'remote');
    mkdirSync(join(remote, 'daily'), { recursive: true });
    mkdirSync(join(remote, 'weekly'), { recursive: true });
    for (let i = 1; i <= 20; i++) writeFileSync(join(remote, 'daily', `aretia-202601${String(i).padStart(2, '0')}T023000Z.dump.age`), 'x');
    for (let i = 1; i <= 9; i++) writeFileSync(join(remote, 'weekly', `aretia-202601${String(i).padStart(2, '0')}T023000Z.dump.age`), 'x');
    writeFileSync(join(srv, '.env'), `AGE_RECIPIENT=age1test\nRCLONE_REMOTE=${posix(remote)}\nKEEP_DAILY=14\nKEEP_WEEKLY=8\n`);
    const shims = join(root, 'shims');
    mkdirSync(shims);
    const shim = (name: string, body: string): string => {
      const p = join(shims, name);
      writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(p, 0o755);
      return posix(p);
    };
    // docker compose -f X exec -T postgres <tool> ...: pg_dump prints a big blob; pg_restore --list reads stdin and succeeds.
    const docker = shim('docker', 'case "$*" in *pg_dump*) head -c 4000 /dev/zero | tr "\\0" "d";; *pg_restore*) cat > /dev/null;; esac');
    const age = shim('age', 'while [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift 2;; -r) shift 2;; *) i="$1"; shift;; esac; done; cp "$i" "$o"');
    const rclone = shim(
      'rclone',
      'cmd="$1"; shift\ncase "$cmd" in\n copyto) mkdir -p "$(dirname "$2")"; cp "$1" "$2";;\n lsf) ls -1 "$1" 2>/dev/null;;\n deletefile) rm -f "$1";;\nesac',
    );
    const r = spawnSync('bash', [posix(join(srv, 'bin/backup.sh'))], {
      encoding: 'utf8',
      env: { ...process.env, DOCKER: docker, AGE: age, RCLONE: rclone, BACKUP_DIR: posix(join(root, 'local')), SKIP_ENV_MODE_CHECK: '1', FORCE_WEEKLY: '1' },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const daily = readdirSync(join(remote, 'daily')).sort();
    const weekly = readdirSync(join(remote, 'weekly')).sort();
    expect(daily).toHaveLength(14);
    expect(weekly).toHaveLength(8);
    expect(daily.at(-1)).toMatch(/^aretia-\d{8}T\d{6}Z\.dump\.age$/); // today's file is the newest
    expect(daily).not.toContain('aretia-20260101T023000Z.dump.age'); // the oldest went
    expect(existsSync(join(root, 'local'))).toBe(true);
    expect(readdirSync(join(root, 'local')).filter((f) => f.startsWith('.aretia-'))).toEqual([]); // no unencrypted dump is left behind
  });
});
