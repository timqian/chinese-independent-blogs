// Trigger a crawl through the local server's admin API and stream its
// progress. The server must be running.
//   npm run crawl                       # feeds that are due
//   npm run crawl -- all=1 favicons=all # first backfill: every feed and icon
import { config, loadEnvFile } from '../lib/env.js';

loadEnvFile();
const env = config();
if (!env.ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is not set (see frontend/.env.example)');
  process.exit(1);
}

const query = new URLSearchParams();
for (const arg of process.argv.slice(2)) {
  const [key, value = '1'] = arg.split('=');
  query.set(key, value);
}
const url = `http://localhost:${env.PORT}/api/admin/crawl${query.size ? `?${query}` : ''}`;
const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } });
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}
for await (const chunk of res.body) process.stdout.write(chunk);
