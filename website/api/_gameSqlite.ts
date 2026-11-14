/**
 * For tests: a real SQLite database (Node's built-in engine, the same SQL dialect D1 runs) loaded with the game's actual D1 schema,
 * presented through the same small interface as a D1 binding. Not used by the deployed code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1Rest, type D1Like, type D1Statement } from './_d1Rest.js';
import type { Rest } from './_swingsAccount.js';

type SqlValue = string | number | bigint | null;

class Stmt implements D1Statement {
  private values: SqlValue[] = [];
  constructor(private readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: unknown[]): D1Statement {
    const next = new Stmt(this.db, this.sql);
    next.values = values.map((v) => (v === undefined ? null : (v as SqlValue)));
    return next;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }
  async run(): Promise<unknown> {
    return this.db.prepare(this.sql).run(...this.values);
  }
}

export function sqliteD1(): { db: D1Like; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('pragma foreign_keys = on');
  raw.exec(readFileSync(join(process.cwd(), 'd1', '0001_game.sql'), 'utf8'));
  const db: D1Like = {
    prepare: (sql) => new Stmt(raw, sql),
    async batch(statements) {
      raw.exec('begin');
      try {
        const out: unknown[] = [];
        for (const s of statements) out.push(await s.run());
        raw.exec('commit');
        return out;
      } catch (e) {
        raw.exec('rollback');
        throw e;
      }
    },
  };
  return { db, raw };
}

/** A fresh database with the game's schema, behind the same data interface the game code uses. */
export function sqliteRest(now: () => number = Date.now): { rest: Rest; raw: DatabaseSync } {
  const { db, raw } = sqliteD1();
  return { rest: d1Rest(db, { now }), raw };
}
