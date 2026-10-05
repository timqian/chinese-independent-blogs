// Worker entry: server-rendered pages, accounts and discussion, feeds,
// sitemap, API, favicons and the hourly crawl. Static files in ../public (style.css, app.js, favicon.svg) are
// served by Workers Static Assets before this code runs.
import { Hono } from 'hono';
import blogsCsv from '../../blogs-original.csv';
import { originCheck, registerAuthRoutes, sessionMiddleware } from './auth.js';
import { buildSnapshot, crawlFavicons, crawlFeeds, repoStars, syncBlogs } from './crawl.js';
import { announceNewBlogs, announceWeeklyTop, telegramEnabled } from './telegram.js';
import { hotPosts, registerDiscussRoutes, votedIds } from './discuss.js';
import { blogFollowersPage, blogPage, categoryName, directoryPage, errorPage, followingBlogsPage, followingOpml, followingPage, hotPage, notificationsPage, postPage, sitemap, timelinePage, userFollowingPage, userPage, userUpvotedPage } from './views.js';

const FAVICONS_PER_RUN = 60;
// Feeds per hourly run, and how long a cron run may keep starting new chunks
// (a cron run is killed after 15 minutes; leftovers stay due for the next run)
const FEEDS_PER_RUN = 2000;
const CRON_BUDGET_MS = 12 * 60_000;
const WEEKLY_CRON = '0 1 * * 1';
const TIMELINE_PAGE_SIZE = 60;
const HOT_PAGE_SIZE = 30;
const FOLLOWING_PAGE_SIZE = 30;
const HOT_MAX_PAGES = 10;
const BLOG_PAGE_SIZE = 30;

const app = new Hono();

// ---------- helpers ----------

const siteUrl = (c) => c.env.SITE_URL || new URL(c.req.url).origin;
const nowSec = () => Math.floor(Date.now() / 1000);

async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

// Snapshot blogs use short keys to keep the stored JSON small
const fromSnapshot = (b) => ({
  id: b.id, num: b.num, name: b.n, url: b.u, feed: b.f, tags: b.tags, categories: b.c,
  dead: b.dead, gone: b.gone, failingSince: b.fs, error: b.err, last: b.last, monthly: b.m, icon: b.i,
});

// Rows from a posts ⨝ blogs query into the shape the views use
const toPost = (r) => ({
  id: r.id, url: r.url, title: r.title, summary: r.summary, published_at: r.published_at,
  score: r.score, comment_count: r.comment_count,
  blog: { id: r.blog_id, num: r.num, name: r.name, icon: r.icon_key ? `/icons/${r.icon_key}` : undefined },
});

async function latestPosts(db, { cat = '', limit, offset = 0 }) {
  const { results } = await db.prepare(`
    SELECT p.id, p.url, p.title, p.summary, p.published_at, p.score, p.comment_count,
           b.id AS blog_id, b.num, b.name, b.icon_key
    FROM posts p JOIN blogs b ON b.id = p.blog_id
    WHERE b.removed = 0 AND b.dead_since IS NULL
      AND (? = '' OR b.categories LIKE ?)
    ORDER BY p.published_at DESC LIMIT ? OFFSET ?`)
    .bind(cat, `%"${cat}"%`, limit, offset).all();
  return results.map(toPost);
}

const pageParam = (c) => {
  const n = parseInt(c.req.param('n') ?? '1', 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
};

function notFound(c, stats, status = 404) {
  return c.html(errorPage({ site: siteUrl(c), stats, user: c.get('user'), status, message: status === 410 ? '博客已移除' : '页面不存在' }), status);
}

// Common view parameters
const base = (c, stats) => ({ site: siteUrl(c), stats, user: c.get('user'), now: nowSec() });
const postVotes = (c, posts) => votedIds(c.env.DB, 'votes', 'post_id', c.get('user')?.id, posts.map((p) => p.id));

// Follower counts by blog number
async function followerCounts(db) {
  const { results } = await db.prepare('SELECT b.num, COUNT(*) AS n FROM follows f JOIN blogs b ON b.id = f.blog_id GROUP BY f.blog_id').all();
  return new Map(results.map((r) => [r.num, r.n]));
}
const withFollowers = (blogs, counts) => blogs.map((b) => ({ ...b, followers: counts.get(b.num) ?? 0 }));

// Numbers of the blogs the signed-in user follows (empty when signed out)
async function followingNums(c) {
  const user = c.get('user');
  if (!user) return new Set();
  const { results } = await c.env.DB.prepare('SELECT b.num FROM follows f JOIN blogs b ON b.id = f.blog_id WHERE f.user_id = ?').bind(user.id).all();
  return new Set(results.map((r) => r.num));
}

// ---------- middleware ----------

// Only our own /app.js may run: even if some markup slipped through unescaped,
// injected script wouldn't execute. Style attributes are allowed (avatar tints).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Outermost, so cached responses get the headers too
app.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.get('Content-Type')?.startsWith('text/html')) return;
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set('Content-Security-Policy', CSP);
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
});

