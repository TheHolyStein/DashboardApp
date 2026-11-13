import type BetterSqlite3 from 'better-sqlite3';
import { DashError, type ModuleDb, type ModuleId } from '@dash/contract';
import { assertReadScope, assertWriteScope, isWord, tokenize } from '../migrate.js';

const STATEMENT_KEYWORDS = ['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'];

/** Throws unless `sql` is one SELECT/INSERT/UPDATE/DELETE/REPLACE statement touching only the module's tables. */
export function assertStatementScope(moduleId: ModuleId, sql: string): void {
  const fail = (why: string): never => {
    throw new DashError('forbidden', `db statement of module ${moduleId}: ${why}`, { moduleId });
  };
  const toks = tokenize(sql, fail);
  const last = toks[toks.length - 1];
  if (last?.kind === 'punct' && last.value === ';') toks.pop();
  if (toks.some((t) => t.kind === 'punct' && t.value === ';')) fail('only one statement per call');
  if (!isWord(toks[0], ...STATEMENT_KEYWORDS)) fail('only SELECT, INSERT, UPDATE, DELETE and REPLACE are allowed');
  assertWriteScope(moduleId, toks, fail);
  assertReadScope(moduleId, toks, fail);
}

/** A ModuleDb over the real database that checks every statement against the module's table prefix. */
export function createModuleDb(db: BetterSqlite3.Database, moduleId: ModuleId): ModuleDb {
  const prepare = (sql: string): BetterSqlite3.Statement => {
    assertStatementScope(moduleId, sql);
    return db.prepare(sql);
  };
  return {
    run: (sql, params = []) => ({ changes: prepare(sql).run(...params).changes }),
    all: <T>(sql: string, params: unknown[] = []) => prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: unknown[] = []) => prepare(sql).get(...params) as T | undefined,
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
  };
}
