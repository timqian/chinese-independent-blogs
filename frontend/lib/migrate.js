// Applies migrations/*.sql in order, remembering them in a _migrations table.
// Replaces `wrangler d1 migrations apply` (local and remote).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, '../migrations');

export function migrate(db, { dir = MIGRATIONS_DIR, log = console } = {}) {
  const existed = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").firstSync(),
  );
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT name FROM _migrations').allSync().map((r) => r.name));

  // A database imported from the previous Cloudflare D1 deployment already has
  // the schema but no _migrations table: treat everything as applied.
  if (!existed && applied.size === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blogs'").firstSync()) {
    const now = Math.floor(Date.now() / 1000);
    for (const file of files) db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').bind(file, now).runSync();
    log.log('existing database imported: all migrations marked as applied');
    return [];
  }

  const pending = files.filter((file) => !applied.has(file));
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').bind(file, Math.floor(Date.now() / 1000)).runSync();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    }
    log.log(`applied ${file}`);
  }
  return pending;
}