app.use('*', originCheck);

// Cache rendered GET responses at the edge for anonymous visitors. Crawled
// data changes hourly and discussion actions purge their page, so a few
// minutes of staleness is fine. Signed-in pages are personal and never cached.
// Set CACHE_TTL=0 in .dev.vars.
app.use('*', async (c, next) => {
  const ttl = parseInt(c.env.CACHE_TTL ?? '300', 10);
  const path = new URL(c.req.url).pathname;
  const signedIn = /(?:^|;\s*)sid=/.test(c.req.header('Cookie') ?? '');
  if (c.req.method !== 'GET' || !ttl || signedIn || path.startsWith('/api/admin') || path === '/random' || path.startsWith('/auth/')) return next();
  const cache = caches.default;
  const hit = await cache.match(c.req.raw);
  if (hit) return hit;
  await next();
  if (c.res.status === 200 || c.res.status === 404 || c.res.status === 410) {
    c.res.headers.set('Cache-Control', `public, max-age=${ttl}`);
    c.executionCtx.waitUntil(cache.put(c.req.raw, c.res.clone()));
  }
});

app.use('*', sessionMiddleware);
registerAuthRoutes(app);
registerDiscussRoutes(app);

// ---------- pages ----------

async function timeline(c, cat) {
  const page = pageParam(c);
  const stats = await getMeta(c.env.DB, 'stats');
  if (!page || (cat && !categoryName(cat))) return notFound(c, stats);
  if (c.req.param('n') === '1') return c.redirect(cat ? `/c/${cat}` : '/latest', 301);
  const rows = await latestPosts(c.env.DB, { cat, limit: TIMELINE_PAGE_SIZE + 1, offset: (page - 1) * TIMELINE_PAGE_SIZE });
  if (page > 1 && !rows.length) return notFound(c, stats);
  const posts = rows.slice(0, TIMELINE_PAGE_SIZE);
  return c.html(timelinePage({
    ...base(c, stats), cat, page, posts,
    voted: await postVotes(c, posts),
    hasMore: rows.length > TIMELINE_PAGE_SIZE,
  }));
}
app.get('/latest', (c) => timeline(c, ''));
app.get('/latest/page/:n{[0-9]+}', (c) => timeline(c, ''));
app.get('/c/:cat', (c) => timeline(c, c.req.param('cat')));
app.get('/c/:cat/page/:n{[0-9]+}', (c) => timeline(c, c.req.param('cat')));

async function hot(c) {
  const page = pageParam(c);
  const stats = await getMeta(c.env.DB, 'stats');
  if (!page) return notFound(c, stats);
  if (c.req.param('n') === '1') return c.redirect('/', 301);
  const ranked = await hotPosts(c.env.DB);
  const offset = (page - 1) * HOT_PAGE_SIZE;
  const posts = ranked.slice(offset, offset + HOT_PAGE_SIZE).map(toPost);
  if (page > 1 && !posts.length) return notFound(c, stats);
  return c.html(hotPage({
    ...base(c, stats), page, posts, offset,
    voted: await postVotes(c, posts),
    hasMore: page < HOT_MAX_PAGES && ranked.length > offset + HOT_PAGE_SIZE,
  }));
}
// Hot is the homepage
app.get('/', hot);
app.get('/page/:n{[0-9]+}', hot);
app.get('/hot', (c) => c.redirect('/', 301));
app.get('/hot/page/:n{[0-9]+}', (c) => c.redirect(`/page/${c.req.param('n')}`, 301));

