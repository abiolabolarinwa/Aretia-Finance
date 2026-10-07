/**
 * The migration runner for Aretia's Supabase/Postgres schema (`supabase/migrations/*.sql`).
 *
 * It is deliberately small and strict:
 *  - migrations are numbered `NNNN_name.sql`, applied in order, each in its own transaction;
 *  - what was applied is recorded (name and checksum) in `public.aretia_schema_migrations`;
 *  - a file that changed after it was applied is refused (drift), never re-run or silently skipped;
 *  - one runner at a time (a Postgres advisory lock);
 *  - `dryRun` lists what would run and touches nothing.
 *
 * This file has no imports from the rest of the app so the command line (`scripts/apply-migrations.ts`) can run it
 * directly. It is exercised in `migrate.test.ts` against a real Postgres engine (PGlite), but it has NOT been run
 * against Aretia's own Supabase project: that needs the project's database URL, which only its owner holds.
 */
import { createHash } from 'node:crypto';

/** What the runner needs from a database connection. */
export interface SqlClient {
  /** Runs one or more statements with no parameters. */
  exec(sql: string): Promise<void>;
  /** Runs one statement with parameters and returns its rows. */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface Migration {
  name: string;
  sql: string;
  /** SHA-256 of the file's text, lower-case hex. */
  checksum: string;
}

export interface MigrationPlan {
  applied: string[];
  pending: Migration[];
}

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const TABLE = 'public.aretia_schema_migrations';
/** Arbitrary constant: "ARETIA" on a phone keypad is not the point, it only has to be the same for every runner. */
const LOCK_KEY = 727_274_001;

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Validates file names and returns the migrations in order. Throws on a bad name, a duplicate number or a gap. */
export function loadMigrations(files: { name: string; sql: string }[]): Migration[] {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: Migration[] = [];
  let expected = 1;
  for (const f of sorted) {
    const m = NAME.exec(f.name);
    if (!m) throw new Error(`Migration file "${f.name}" is not named NNNN_name.sql.`);
    const n = Number(m[1]);
    if (n !== expected) throw new Error(`Migration numbers must run 0001, 0002, ... without gaps or repeats; found ${f.name} where ${String(expected).padStart(4, '0')} was expected.`);
    if (f.sql.trim() === '') throw new Error(`Migration ${f.name} is empty.`);
    expected++;
    out.push({ name: f.name, sql: f.sql, checksum: checksumOf(f.sql) });
  }
  return out;
}

async function ensureTable(db: SqlClient): Promise<void> {
  await db.exec(`create table if not exists ${TABLE} (name text primary key, checksum text not null, applied_at timestamptz not null default now()); alter table ${TABLE} enable row level security;`);
}

/** What has been applied and what is pending. Throws if an applied file has changed or an applied one is missing. */
export async function planMigrations(db: SqlClient, migrations: Migration[]): Promise<MigrationPlan> {
  await ensureTable(db);
  const rows = await db.query(`select name, checksum from ${TABLE} order by name`);
  const applied = rows.map((r) => ({ name: String(r.name), checksum: String(r.checksum) }));
  const byName = new Map(migrations.map((m) => [m.name, m]));
  for (const a of applied) {
    const file = byName.get(a.name);
    if (!file) throw new Error(`The database has migration ${a.name} applied, but that file is not in the folder.`);
    if (file.checksum !== a.checksum) throw new Error(`Migration ${a.name} was changed after it was applied. Add a new migration instead of editing an applied one.`);
  }
  const done = new Set(applied.map((a) => a.name));
  // An applied migration must be a prefix of the list: a pending file older than an applied one means files were added out of order.
  const firstPending = migrations.findIndex((m) => !done.has(m.name));
  if (firstPending >= 0 && migrations.slice(firstPending).some((m) => done.has(m.name))) throw new Error('A migration was added before one that is already applied. Number new migrations after the last one.');
  return { applied: applied.map((a) => a.name), pending: migrations.filter((m) => !done.has(m.name)) };
}

export interface ApplyOptions {
  dryRun?: boolean;
  onStep?: (message: string) => void;
}

/** Applies every pending migration in order. Returns the names applied (or, for a dry run, that would be). */
export async function applyMigrations(db: SqlClient, migrations: Migration[], options: ApplyOptions = {}): Promise<string[]> {
  const say = options.onStep ?? (() => {});
  await db.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    const plan = await planMigrations(db, migrations);
    if (plan.pending.length === 0) {
      say('Nothing to apply: the database is up to date.');
      return [];
    }
    const done: string[] = [];
    for (const m of plan.pending) {
      if (options.dryRun) {
        say(`Would apply ${m.name}`);
        done.push(m.name);
        continue;
      }
      await db.exec('begin');
      try {
        await db.exec(m.sql);
        await db.query(`insert into ${TABLE} (name, checksum) values ($1, $2)`, [m.name, m.checksum]);
        await db.exec('commit');
      } catch (e) {
        await db.exec('rollback');
        throw new Error(`Migration ${m.name} failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      say(`Applied ${m.name}`);
      done.push(m.name);
    }
    return done;
  } finally {
    await db.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
