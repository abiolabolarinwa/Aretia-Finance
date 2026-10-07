/**
 * Runs Aretia's real migration files on a real Postgres engine (PGlite: PostgreSQL compiled to WebAssembly) and
 * checks what they create. This proves the SQL is valid and does what it says; it does NOT prove anything about
 * Aretia's own Supabase project, which has not been touched.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { applyMigrations, checksumOf, loadMigrations, planMigrations, type SqlClient } from './migrate.js';

const dir = join(process.cwd(), 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));

const wrap = (db: PGlite): SqlClient => ({
  exec: async (sql) => {
    await db.exec(sql);
  },
  query: async (sql, params) => (await db.query(sql, params)).rows as Record<string, unknown>[],
});

// Starting the engine takes a few seconds, so one instance is shared and its public schema is emptied between tests.
vi.setConfig({ testTimeout: 60_000 });
let shared: PGlite | null = null;

/** An empty public schema, with the roles Supabase provides so the access checks mean something. */
async function fresh(): Promise<{ db: PGlite; sql: SqlClient }> {
  if (!shared) {
    shared = new PGlite();
    await shared.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  }
  await shared.exec('reset role; drop schema public cascade; create schema public;');
  return { db: shared, sql: wrap(shared) };
}

describe('migration files', () => {
  it('are numbered without gaps and have checksums', () => {
    const m = loadMigrations(files);
    expect(m.map((x) => x.name)).toEqual(['0001_token_registry.sql', '0002_swings_events.sql', '0003_shadow_events.sql']);
    expect(m[0]!.checksum).toBe(checksumOf(files[0]!.sql));
  });

  it('are refused when badly named, repeated, gapped or empty', () => {
    expect(() => loadMigrations([{ name: 'init.sql', sql: 'select 1' }])).toThrow(/NNNN_name/);
    expect(() => loadMigrations([{ name: '0001_a.sql', sql: 'select 1' }, { name: '0001_b.sql', sql: 'select 1' }])).toThrow(/without gaps/);
    expect(() => loadMigrations([{ name: '0002_a.sql', sql: 'select 1' }])).toThrow(/without gaps/);
    expect(() => loadMigrations([{ name: '0001_a.sql', sql: '  ' }])).toThrow(/empty/);
  });

  it('checksums ignore the line-ending style a checkout uses', () => {
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
  });
});

describe('the schema, on a real Postgres engine', () => {
  it('applies cleanly, in order, and records what it did', async () => {
    const { sql } = await fresh();
    const steps: string[] = [];
    const done = await applyMigrations(sql, loadMigrations(files), { onStep: (s) => steps.push(s) });
    expect(done).toEqual(['0001_token_registry.sql', '0002_swings_events.sql', '0003_shadow_events.sql']);
    expect(steps).toEqual(['Applied 0001_token_registry.sql', 'Applied 0002_swings_events.sql', 'Applied 0003_shadow_events.sql']);
    const rows = await sql.query('select name from public.aretia_schema_migrations order by name');
    expect(rows.map((r) => r.name)).toEqual(done);
    expect((await sql.query("select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('token_registry','discovery_cursors','swings_events')"))[0]!.n).toBe(3);
  });

  it('is safe to run again: a second run does nothing, and the SQL itself is re-runnable', async () => {
    const { db, sql } = await fresh();
    const m = loadMigrations(files);
    await applyMigrations(sql, m);
    expect(await applyMigrations(sql, m)).toEqual([]);
    for (const f of files) await db.exec(f.sql); // every statement uses "if not exists" or is idempotent
  });

  it('a dry run lists the work and changes nothing', async () => {
    const { sql } = await fresh();
    const steps: string[] = [];
    const done = await applyMigrations(sql, loadMigrations(files), { dryRun: true, onStep: (s) => steps.push(s) });
    expect(done).toHaveLength(3);
    expect(steps[0]).toMatch(/Would apply/);
    expect((await sql.query("select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'token_registry'"))[0]!.n).toBe(0);
  });

  it('refuses a file edited after it was applied, and a file added before an applied one', async () => {
    const { sql } = await fresh();
    await applyMigrations(sql, loadMigrations(files));
    const edited = loadMigrations(files.map((f, i) => (i === 0 ? { ...f, sql: f.sql + '\n-- edited' } : f)));
    await expect(planMigrations(sql, edited)).rejects.toThrow(/changed after it was applied/);
    await expect(planMigrations(sql, loadMigrations(files.slice(1, 2).map((f) => ({ ...f, name: '0001_other.sql' }))))).rejects.toThrow(/not in the folder/);
  });

  it('rolls a failing migration back completely and says which one failed', async () => {
    const { sql } = await fresh();
    const bad = loadMigrations([{ name: '0001_bad.sql', sql: 'create table public.half (id int); select * from public.does_not_exist;' }]);
    await expect(applyMigrations(sql, bad)).rejects.toThrow(/0001_bad.sql failed and was rolled back/);
    expect((await sql.query("select count(*)::int as n from information_schema.tables where table_name = 'half'"))[0]!.n).toBe(0);
    expect((await sql.query('select count(*)::int as n from public.aretia_schema_migrations'))[0]!.n).toBe(0);
  });
});

