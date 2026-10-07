// Crawl feeds into D1 and rebuild the homepage snapshot.
import { fetchAllFeeds, mapWithConcurrency, parseBlogsCsv } from '../../scripts/lib/feed.mjs';
import { categorize } from './categories.js';
import { fetchFavicon, iconKey } from './favicon.js';

const DAY = 24 * 3600;
const MONTH = Math.round(30.44 * DAY);
// A feed failing for this long is flagged on the site as 疑似失效 (probably
// dead), and after GONE_AFTER as 已失效 (dead). Dead blogs are still checked
// every 90 days: blogs do come back (renewed domain, new host).
const DEAD_AFTER = 7 * DAY;
const GONE_AFTER = 90 * DAY;
// Errors that won't fix themselves (missing feed, dead domain, bad certificate,
// not a feed) flag a blog after one day instead of seven
const DEAD_AFTER_PERMANENT = 1 * DAY;
const PERMANENT_HTTP = new Set(['HTTP 404', 'HTTP 410', 'HTTP 530']);
const isPermanent = (check) => check.status === 'ssl_error' || check.status === 'not_a_feed' || PERMANENT_HTTP.has(check.error);
// How long until a blog is checked again. Active blogs are checked hourly
// (most checks are a cheap 304), quieter ones less often. A failing feed keeps
// its pace for a day (it may be a blip), then backs off.
const ACTIVITY_INTERVALS = [
  [30 * DAY, 3600],      // posted in the last 30 days
  [365 * DAY, 3 * 3600], // posted in the last year
  [Infinity, 12 * 3600], // quiet for over a year, or no dated posts
];
const BACKOFF = [
  [1 * DAY, null],       // null: keep the activity-based interval
  [DEAD_AFTER, 12 * 3600],
  [30 * DAY, 3 * DAY],
  [GONE_AFTER, 7 * DAY],
  [Infinity, 90 * DAY],
];
// Runs are hourly; due times are set a little early so a blog checked hourly
// is due at the next run even if the cron fires a few seconds early.
const DUE_SLACK = 5 * 60;
function nextCheckIn({ failingSince, lastPostAt }, now) {
  const backoff = failingSince && BACKOFF.find(([upTo]) => now - failingSince < upTo)[1];
  if (backoff) return backoff;
  // Never posted (or no dated entries) counts as the quietest tier
  const quietFor = lastPostAt ? now - lastPostAt : Infinity;
  const [, interval] = ACTIVITY_INTERVALS.find(([upTo]) => quietFor < upTo) ?? ACTIVITY_INTERVALS.at(-1);
  return interval - DUE_SLACK;
}
const FAILURE_STATUSES = new Set(['http_error', 'network_error', 'ssl_error', 'not_a_feed']);
const FAVICON_MAX_AGE = 30 * DAY;
const FAVICON_RETRY_AFTER = 7 * DAY;
const BATCH_SIZE = 50;
// Feeds handled per round of fetch → parse → write (see crawlFeeds)
const FEED_CHUNK = 48;
// Newest entries stored per feed per check; bounds the first crawl of feeds with long histories
const MAX_ENTRIES_PER_FEED = 300;
// After the first crawl, only entries at most this much older than the blog's
// newest known post are offered to the database (catches backdated posts)
const NEW_ENTRY_WINDOW = 30 * DAY;

