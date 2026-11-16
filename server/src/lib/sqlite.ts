import { DatabaseSync } from 'node:sqlite';

/**
 * Thin compatibility layer over Node's built-in SQLite.
 *
 * The upstream project used better-sqlite3, which needs a full MSVC toolchain to
 * install on Windows and a rebuild for every Node ABI. Node's built-in
 * `node:sqlite` is the same engine with no native build step, so the app installs
 * on any machine with Node 24 - which is what makes running the same server on
 * several computers practical.
 *
 * Only the surface the app actually uses is implemented: prepare/run/get/all,
 * exec, pragma and transaction (with savepoints for nesting).
 */

export type BindValue = null | number | bigint | string | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  get(...params: BindValue[]): unknown;
  all(...params: BindValue[]): unknown[];
  run(...params: BindValue[]): RunResult;
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(text: string): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): void;
  raw: DatabaseSync;
}

function wrapStatement(stmt: {
  get(...params: BindValue[]): unknown;
  all(...params: BindValue[]): unknown[];
  run(...params: BindValue[]): RunResult;
}): Statement {
  return {
    get: (...params) => stmt.get(...params),
    all: (...params) => stmt.all(...params),
    run: (...params) => stmt.run(...params),
  };
}

export function openDatabase(file: string): Database {
  const raw = new DatabaseSync(file);
  let savepointDepth = 0;

  const db: Database = {
    raw,
    prepare(sql: string) {
      return wrapStatement(raw.prepare(sql));
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    pragma(text: string) {
      // PRAGMA statements that return a value are read back for the caller.
      try {
        const rows = raw.prepare(`PRAGMA ${text}`).all();
        return rows[0] ?? null;
      } catch {
        raw.exec(`PRAGMA ${text}`);
        return null;
      }
    },
    transaction<A extends unknown[], R>(fn: (...args: A) => R) {
      return (...args: A): R => {
        const depth = savepointDepth++;
        const name = `hive_sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
        try {
          const result = fn(...args);
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
          return result;
        } catch (err) {
          try {
            raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
          } catch {
            /* the outer transaction is already gone */
          }
          throw err;
        } finally {
          savepointDepth = depth;
        }
      };
    },
    close() {
      raw.close();
    },
  };

  return db;
}