async function directory(c, view) {
  const [snapshot, stats] = await Promise.all([getMeta(c.env.DB, 'snapshot'), getMeta(c.env.DB, 'stats')]);
  const now = nowSec();
  let blogs = (snapshot?.blogs ?? []).map(fromSnapshot);
  if (view === 'active') blogs = blogs.filter((b) => !b.dead && b.last && now - b.last < 365 * 86400);
  // Every blog whose feed is currently failing, most recent failures first, so it's easy to spot and fix
  if (view === 'dead') blogs = blogs.filter((b) => b.failingSince).sort((a, b) => b.failingSince - a.failingSince);
  if (view !== 'dead') blogs.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  const [counts, following] = await Promise.all([followerCounts(c.env.DB), followingNums(c)]);
  return c.html(directoryPage({ ...base(c, stats), blogs: withFollowers(blogs, counts), view, following }));
}
app.get('/blogs', (c) => directory(c, 'all'));
app.get('/blogs/active', (c) => directory(c, 'active'));
app.get('/blogs/dead', (c) => directory(c, 'dead'));
app.get('/blogs/all', (c) => c.redirect('/blogs', 301));

async function blog(c) {
  const page = pageParam(c);
  const num = parseInt(c.req.param('num'), 10);
  const [snapshot, stats] = await Promise.all([getMeta(c.env.DB, 'snapshot'), getMeta(c.env.DB, 'stats')]);
  if (!page) return notFound(c, stats);
  if (c.req.param('n') === '1') return c.redirect(`/b/${num}`, 301);
  const entry = snapshot?.blogs.find((b) => b.num === num);
  if (!entry) {
    // Not in the snapshot: either removed from the list (410) or never existed
    const row = await c.env.DB.prepare('SELECT removed FROM blogs WHERE num = ?').bind(num).first();
    return notFound(c, stats, row?.removed ? 410 : 404);
  }
  const b = fromSnapshot(entry);
  b.followers = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE blog_id = ?').bind(b.id).first()).n;
  const { results } = await c.env.DB.prepare(`
    SELECT id, url, title, published_at, score, comment_count FROM posts WHERE blog_id = ?
    ORDER BY published_at DESC LIMIT ? OFFSET ?`)
    .bind(b.id, BLOG_PAGE_SIZE + 1, (page - 1) * BLOG_PAGE_SIZE).all();
  if (page > 1 && !results.length) return notFound(c, stats);
  const posts = results.slice(0, BLOG_PAGE_SIZE);
  return c.html(blogPage({
    ...base(c, stats), blog: b, page, posts,
    voted: await postVotes(c, posts),
    following: await followingNums(c),
    hasMore: results.length > BLOG_PAGE_SIZE,
  }));
}
app.get('/b/:num{[0-9]+}', blog);
app.get('/b/:num{[0-9]+}/page/:n{[0-9]+}', blog);

app.get('/p/:id{[0-9]+}', async (c) => {
  const db = c.env.DB;
  const stats = await getMeta(db, 'stats');
  const row = await db.prepare(`
    SELECT p.id, p.url, p.title, p.summary, p.published_at, p.blog_id, p.score, p.comment_count,
           b.num, b.name, b.url AS blog_url, b.icon_key, b.removed
    FROM posts p JOIN blogs b ON b.id = p.blog_id WHERE p.id = ?`)
    .bind(parseInt(c.req.param('id'), 10)).first();
  if (!row) return notFound(c, stats);
  if (row.removed) return notFound(c, stats, 410);
  const [{ results: morePosts }, { results: comments }] = await db.batch([
    db.prepare(`
      SELECT id, title, published_at FROM posts WHERE blog_id = ? AND id != ?
      ORDER BY published_at DESC LIMIT 5`).bind(row.blog_id, row.id),
    db.prepare(`
      SELECT c.id, c.parent_id, c.user_id, c.body, c.score, c.deleted, c.created_at, u.username, u.avatar_url
      FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ? ORDER BY c.score DESC, c.created_at ASC`).bind(row.id),
  ]);
  const userId = c.get('user')?.id;
  return c.html(postPage({
    ...base(c, stats), morePosts, comments,
    post: row,
    blog: { id: row.blog_id, num: row.num, name: row.name, url: row.blog_url, icon: row.icon_key ? `/icons/${row.icon_key}` : undefined },
    voted: await votedIds(db, 'votes', 'post_id', userId, [row.id]),
    commentVoted: await votedIds(db, 'comment_votes', 'comment_id', userId, comments.map((cm) => cm.id)),
    error: c.req.query('error')?.slice(0, 100),
  }));
});

