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
    expect(m.map((x) => x.name)).toEqual(['0001_token_registry.sql', '0002_swings_events.sql', '0003_shadow_events.sql', '0004_more_chains.sql', '0005_swings_records.sql', '0006_token_market.sql', '0007_pool_ticks.sql', '0008_user_data.sql', '0009_robinhood_chain.sql', '0010_notifications.sql', '0011_referrals.sql', '0012_launchbox.sql', '0013_referral_tx_case.sql', '0014_auth_nonces_and_pruning.sql', '0015_launchbox_listing.sql', '0016_admin_counters.sql', '0017_market_indexer.sql']);
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
    expect(done).toEqual(['0001_token_registry.sql', '0002_swings_events.sql', '0003_shadow_events.sql', '0004_more_chains.sql', '0005_swings_records.sql', '0006_token_market.sql', '0007_pool_ticks.sql', '0008_user_data.sql', '0009_robinhood_chain.sql', '0010_notifications.sql', '0011_referrals.sql', '0012_launchbox.sql', '0013_referral_tx_case.sql', '0014_auth_nonces_and_pruning.sql', '0015_launchbox_listing.sql', '0016_admin_counters.sql', '0017_market_indexer.sql']);
    expect(steps).toEqual(['Applied 0001_token_registry.sql', 'Applied 0002_swings_events.sql', 'Applied 0003_shadow_events.sql', 'Applied 0004_more_chains.sql', 'Applied 0005_swings_records.sql', 'Applied 0006_token_market.sql', 'Applied 0007_pool_ticks.sql', 'Applied 0008_user_data.sql', 'Applied 0009_robinhood_chain.sql', 'Applied 0010_notifications.sql', 'Applied 0011_referrals.sql', 'Applied 0012_launchbox.sql', 'Applied 0013_referral_tx_case.sql', 'Applied 0014_auth_nonces_and_pruning.sql', 'Applied 0015_launchbox_listing.sql', 'Applied 0016_admin_counters.sql', 'Applied 0017_market_indexer.sql']);
    const rows = await sql.query('select name from public.aretia_schema_migrations order by name');
    expect(rows.map((r) => r.name)).toEqual(done);
    expect((await sql.query("select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('token_registry','discovery_cursors','swings_events')"))[0]!.n).toBe(3);
    expect((await sql.query("select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('launchbox_tokens','launchbox_cursors')"))[0]!.n).toBe(2);
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
    expect(done).toHaveLength(17);
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

