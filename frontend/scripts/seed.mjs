// Write the local development fixtures (a blog and three recent posts) into
// the configured database. Safe to run repeatedly.
//   npm run db:seed
import { readFileSync } from 'node:fs';
import { Db } from '../lib/db.js';
import { config, loadEnvFile } from '../lib/env.js';
import { migrate } from '../lib/migrate.js';

loadEnvFile();
const env = config();
const path = process.argv[2] ?? env.DB_PATH;

const db = new Db(path);
try {
  migrate(db);
  db.exec(readFileSync(new URL('./seed-dev.sql', import.meta.url), 'utf8'));
  console.log(`seeded ${path}`);
} finally {
  db.close();
}
