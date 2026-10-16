// Run SQL against the configured database without needing the sqlite3 CLI:
//   npm run db:sql -- "SELECT COUNT(*) FROM posts"
//   npm run db:sql -- "UPDATE users SET is_admin = 1 WHERE username = 'admin'"
import { Db } from '../lib/db.js';
import { config, loadEnvFile } from '../lib/env.js';

loadEnvFile();
const env = config();
const sql = process.argv.slice(2).join(' ').trim();
if (!sql) {
  console.error('usage: npm run db:sql -- "<sql>"');
  process.exit(1);
}

const db = new Db(env.DB_PATH);
try {
  // Statements that return rows (SELECT, RETURNING, PRAGMA) print them; writes
  // report the number of changed rows.
  const statement = db.sqlite.prepare(sql);
  if (statement.columns().length) {
    console.table(statement.all());
  } else {
    const info = statement.run();
    console.log(`ok: ${info.changes} row(s) changed`);
  }
} finally {
  db.close();
}