async function runBatches(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

// Mirror the CSV into the blogs table. Blogs no longer in the CSV are marked
// removed rather than deleted, so their posts stay linked.
export async function syncBlogs(db, csvText) {
  const blogs = parseBlogsCsv(csvText);
  const upsert = db.prepare(`
    INSERT INTO blogs (id, name, url, feed, tags, categories, position, removed, num)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, (SELECT COALESCE(MAX(num), 0) + 1 FROM blogs))
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, url = excluded.url, tags = excluded.tags,
      categories = excluded.categories, position = excluded.position, removed = 0,
      -- A changed feed URL starts with a clean slate
      status = CASE WHEN blogs.feed IS excluded.feed THEN blogs.status END,
      failing_since = CASE WHEN blogs.feed IS excluded.feed THEN blogs.failing_since END,
      dead_since = CASE WHEN blogs.feed IS excluded.feed THEN blogs.dead_since END,
      next_check_at = CASE WHEN blogs.feed IS excluded.feed THEN blogs.next_check_at END,
      etag = CASE WHEN blogs.feed IS excluded.feed THEN blogs.etag END,
      last_modified = CASE WHEN blogs.feed IS excluded.feed THEN blogs.last_modified END,
      feed = excluded.feed`);
  const { results: existing } = await db.prepare('SELECT id FROM blogs').all();
  const known = new Set(existing.map((r) => r.id));
  const seen = new Set();
  const statements = [];
  blogs.forEach((b, position) => {
    // The linter rejects duplicate addresses, but keep the first one just in case
    if (seen.has(b.id)) return;
    seen.add(b.id);
    statements.push(upsert.bind(b.id, b.name, b.url, b.feed || null, JSON.stringify(b.tags), JSON.stringify(categorize(b.tags)), position));
  });
  await runBatches(db, statements);

  const { results } = await db.prepare('SELECT id FROM blogs WHERE removed = 0').all();
  const gone = results.filter((r) => !seen.has(r.id));
  await runBatches(db, gone.map((r) => db.prepare('UPDATE blogs SET removed = 1 WHERE id = ?').bind(r.id)));
  // Only ids never seen before count as new (not blogs that came back)
  const fresh = [...seen].filter((id) => !known.has(id));
  const added = [];
  for (let i = 0; i < fresh.length; i += 50) {
    const ids = fresh.slice(i, i + 50);
    const { results: rows } = await db.prepare(`SELECT num, name, url FROM blogs WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    added.push(...rows);
  }
  return { blogs: seen.size, removed: gone.length, added };
}

// Fetch the feeds that are due (or every feed with `all`), oldest first, at
// most `limit`, and store new posts. `onProgress(message)` is called after each
// chunk (used to keep the manual crawl's HTTP response alive).
// `deadline` (ms timestamp): stop starting new chunks after it; the rest stay
// due for the next run.
export async function crawlFeeds(db, { limit, all = false, blogId, deadline = Infinity } = {}, nowMs = Date.now(), onProgress = () => {}) {
  const now = Math.floor(nowMs / 1000);
  const specificBlog = blogId != null;
  const { results: blogs } = await db.prepare(`
    SELECT id, feed, failing_since, dead_since, last_ok_at, last_post_at, etag, last_modified FROM blogs
    WHERE removed = 0 AND feed IS NOT NULL AND (? OR next_check_at IS NULL OR next_check_at <= ?)
      AND (? IS NULL OR id = ?)
    ORDER BY next_check_at IS NOT NULL, next_check_at LIMIT ?`)
    .bind(all || specificBlog ? 1 : 0, now, blogId ?? null, blogId ?? null, limit ?? -1).all();

  const insertPost = db.prepare(`
    INSERT INTO posts (blog_id, url, title, summary, published_at, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (blog_id, url) DO NOTHING`);
  const updateBlog = db.prepare(`
    UPDATE blogs SET status = ?, error = ?, last_checked_at = ?, last_ok_at = ?, failing_since = ?, dead_since = ?, last_post_at = ?, next_check_at = ?,
      etag = ?, last_modified = ?
    WHERE id = ?`);
  // A 304 means nothing changed since the last successful fetch: keep status and validators
  const touchBlog = db.prepare(`
    UPDATE blogs SET error = NULL, last_checked_at = ?1, last_ok_at = ?1, failing_since = NULL, dead_since = NULL, next_check_at = ?2
    WHERE id = ?3`);

  const statuses = {};
  let newestTotal = 0;
  let failedTotal = 0;
  // Fetch, parse and store a few dozen feeds at a time: a Worker has 128 MB of
  // memory, and some feeds carry full article text for their whole history.
  let checked = 0;
  for (let start = 0; start < blogs.length; start += FEED_CHUNK) {
    if (Date.now() > deadline) break;
    const chunk = blogs.slice(start, start + FEED_CHUNK);
    checked += chunk.length;
    const checks = await fetchAllFeeds(chunk, nowMs, { concurrency: 6, retryConcurrency: 6 });
    const statements = [];
    chunk.forEach((blog, i) => {
      const check = checks[i];
      statuses[check.status] = (statuses[check.status] ?? 0) + 1;
      if (check.status === 'not_modified') {
        statements.push(touchBlog.bind(now, now + nextCheckIn({ lastPostAt: blog.last_post_at }, now), blog.id));
        return;
      }
      const failed = FAILURE_STATUSES.has(check.status);
      if (failed) failedTotal++;
      // Posts already stored are skipped by ON CONFLICT anyway; the cutoff
      // just avoids offering hundreds of them on every check
      const cutoff = blog.last_post_at ? (blog.last_post_at - NEW_ENTRY_WINDOW) * 1000 : 0;
      // A sitemap lists pages with build-time dates, not posts: use it only as a liveness check
      const entries = check.feedType === 'sitemap' ? [] : (check.entries ?? [])
        .filter((e) => e.url && e.date >= cutoff).slice(0, MAX_ENTRIES_PER_FEED);
      for (const e of entries) {
        statements.push(insertPost.bind(blog.id, e.url, e.title ?? '', e.summary ?? null, Math.floor(e.date / 1000), now));
      }
      const newest = entries[0] ? Math.floor(entries[0].date / 1000) : null;
      if (newest && now - newest < DAY) newestTotal++;
      const failingSince = failed ? (blog.failing_since ?? now) : null;
      const deadAfter = isPermanent(check) ? DEAD_AFTER_PERMANENT : DEAD_AFTER;
      const deadSince = !failed ? null : blog.dead_since ?? (now - failingSince >= deadAfter ? now : null);
      const lastPostAt = Math.max(blog.last_post_at ?? 0, newest ?? 0) || null;
      statements.push(updateBlog.bind(
        check.status,
        check.error ?? null,
        now,
        failed ? blog.last_ok_at : now,
        failingSince,
        deadSince,
        lastPostAt,
        now + nextCheckIn({ failingSince, lastPostAt }, now),
        // Keep validators only from a successful parse, so a failure never yields a 304 later
        failed ? null : check.etag ?? null,
        failed ? null : check.lastModified ?? null,
        blog.id,
      ));
    });
    await runBatches(db, statements);
    onProgress(`feeds ${Math.min(start + FEED_CHUNK, blogs.length)}/${blogs.length}`);
  }
  return { due: blogs.length, checked, statuses, failed: failedTotal, updatedToday: newestTotal };
}

// Fetch favicons for blogs that have none yet or whose icon is stale.
export async function crawlFavicons(db, limit, nowMs = Date.now(), onProgress = () => {}) {
  const now = Math.floor(nowMs / 1000);
  const { results: blogs } = await db.prepare(`
    SELECT b.id, b.url FROM blogs b LEFT JOIN favicons f ON f.blog_id = b.id
    WHERE b.removed = 0 AND (
      f.blog_id IS NULL
      OR (f.data IS NOT NULL AND f.fetched_at < ?)
      OR (f.data IS NULL AND f.fetched_at < ?))
    ORDER BY f.fetched_at IS NOT NULL, f.fetched_at
    LIMIT ?`).bind(now - FAVICON_MAX_AGE, now - FAVICON_RETRY_AFTER, limit).all();

  let found = 0;
  let done = 0;
  await mapWithConcurrency(blogs, 6, async (blog) => {
    if (++done % 50 === 0) onProgress(`favicons ${done}/${blogs.length}`);
    const key = await iconKey(blog.id);
    const icon = await fetchFavicon(blog.url);
    if (icon) found++;
    const save = icon
      ? db.prepare(`
          INSERT INTO favicons (key, blog_id, content_type, data, fetched_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (blog_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, fetched_at = excluded.fetched_at`)
          .bind(key, blog.id, icon.contentType, icon.bytes.buffer.slice(icon.bytes.byteOffset, icon.bytes.byteOffset + icon.bytes.byteLength), now)
      // Keep an old icon if the site is temporarily unreachable
      : db.prepare(`
          INSERT INTO favicons (key, blog_id, fetched_at) VALUES (?, ?, ?)
          ON CONFLICT (blog_id) DO UPDATE SET fetched_at = excluded.fetched_at`)
          .bind(key, blog.id, now);
    await db.batch([
      save,
      db.prepare('UPDATE blogs SET icon_key = (SELECT key FROM favicons WHERE blog_id = ?1 AND data IS NOT NULL) WHERE id = ?1').bind(blog.id),
    ]);
  });
  return { checked: blogs.length, found };
}

// Precompute every blog's metadata and monthly post counts (for the directory
// and blog pages) plus the sidebar numbers, so those pages cost one row read.
export const REPO = 'timqian/chinese-independent-blogs';

// Star count for the sidebar badge, or null if GitHub can't be reached.
// Authenticating as the OAuth app avoids the low anonymous rate limit, which
// Workers share with everyone else on the same egress IPs.
export async function repoStars(env) {
  const headers = { 'User-Agent': 'Indi', Accept: 'application/vnd.github+json' };
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    headers.Authorization = `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers, signal: AbortSignal.timeout(10_000) });
    return res.ok ? (await res.json()).stargazers_count ?? null : null;
  } catch {
    return null;
  }
}

export async function buildSnapshot(db, nowMs = Date.now(), { stars = null } = {}) {
  const now = Math.floor(nowMs / 1000);
  const [{ results: blogRows }, { results: monthRows }, { results: postRows }] = await db.batch([
    db.prepare('SELECT * FROM blogs WHERE removed = 0 ORDER BY position'),
    db.prepare(`
      SELECT blog_id, CAST((?1 - published_at) / ?2 AS INTEGER) AS m, COUNT(*) AS n FROM posts
      WHERE published_at > ?1 - 12 * ?2 AND published_at <= ?1
      GROUP BY blog_id, m`).bind(now, MONTH),
    db.prepare('SELECT blog_id, published_at FROM posts WHERE published_at > ?').bind(now - 7 * DAY),
  ]);

  // Posts per month over the last 12 months, oldest first
  const monthly = new Map();
  for (const r of monthRows) {
    if (!monthly.has(r.blog_id)) monthly.set(r.blog_id, new Array(12).fill(0));
    monthly.get(r.blog_id)[11 - r.m] = r.n;
  }

  const blogs = blogRows.map((b) => ({
    id: b.id,
    num: b.num,
    n: b.name,
    u: b.url,
    f: b.feed ?? '',
    tags: JSON.parse(b.tags),
    c: JSON.parse(b.categories),
    dead: Boolean(b.dead_since),
    gone: Boolean(b.failing_since && now - b.failing_since >= GONE_AFTER),
    ...(b.failing_since && { fs: b.failing_since, err: b.error || b.status }),
    last: b.last_post_at,
    m: b.last_post_at ? (monthly.get(b.id) ?? new Array(12).fill(0)) : null,
    ...(b.icon_key && { i: `/icons/${b.icon_key}` }),
  }));
  // Sidebar numbers shown on every page
  const active = new Set(blogs.map((b) => b.id));
  const recent = postRows.filter((p) => active.has(p.blog_id));
  const stats = {
    blogs: blogs.length,
    weekBlogs: new Set(recent.map((p) => p.blog_id)).size,
    dayPosts: recent.filter((p) => now - p.published_at < DAY).length,
    generatedAt: new Date(nowMs).toISOString(),
  };
  // Keep the last known star count if GitHub didn't answer this time
  stats.stars = stars ?? JSON.parse((await db.prepare("SELECT value FROM meta WHERE key = 'stats'").first())?.value ?? '{}').stars ?? null;
  const snapshot = JSON.stringify({ generatedAt: new Date(nowMs).toISOString(), blogs });
  const setMeta = db.prepare(`
    INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  await db.batch([setMeta.bind('snapshot', snapshot, now), setMeta.bind('stats', JSON.stringify(stats), now)]);
  return { blogs: blogs.length, bytes: snapshot.length };
}
