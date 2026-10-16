// Apply pending migrations to the configured database:
//   npm run db:migrate            # DB_PATH from .env / environment
//   npm run db:migrate -- file.db # or an explicit file
import { Db } from '../lib/db.js';
import { config, loadEnvFile } from '../lib/env.js';
import { migrate } from '../lib/migrate.js';

loadEnvFile();
const env = config();
const path = process.argv[2] ?? env.DB_PATH;

const db = new Db(path);
try {
  const applied = migrate(db);
  console.log(applied.length ? `applied ${applied.length} migration(s) to ${path}` : `up to date: ${path}`);
} finally {
  db.close();
}
