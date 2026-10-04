// Download every blog's crawl status from the website into data/blogs.json,
// which scripts/render-readme.mjs reads. The website (frontend/) checks feeds
// hourly, so README.md and indi.blog agree on which blogs are dead.
//
// Usage: node scripts/sync-status.mjs
//
// If the site can't be reached, the previous data/blogs.json is kept.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = process.env.BLOG_STATUS_URL || 'https://indi.blog/api/blogs.json';
const DATA_FILE = fileURLToPath(new URL('../data/blogs.json', import.meta.url));

let data;
try {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  data = await res.json();
  // Guard against an empty or truncated answer replacing good data
  if (!Array.isArray(data.blogs) || data.blogs.length < 1000) throw new Error(`only ${data.blogs?.length ?? 0} blogs`);
} catch (err) {
  console.error(`Could not fetch ${SOURCE} (${err.message}); keeping the previous data/blogs.json`);
  process.exit(0);
}

mkdirSync(fileURLToPath(new URL('../data/', import.meta.url)), { recursive: true });
writeFileSync(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`);
const dead = data.blogs.filter((b) => b.dead).length;
console.log(`data/blogs.json: ${data.blogs.length} blogs, ${dead} flagged dead (from ${SOURCE})`);