// ---------- user pages: comments, upvoted posts, followed blogs (all public) ----------

const getProfile = (db, username) => db.prepare(`
  SELECT id, username, karma, github_login, avatar_url, created_at FROM users WHERE username = ? AND banned = 0`)
  .bind(username).first();

app.get('/u/:username', async (c) => {
  const db = c.env.DB;
  const [stats, profile] = await Promise.all([getMeta(db, 'stats'), getProfile(db, c.req.param('username'))]);
  if (!profile) return notFound(c, stats);
  const { results: comments } = await db.prepare(`
    SELECT c.id, c.post_id, c.body, c.created_at, p.title AS post_title
    FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE c.user_id = ? AND c.deleted = 0 ORDER BY c.created_at DESC LIMIT 30`).bind(profile.id).all();
  return c.html(userPage({ ...base(c, stats), profile, comments }));
});

app.get('/u/:username/upvoted', async (c) => {
  const db = c.env.DB;
  const [stats, profile] = await Promise.all([getMeta(db, 'stats'), getProfile(db, c.req.param('username'))]);
  if (!profile) return notFound(c, stats);
  const { results } = await db.prepare(`
    SELECT p.id, p.url, p.title, p.summary, p.published_at, p.score, p.comment_count,
           b.id AS blog_id, b.num, b.name, b.icon_key
    FROM votes v JOIN posts p ON p.id = v.post_id JOIN blogs b ON b.id = p.blog_id
    WHERE v.user_id = ? AND b.removed = 0 ORDER BY v.created_at DESC LIMIT 30`).bind(profile.id).all();
  const posts = results.map(toPost);
  return c.html(userUpvotedPage({ ...base(c, stats), profile, posts, voted: await postVotes(c, posts) }));
});

// Follow lists are public: the blogs a user follows…
app.get('/u/:username/following', async (c) => {
  const db = c.env.DB;
  const [stats, snapshot, profile] = await Promise.all([getMeta(db, 'stats'), getMeta(db, 'snapshot'), getProfile(db, c.req.param('username'))]);
  if (!profile) return notFound(c, stats);
  const { results } = await db.prepare('SELECT b.num FROM follows f JOIN blogs b ON b.id = f.blog_id WHERE f.user_id = ?').bind(profile.id).all();
  const nums = new Set(results.map((r) => r.num));
  const blogs = (snapshot?.blogs ?? []).filter((b) => nums.has(b.num)).map(fromSnapshot).sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  const [counts, following] = await Promise.all([followerCounts(db), followingNums(c)]);
  return c.html(userFollowingPage({ ...base(c, stats), profile, blogs: withFollowers(blogs, counts), following }));
});

// …and the people following a blog
app.get('/b/:num{[0-9]+}/followers', async (c) => {
  const db = c.env.DB;
  const stats = await getMeta(db, 'stats');
  const blog = await db.prepare('SELECT id, num, name FROM blogs WHERE num = ? AND removed = 0').bind(parseInt(c.req.param('num'), 10)).first();
  if (!blog) return notFound(c, stats);
  const { results: people } = await db.prepare(`
    SELECT u.username, u.avatar_url, f.created_at FROM follows f JOIN users u ON u.id = f.user_id
    WHERE f.blog_id = ? AND u.banned = 0 AND u.username IS NOT NULL
    ORDER BY f.created_at DESC LIMIT 500`).bind(blog.id).all();
  return c.html(blogFollowersPage({ ...base(c, stats), blog, people }));
});

// Replies to your comments. Viewing the page marks them all read.
app.get('/notifications', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login?next=/notifications');
  const db = c.env.DB;
  const { results: items } = await db.prepare(`
    SELECT n.id, n.created_at, n.read_at, c.id AS comment_id, c.body, c.post_id,
           u.username AS actor, u.avatar_url AS actor_avatar, p.title AS post_title
    FROM notifications n
    JOIN comments c ON c.id = n.comment_id
    JOIN users u ON u.id = c.user_id
    JOIN posts p ON p.id = c.post_id
    WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`).bind(user.id).all();
  if (user.unread) {
    await db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(nowSec(), user.id).run();
  }
  // The header shows the count from before this visit; clear it on this page
  return c.html(notificationsPage({ ...base(c, await getMeta(db, 'stats')), user: { ...user, unread: 0 }, items }));
});