describe('what the tables enforce', () => {
  const valid = `insert into public.token_registry (key, chain, address, symbol, decimals, first_detected_at, discovery_source, discovery_status, metadata_confidence, updated_at)
    values ('solana:abc', 'solana', 'abc', 'TKN', 9, 1, 'test', 'discovered', 'onchain', 1)`;

  it('accepts a valid token and rejects a bad chain, status, confidence, decimals and a repeated token', async () => {
    const { db, sql } = await fresh();
    await applyMigrations(sql, loadMigrations(files));
    await db.exec(valid);
    await expect(db.exec(valid)).rejects.toThrow(/duplicate key/);
    await expect(db.exec(valid.replace("'solana:abc'", "'x:1'").replace("'solana', 'abc'", "'cardano', 'abc'"))).rejects.toThrow(/check constraint/);
    await expect(db.exec(valid.replace("'solana:abc'", "'x:2'").replace("'discovered'", "'endorsed'"))).rejects.toThrow(/check constraint/);
    await expect(db.exec(valid.replace("'solana:abc'", "'x:3'").replace("'onchain'", "'trusted'"))).rejects.toThrow(/check constraint/);
    await expect(db.exec(valid.replace("'solana:abc'", "'x:4'").replace(', 9,', ', 99,'))).rejects.toThrow(/check constraint/);
    // "verified" is Aretia's own curated flag: it starts false and discovery does not set it.
    expect((await sql.query("select verified from public.token_registry where key = 'solana:abc'"))[0]!.verified).toBe(false);
  });

  it('events carry no wallet, IP, amount or token, and only known names, chains and statuses', async () => {
    const { db, sql } = await fresh();
    await applyMigrations(sql, loadMigrations(files));
    const cols = (await sql.query("select column_name from information_schema.columns where table_name = 'swings_events' order by column_name")).map((r) => r.column_name);
    expect(cols).toEqual(['at', 'chain', 'count', 'diff_bps', 'id', 'ms', 'name', 'provider', 'rival', 'status']);
    await db.exec("insert into public.swings_events (at, name, chain, provider, status, ms, count) values (1, 'swap', 'base', 'aretia', 'confirmed', 120, 3)");
    await expect(db.exec("insert into public.swings_events (at, name) values (1, 'wallet_address_seen')")).rejects.toThrow(/check constraint/);
    await db.exec("insert into public.swings_events (at, name, chain, provider, rival, diff_bps) values (1, 'shadow', 'solana', 'aretia-sol', 'jupiter', -12), (2, 'shadow', 'solana', 'jupiter', 'aretia-sol', 4)");
    await expect(db.exec("insert into public.swings_events (at, name, diff_bps) values (1, 'shadow', 50000)")).rejects.toThrow(/check constraint/);
    const summary = await sql.query('select winner, comparisons::int as n, aretia_behind::int as behind, aretia_level_or_ahead::int as ahead from public.swings_shadow_summary order by winner');
    expect(summary).toEqual([{ winner: 'aretia-sol', n: 1, behind: 1, ahead: 0 }, { winner: 'jupiter', n: 1, behind: 0, ahead: 1 }]);
    await expect(db.exec("insert into public.swings_events (at, name, chain) values (1, 'swap', 'dogechain')")).rejects.toThrow(/check constraint/);
  });

  it('row level security is on for every table and no policy grants anything: the browser roles see nothing, the service role sees everything', async () => {
    const { db, sql } = await fresh();
    await applyMigrations(sql, loadMigrations(files));
    await db.exec(valid);
    const rls = await sql.query("select relname, relrowsecurity from pg_class where relname in ('token_registry','discovery_cursors','swings_events','aretia_schema_migrations') order by relname");
    expect(rls.map((r) => [r.relname, r.relrowsecurity])).toEqual([['aretia_schema_migrations', true], ['discovery_cursors', true], ['swings_events', true], ['token_registry', true]]);
    expect((await sql.query('select count(*)::int as n from pg_policies'))[0]!.n).toBe(0);
    // Supabase grants table privileges to these roles by default; row level security is what stops them.
    await db.exec('grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to anon, authenticated, service_role;');
    await db.exec('set role anon');
    expect((await db.query('select count(*)::int as n from public.token_registry')).rows[0]).toEqual({ n: 0 });
    await expect(db.exec(valid.replace("'solana:abc'", "'anon:1'"))).rejects.toThrow(/row-level security/);
    await db.exec('reset role; set role authenticated');
    expect((await db.query('select count(*)::int as n from public.token_registry')).rows[0]).toEqual({ n: 0 });
    await db.exec('reset role; set role service_role');
    expect((await db.query('select count(*)::int as n from public.token_registry')).rows[0]).toEqual({ n: 1 });
    await db.exec('reset role');
  });
});
