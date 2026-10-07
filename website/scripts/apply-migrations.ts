/**
 * Applies the Supabase migrations to a Postgres database.
 *
 *   SUPABASE_DB_URL=postgresql://... npm run db:migrate            apply everything pending
 *   SUPABASE_DB_URL=postgresql://... npm run db:migrate -- --dry-run   list what would run, change nothing
 *
 * The URL is Supabase's "connection string" (Project settings > Database), read from the environment only. It is
 * never printed, logged or written anywhere. Run it from your own machine or a CI secret; the app itself never does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations, loadMigrations, type SqlClient } from '../src/swings/db/migrate.ts';

const url = process.env.SUPABASE_DB_URL?.trim();
if (!url) {
  console.error('SUPABASE_DB_URL is not set. Nothing was changed.');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const migrations = loadMigrations(readdirSync(dir).filter((f) => f.endsWith('.sql')).map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));

const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true } });
const db: SqlClient = {
  exec: async (sql) => {
    await client.query(sql);
  },
  query: async (sql, params) => (await client.query(sql, params)).rows as Record<string, unknown>[],
};

try {
  await client.connect();
  const done = await applyMigrations(db, migrations, { dryRun, onStep: (m) => console.log(m) });
  console.log(dryRun ? `Dry run: ${done.length} migration(s) would be applied.` : `Done: ${done.length} migration(s) applied.`);
} catch (e) {
  // Never echo the connection string, even if a driver error includes it.
  const message = (e instanceof Error ? e.message : String(e)).split(url).join('[connection string]');
  console.error(`Failed: ${message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