// Posts from the blogs the user follows, newest first
async function following(c) {
  const page = pageParam(c);
  const db = c.env.DB;
  const stats = await getMeta(db, 'stats');
  const user = c.get('user');
  if (!page) return notFound(c, stats);
  if (c.req.param('n') === '1') return c.redirect('/following', 301);
  if (!user) return c.html(followingPage({ ...base(c, stats), page }));
  const [{ results: [{ n: blogCount }] }, { results }] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?').bind(user.id),
    db.prepare(`
      SELECT p.id, p.url, p.title, p.summary, p.published_at, p.score, p.comment_count,
             b.id AS blog_id, b.num, b.name, b.icon_key
      FROM follows f JOIN posts p ON p.blog_id = f.blog_id JOIN blogs b ON b.id = f.blog_id
      WHERE f.user_id = ? AND b.removed = 0
      ORDER BY p.published_at DESC LIMIT ? OFFSET ?`).bind(user.id, FOLLOWING_PAGE_SIZE + 1, (page - 1) * FOLLOWING_PAGE_SIZE),
  ]);
  if (page > 1 && !results.length) return notFound(c, stats);
  const posts = results.slice(0, FOLLOWING_PAGE_SIZE).map(toPost);
  return c.html(followingPage({
    ...base(c, stats), page, posts, blogCount,
    voted: await postVotes(c, posts),
    hasMore: results.length > FOLLOWING_PAGE_SIZE,
  }));
}
app.get('/following', following);
app.get('/following/page/:n{[0-9]+}', following);

async function followedBlogs(c) {
  const [snapshot, nums] = await Promise.all([getMeta(c.env.DB, 'snapshot'), followingNums(c)]);
  return (snapshot?.blogs ?? []).filter((b) => nums.has(b.num)).map(fromSnapshot).sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
}

app.get('/following/blogs', async (c) => {
  if (!c.get('user')) return c.redirect('/login?next=/following/blogs');
  const blogs = withFollowers(await followedBlogs(c), await followerCounts(c.env.DB));
  return c.html(followingBlogsPage({ ...base(c, await getMeta(c.env.DB, 'stats')), blogs, following: new Set(blogs.map((b) => b.num)) }));
});

app.get('/following.opml', async (c) => {
  if (!c.get('user')) return c.redirect('/login?next=/following');
  return c.body(followingOpml(await followedBlogs(c)), 200, {
    'Content-Type': 'text/x-opml; charset=utf-8',
    'Content-Disposition': 'attachment; filename="indi-following.opml"',
  });
});

app.get('/random', async (c) => {
  const row = await c.env.DB.prepare(`
    SELECT num FROM blogs WHERE removed = 0 AND failing_since IS NULL AND last_post_at > ?
    ORDER BY RANDOM() LIMIT 1`).bind(nowSec() - 90 * 86400).first();
  return c.redirect(row ? `/b/${row.num}` : '/', 302);
});

// ---------- sitemap, robots ----------

app.get('/sitemap.xml', async (c) => {
  const db = c.env.DB;
  const [{ results: blogs }, { results: discussed }] = await db.batch([
    db.prepare('SELECT num, last_post_at AS last FROM blogs WHERE removed = 0 ORDER BY num'),
    db.prepare(`
      SELECT p.id, MAX(c.created_at) AS last FROM posts p JOIN comments c ON c.post_id = p.id
      WHERE p.comment_count > 0 AND c.deleted = 0 GROUP BY p.id ORDER BY last DESC LIMIT 40000`),
  ]);
  return c.body(sitemap({ site: siteUrl(c), blogs, discussed, now: nowSec() }), 200, { 'Content-Type': 'application/xml; charset=utf-8' });
});

app.get('/robots.txt', (c) => c.text(`User-agent: *
Allow: /
Disallow: /api/
Disallow: /following
Disallow: /random
Disallow: /login
Disallow: /settings
Disallow: /notifications

Sitemap: ${siteUrl(c)}/sitemap.xml
`));