describe('audit migrations (2026-10 review)', () => {
  it('M-1: 0013 merges EVM case copies (keeping the earliest credited row), lower-cases, and then refuses upper case; Solana untouched', async () => {
    const { db, sql } = await fresh();
    const all = loadMigrations(files);
    await applyMigrations(sql, all.filter((m) => m.name < '0013'));
    const h = 'ab'.repeat(32);
    const row = (chain: string, tx: string, status: string, created: number) => `('${chain}', '${tx}', 'asset1', 'evm:t', 'evm:r', '10', '2', '${status}', 1, ${created})`;
    await db.exec(`insert into public.referral_credits (chain, tx, asset, trader, referrer, fee_raw, share_raw, status, tx_at, created_at) values
      ${row('ethereum', '0x' + h.toUpperCase(), 'flagged', 1)}, ${row('ethereum', '0x' + h, 'credited', 3)}, ${row('ethereum', '0xAb' + h.slice(2), 'credited', 2)},
      ${row('solana', 'Sig' + 'A'.repeat(60), 'credited', 1)}, ${row('solana', 'Sig' + 'a'.repeat(60), 'credited', 1)}`);
    await applyMigrations(sql, all);
    const left = await sql.query("select chain, tx, status, created_at from public.referral_credits order by chain, created_at");
    expect(left.filter((r) => r.chain === 'ethereum')).toEqual([{ chain: 'ethereum', tx: '0x' + h, status: 'credited', created_at: 2 }]);
    expect(left.filter((r) => r.chain === 'solana')).toHaveLength(2);
    await expect(db.exec(`insert into public.referral_credits (chain, tx, asset, trader, referrer, fee_raw, share_raw, status, tx_at, created_at) values ${row('base', '0x' + h.toUpperCase(), 'credited', 9)}`)).rejects.toThrow();
  });

  it('0015: Launch Box listing state; old Solana rows with nothing minted become pending; safe to run twice', async () => {
    const { db, sql } = await fresh();
    const all = loadMigrations(files);
    await applyMigrations(sql, all.filter((m) => m.name < '0015'));
    const row = (addr: string, chain: string, supply: string | null) => `('${chain}:${addr}', '${chain}', '${addr}', ${supply === null ? 'null' : `'${supply}'`}, 'solana-fee', 1)`;
    const a = 'A'.repeat(43);
    const b = 'B'.repeat(43);
    const e = '0x' + 'e'.repeat(40);
    await db.exec(`insert into public.launchbox_tokens (key, chain, address, supply, source, indexed_at) values ${row(a, 'solana', '0')}, ${row(b, 'solana', '1000')}, ${row(e, 'bnb', null).replace("'solana-fee'", "'factory'")}`);
    const migration = all.find((m) => m.name === '0015_launchbox_listing.sql')!;
    await applyMigrations(sql, all);
    // Run the same file again by hand: nothing fails and nothing changes.
    await db.exec(migration.sql);
    const rows = await sql.query('select address, pending, hidden_at, fail_count, checked_at from public.launchbox_tokens order by address');
    expect(rows.map((r) => [r.address, r.pending])).toEqual([[e, false], [a, true], [b, false]]);
    expect(rows.every((r) => r.hidden_at === null && r.fail_count === 0 && r.checked_at === null)).toBe(true);
    // The public list's filter: on Solana nothing is shown before a check.
    const pub = "select address from public.launchbox_tokens where not pending and hidden_at is null and (chain <> 'solana' or checked_at is not null) order by address";
    expect((await sql.query(pub)).map((r) => r.address)).toEqual([e]);
    await db.exec(`update public.launchbox_tokens set checked_at = 5 where address = '${b}'`);
    expect((await sql.query(pub)).map((r) => r.address)).toEqual([e, b]);
    await expect(db.exec(`update public.launchbox_tokens set fail_count = -1 where address = '${b}'`)).rejects.toThrow(/check constraint/);
  });

  it('0014: nonces are single-use by a conditional update, and pruning removes what is old', async () => {
    const { db, sql } = await fresh();
    await applyMigrations(sql, loadMigrations(files));
    await db.exec("insert into public.auth_nonces (nonce, created_at, expires_at) values ('" + 'a'.repeat(32) + "', 1, 1000)");
    const use = "update public.auth_nonces set used_at = 5, owner = 'evm:0x" + '1'.repeat(40) + "' where nonce = '" + 'a'.repeat(32) + "' and used_at is null and expires_at > 5 returning nonce";
    expect(await sql.query(use)).toHaveLength(1);
    expect(await sql.query(use)).toHaveLength(0);
    await db.exec("insert into public.tracked_pools (chain, pool, last_seen) values ('solana', 'old', 1), ('solana', 'new', 999999999999)");
    await db.exec('select public.aretia_prune(1000000000000)');
    expect((await sql.query('select pool from public.tracked_pools')).map((r) => r.pool)).toEqual(['new']);
    expect(await sql.query('select nonce from public.auth_nonces')).toHaveLength(0);
  });
});

describe('what the tables enforce', () => {
  const valid = `insert into public.token_registry (key, chain, address, symbol, decimals, first_detected_at, discovery_source, discovery_status, metadata_confidence, updated_at)
    values ('solana:abc', 'solana', 'abc', 'TKN', 9, 1, 'test', 'discovered', 'onchain', 1)`;

  it('accepts a valid token and rejects a bad chain, status, confidence, decimals and a repeated token', async () => {
    const { db, sql } = await fresh();
    await applyMigrations(sql, loadMigrations(files));
    await db.exec(valid);
    await db.exec(valid.replace("'solana:abc'", "'arbitrum:abc'").replace("'solana', 'abc'", "'arbitrum', 'abc'"));
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
    await db.exec("insert into public.swings_events (at, name, chain) values (1, 'swap', 'arbitrum'), (2, 'swap', 'optimism'), (3, 'swap', 'avalanche')");
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
