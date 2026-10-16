// SQLite access for the Node server. Implements the slice of the Cloudflare
// D1 API the app uses — prepare/bind/first/all/run and batch — on top of the
// built-in node:sqlite module, so the route code needed no changes when the
// site moved off Workers.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// D1 accepted booleans and undefined as bound values; node:sqlite does not
function sqlValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

class Statement {
  #db;
  #sql;
  #params;

  constructor(db, sql, params = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  // Returns a new statement, like D1's bind(); the original stays reusable
  bind(...params) {
    return new Statement(this.#db, this.#sql, params.map(sqlValue));
  }

  // Synchronous internals, used by batch() and the migration/seed scripts
  allSync() {
    return this.#db.prepared(this.#sql).all(...this.#params);
  }

  firstSync() {
    return this.allSync()[0] ?? null;
  }

  runSync() {
    const info = this.#db.prepared(this.#sql).run(...this.#params);
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }

  // D1-style, async API used by the app code
  async first() {
    return this.firstSync();
  }

  async all() {
    return { results: this.allSync(), success: true };
  }

  async run() {
    return this.runSync();
  }
}

export class Db {
  #statements = new Map();

  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.sqlite.exec('PRAGMA synchronous = NORMAL');
    this.sqlite.exec('PRAGMA busy_timeout = 5000');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  // Compiled statements are cached: crawl loops bind the same SQL hundreds of
  // times. SQLite recompiles them automatically if the schema changes.
  prepared(sql) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.sqlite.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  // Runs one or more statements, no results
  exec(sql) {
    this.sqlite.exec(sql);
  }

  // D1 batch: all statements in one transaction. Statements that return rows
  // (SELECT, INSERT … RETURNING) yield { results }; the app only reads those.
  async batch(statements) {
    if (!statements.length) return [];
    const results = [];
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of statements) {
        results.push({ results: statement.allSync(), success: true });
      }
      this.sqlite.exec('COMMIT');
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
    return results;
  }

  close() {
    this.sqlite.close();
  }
}