// ---------- favicons and API ----------

// Crawl status of every blog, in the shape of the repo's data/blogs.json.
// scripts/sync-status.mjs downloads this daily so README.md uses the same
// data as the website.
app.get('/api/blogs.json', async (c) => {
  const db = c.env.DB;
  const iso = (t) => (t ? new Date(t * 1000).toISOString() : undefined);
  const [{ results: blogs }, { results: latest }] = await db.batch([
    db.prepare(`
      SELECT id, num, name, url, feed, tags, status, error, last_checked_at, last_ok_at, failing_since, dead_since
      FROM blogs WHERE removed = 0 ORDER BY position`),
    // SQLite returns the other columns from the row holding MAX()
    db.prepare('SELECT blog_id, url, title, MAX(published_at) AS published_at FROM posts GROUP BY blog_id'),
  ]);
  const latestByBlog = new Map(latest.map((p) => [p.blog_id, p]));
  const site = siteUrl(c);
  return c.json({
    checkedAt: new Date().toISOString(),
    source: `${site}/api/blogs.json`,
    blogs: blogs.map((b) => {
      const post = latestByBlog.get(b.id);
      return {
        id: b.id,
        page: `${site}/b/${b.num}`,
        name: b.name,
        url: b.url,
        feed: b.feed ?? '',
        tags: JSON.parse(b.tags),
        status: b.status,
        ...(b.error && { error: b.error }),
        ...(post && { lastPost: { title: post.title, url: post.url, publishedAt: iso(post.published_at) } }),
        lastCheckedAt: iso(b.last_checked_at),
        lastOkAt: iso(b.last_ok_at),
        failingSince: iso(b.failing_since),
        dead: Boolean(b.dead_since),
      };
    }),
  }, 200, { 'Cache-Control': 'public, max-age=3600' });
});

// Stored images (blog favicons, user avatars) come from third parties. Favicons
// may be SVG, so forbid scripts in case one is opened directly on our origin.
const imageHeaders = (contentType, maxAge) => ({
  'Content-Type': contentType,
  'Cache-Control': `public, max-age=${maxAge}`,
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
});

app.on(['GET', 'HEAD'], '/icons/:key{[0-9a-f]{12}}', async (c) => {
  const row = await c.env.DB.prepare('SELECT content_type, data FROM favicons WHERE key = ? AND data IS NOT NULL').bind(c.req.param('key')).first();
  if (!row) return c.text('Not found', 404);
  return c.body(new Uint8Array(row.data), 200, imageHeaders(row.content_type, 604800));
});

// Avatar URLs carry ?v=<updated_at>, so they can be cached for long
app.on(['GET', 'HEAD'], '/avatars/:id{[0-9]+}', async (c) => {
  const row = await c.env.DB.prepare('SELECT content_type, data FROM avatars WHERE user_id = ?').bind(parseInt(c.req.param('id'), 10)).first();
  if (!row) return c.text('Not found', 404);
  return c.body(new Uint8Array(row.data), 200, imageHeaders(row.content_type, 2592000));
});

// The blog list as merged on GitHub, so accepted PRs take effect within the
// hour without a redeploy. Falls back to the copy bundled at deploy time
// (always used locally, where BLOGS_CSV_URL is empty).
async function blogList(env) {
  if (!env.BLOGS_CSV_URL) return { csv: blogsCsv, source: 'bundled' };
  try {
    const res = await fetch(env.BLOGS_CSV_URL, { headers: { 'User-Agent': 'Indi' }, signal: AbortSignal.timeout(10_000) });
    const text = res.ok ? await res.text() : '';
    // Guard against an error page or a broken file wiping the list
    if (text.startsWith('Introduction,') && text.split('\n').length > 1000) return { csv: text, source: 'github' };
    console.error(`blog list from GitHub rejected (HTTP ${res.status}, ${text.length} bytes); using bundled copy`);
  } catch (err) {
    console.error('blog list from GitHub failed; using bundled copy', err.message);
  }
  return { csv: blogsCsv, source: 'bundled' };
}

