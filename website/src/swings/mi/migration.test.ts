/**
 * Migration 0017 on a real Postgres engine (PGlite): the tables, the idempotence the indexer relies on, the two functions, and
 * that no ordinary role can read anything. This does NOT prove anything about Aretia's own Supabase project.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { applyMigrations, loadMigrations } from '../db/migrate.js';

vi.setConfig({ testTimeout: 90_000 });
const dir = join(process.cwd(), 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));

describe('migration 0017_market_indexer', () => {
  it('applies after the others and supports the indexer\'s idempotent writes, reorg cleanup and job claiming', async () => {
    const db = new PGlite();
    await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
    const client = { exec: async (s: string) => void (await db.exec(s)), query: async (s: string, p?: unknown[]) => (await db.query(s, p)).rows as Record<string, unknown>[] };
    expect(await applyMigrations(client, loadMigrations(files))).toContain('0017_market_indexer.sql');

    const pool = (key: string, block: number) => `insert into mi_pools (key,chain,address,adapter_id,dex,kind,base,quote,base_decimals,quote_decimals,base_is_token0,created_block,created_tx,created_at,state,state_at,updated_at) values ('${key}','bnb','${key.slice(4)}','a1','pancakeswap','v2','b','q',18,18,true,${block},'0xtx',1,'active',1,1) on conflict (key) do nothing`;
    await db.exec(pool('bnb:0xp1', 100));
    await db.exec(pool('bnb:0xp1', 100));
    await db.exec(pool('bnb:0xp2', 200));
    expect((await db.query('select count(*)::int as n from mi_pools')).rows[0]).toEqual({ n: 2 });

    const trade = (pool: string, id: string, block: number) => `insert into mi_trades (chain,pool,id,adapter_id,block,block_hash,time,side,base_amount,quote_amount,price,maker) values ('bnb','${pool}','${id}','a1',${block},'0xh',1,'buy','123456789012345678901234567890','1','0.5','0xm') on conflict do nothing`;
    for (const t of [trade('0xp1', 't1', 100), trade('0xp1', 't1', 100), trade('0xp2', 't2', 200), trade('0xp2', 't3', 250)]) await db.exec(t);
    expect((await db.query('select count(*)::int as n from mi_trades')).rows[0]).toEqual({ n: 3 });
    // A raw amount beyond 2^53 survives as text.
    expect((await db.query("select base_amount from mi_trades where id='t1'")).rows[0]).toEqual({ base_amount: '123456789012345678901234567890' });

    expect((await db.query("select public.mi_delete_pools_from('a1', 150) as n")).rows[0]).toEqual({ n: 1 });
    expect((await db.query('select pool from mi_trades order by id')).rows).toEqual([{ pool: '0xp1' }]);

    await db.exec("insert into mi_jobs (id,adapter_id,from_block,to_block,done_block,status,requested_by,requested_at) values ('j1','a1',1,9,0,'pending','w',1),('j2','a1',1,9,0,'pending','w',2)");
    const first = (await db.query<{ id: string; status: string }>('select * from public.mi_claim_job()')).rows;
    expect(first.map((r) => r.id)).toEqual(['j1']);
    expect(first[0]!.status).toBe('running');
    expect((await db.query<{ id: string }>('select * from public.mi_claim_job()')).rows.map((r) => r.id)).toEqual(['j2']);
    expect((await db.query('select * from public.mi_claim_job()')).rows).toEqual([]);

    // Row level security is on and no policy exists: ordinary roles see nothing and cannot write.
    await db.exec('grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to anon, authenticated, service_role;');
    await db.exec('set role anon');
    expect((await db.query('select count(*)::int as n from mi_pools')).rows[0]).toEqual({ n: 0 });
    await expect(db.exec("insert into mi_audit (at,actor,action,target) values (1,'x','y','z')")).rejects.toThrow();
    await db.exec('reset role; set role service_role');
    expect((await db.query('select count(*)::int as n from mi_pools')).rows[0]).toEqual({ n: 1 });
    await db.exec('reset role');
    await db.close();
  });
});
