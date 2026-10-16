// Node entry: opens the SQLite database, applies migrations, serves the Hono
// app (src/index.js) plus public/ static files, and runs the crawl schedule.
// Replaces `wrangler dev` / `wrangler deploy`; configuration comes from
// environment variables or frontend/.env (see .env.example).
import { serve } from '@hono/node-server';
import app, { hourlyCrawl, weeklyDigest } from './src/index.js';
import { Db } from './lib/db.js';
import { config, loadEnvFile } from './lib/env.js';
import { migrate } from './lib/migrate.js';
import { startScheduler } from './lib/scheduler.js';

loadEnvFile();
const env = config();

// The app sees the Worker-style env: configuration plus the Node bindings the
// adapter passes in (used to read the client socket address for rate limits).
env.DB = new Db(env.DB_PATH);

const applied = migrate(env.DB);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

// waitUntil() keeps the Workers semantics: background work that outlives the
// response, e.g. writing to the page cache or streaming an admin crawl.
const executionCtx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((err) => console.error('background task failed:', err));
  },
  passThroughOnException() {},
};

const server = serve(
  {
    fetch: (request, bindings) => app.fetch(request, { ...env, ...bindings }, executionCtx),
    port: Number(env.PORT),
    hostname: env.HOST,
  },
  (info) => {
    console.log(`Indi listening on http://${info.address}:${info.port} (site: ${env.SITE_URL || 'SITE_URL not set'})`);
    console.log(`database: ${env.DB_PATH}`);
  },
);
server.on('error', (err) => {
  console.error(`cannot listen on ${env.HOST}:${env.PORT}: ${err.message}`);
  process.exit(1);
});

// Same schedule the Cloudflare Worker used to run: hourly at :07, weekly
// digest Monday 01:00 UTC.
// Set CRAWL=0 to run the site without the in-process crawler (e.g. when the
// crawl is run elsewhere against the same database).
if (env.CRAWL !== '0') {
  startScheduler({
    hourly: () => hourlyCrawl(env),
    weekly: () => weeklyDigest(env),
  });
  console.log('scheduler: crawl every hour at :07, weekly Telegram digest Monday 01:00 UTC');
}

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    env.DB.close();
    process.exit(0);
  });
  // In-flight crawls can hold the process open; don't wait forever
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