async function crawl(env, { all = false, limit = FEEDS_PER_RUN, deadline, favicons, onProgress }) {
  const now = Date.now();
  const list = await blogList(env);
  const { added, ...syncResult } = await syncBlogs(env.DB, list.csv);
  const sync = { ...syncResult, added: added.length, source: list.source };
  await announceNewBlogs(env, added);
  const feeds = await crawlFeeds(env.DB, { all, limit, deadline }, now, onProgress);
  const icons = await crawlFavicons(env.DB, favicons, now, onProgress);
  const snapshot = await buildSnapshot(env.DB, now, { stars: await repoStars(env) });
  const result = { all, sync, feeds, icons, snapshot, seconds: Math.round((Date.now() - now) / 1000) };
  console.log(JSON.stringify(result));
  return result;
}

// Manual crawl, e.g. for the first backfill:
//   curl -N -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "<host>/api/admin/crawl?all=1&favicons=all"
// Without all=1 it crawls only the feeds that are due, like the hourly run.
// Cloudflare drops a request that sends nothing for ~100 seconds, so the
// response streams one progress line per chunk and ends with the result.
app.post('/api/admin/crawl', async (c) => {
  if (!c.env.ADMIN_TOKEN || c.req.header('Authorization') !== `Bearer ${c.env.ADMIN_TOKEN}`) {
    return c.json({ error: 'Not found' }, 404);
  }
  const all = c.req.query('all') === '1';
  const limit = parseInt(c.req.query('limit') ?? '', 10) || undefined;
  const faviconsParam = c.req.query('favicons');
  const parsed = parseInt(faviconsParam ?? '', 10);
  const favicons = faviconsParam === 'all' ? 100_000 : Number.isFinite(parsed) ? Math.max(0, parsed) : FAVICONS_PER_RUN;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const line = (text) => writer.write(encoder.encode(`${text}\n`)).catch(() => {});
  const job = (async () => {
    line('started');
    // A chunk of slow feeds can take longer than the idle limit; keep talking
    const heartbeat = setInterval(() => line('.'), 20_000);
    try {
      line(JSON.stringify(await crawl(c.env, { all, limit: limit ?? (all ? -1 : FEEDS_PER_RUN), favicons, onProgress: line })));
    } catch (err) {
      console.error(err);
      line(`error: ${err.message}`);
    } finally {
      clearInterval(heartbeat);
      await writer.close().catch(() => {});
    }
  })();
  c.executionCtx.waitUntil(job);
  return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
});

// Post the weekly top list now (same as the Monday cron)
app.post('/api/admin/weekly-top', async (c) => {
  if (!c.env.ADMIN_TOKEN || c.req.header('Authorization') !== `Bearer ${c.env.ADMIN_TOKEN}`) return c.json({ error: 'Not found' }, 404);
  return c.json(await announceWeeklyTop(c.env));
});

// Announce an existing blog in Telegram, e.g. one added before the bot was set up
app.post('/api/admin/announce-blog', async (c) => {
  if (!c.env.ADMIN_TOKEN || c.req.header('Authorization') !== `Bearer ${c.env.ADMIN_TOKEN}`) return c.json({ error: 'Not found' }, 404);
  const blog = await c.env.DB.prepare('SELECT num, name, url FROM blogs WHERE num = ? AND removed = 0').bind(parseInt(c.req.query('num') ?? '', 10)).first();
  if (!blog) return c.json({ error: 'No such blog' }, 404);
  await announceNewBlogs(c.env, [blog]);
  return c.json({ sent: telegramEnabled(c.env), blog });
});

app.notFound(async (c) => notFound(c, await getMeta(c.env.DB, 'stats').catch(() => null)));
app.onError((err, c) => {
  console.error(err);
  return c.text('服务器出错了，请稍后再试', 500);
});

export default {
  fetch: app.fetch,
  // Hourly: crawl the feeds that are due (see nextCheckIn in crawl.js)
  async scheduled(controller, env, ctx) {
    // Weekly cron (see wrangler.jsonc): post the most upvoted articles to Telegram
    if (controller.cron === WEEKLY_CRON) {
      ctx.waitUntil(announceWeeklyTop(env).then((r) => console.log(JSON.stringify({ weeklyTop: r }))).catch((err) => console.error('weekly top failed', err.message)));
      return;
    }
    ctx.waitUntil(crawl(env, { favicons: FAVICONS_PER_RUN, deadline: Date.now() + CRON_BUDGET_MS }));
  },
};

