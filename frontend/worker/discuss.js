// Upvotes and threaded comments, Hacker News style (no downvotes).
import { requireUser, safeNext } from './auth.js';

const COMMENT_MAX_LENGTH = 5000;
const COMMENT_MIN_INTERVAL = 10;   // seconds between two comments by one user
const COMMENTS_PER_DAY = 100;
// Hot ranking (see hotPosts). Tuned for a site where good posts come slowly:
// votes count for much more than freshness, and prolific blogs get less of
// the free starting point.
const HOT = {
  recentDays: 7,        // every post this recent is a candidate…
  windowDays: 30,       // …voted or discussed posts stay candidates this long
  base: 1,              // free starting point, divided by √(the blog's posts this week)
  voteWeight: 3,        // one upvote = three times a new post's starting point
  commentWeight: 1,
  gravity: 0.8,         // age decay exponent (HN uses 1.8; we used 1.5)
  sameBlogPenalty: 0.4, // each further post from one blog in the ranking is multiplied by this
};

const now = () => Math.floor(Date.now() / 1000);
const wantsJson = (c) => c.req.header('Accept')?.includes('application/json');

// Rendered post pages are edge-cached for anonymous visitors; drop the cached
// copy in this data center so a new comment shows up right away.
function purgePage(c, path) {
  const url = new URL(path, c.req.url).href;
  c.executionCtx.waitUntil(caches.default.delete(new Request(url)).catch(() => {}));
}
const purgePostPage = (c, postId) => purgePage(c, `/p/${postId}`);

// Which of `ids` the user has voted for (posts or comments)
export async function votedIds(db, table, column, userId, ids) {
  if (!userId || !ids.length) return new Set();
  const voted = new Set();
  // D1 allows at most 100 bound parameters per query
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT ${column} AS id FROM ${table} WHERE user_id = ? AND ${column} IN (${chunk.map(() => '?').join(',')})`)
      .bind(userId, ...chunk).all();
    for (const r of results) voted.add(r.id);
  }
  return voted;
}

// HN-style ranking with gentler decay:
//   (base / √weekPosts + votes × voteWeight + comments × commentWeight) / (hours + 2)^gravity
// Every post starts with a point (like HN's submitter vote) so the page works
// before anyone votes, but a blog posting many times a week splits that point
// across its posts. Votes are never discounted.
export async function hotPosts(db) {
  const t = now();
  const { results } = await db.prepare(`
    SELECT p.id, p.url, p.title, p.summary, p.published_at, p.score, p.comment_count,
           b.id AS blog_id, b.num, b.name, b.icon_key
    FROM posts p JOIN blogs b ON b.id = p.blog_id
    WHERE (p.published_at > ? OR ((p.score > 0 OR p.comment_count > 0) AND p.published_at > ?))
      AND b.removed = 0 AND b.dead_since IS NULL
    LIMIT 3000`).bind(t - HOT.recentDays * 86400, t - HOT.windowDays * 86400).all();
  // Posts per blog in the last week (all of them are candidates)
  const weekPosts = new Map();
  for (const p of results) {
    if (t - p.published_at < 7 * 86400) weekPosts.set(p.blog_id, (weekPosts.get(p.blog_id) ?? 0) + 1);
  }
  const rank = (p) => {
    const points = HOT.base / Math.sqrt(weekPosts.get(p.blog_id) ?? 1) + p.score * HOT.voteWeight + p.comment_count * HOT.commentWeight;
    return points / Math.pow(Math.max(t - p.published_at, 0) / 3600 + 2, HOT.gravity);
  };
  const sorted = results.map((p) => ({ p, r: rank(p) })).sort((a, b) => b.r - a.r);
  const seen = new Map();
  for (const x of sorted) {
    const n = seen.get(x.p.blog_id) ?? 0;
    seen.set(x.p.blog_id, n + 1);
    x.r *= HOT.sameBlogPenalty ** n;
  }
  return sorted.sort((a, b) => b.r - a.r).map((x) => x.p);
}

export function registerDiscussRoutes(app) {
  // Toggle an upvote on a post
  app.post('/vote', async (c) => {
    const form = await c.req.parseBody();
    const postId = parseInt(form.post_id, 10);
    const next = safeNext(form.next);
    const blocked = requireUser(c, next);
    if (blocked) return blocked;
    const user = c.get('user');
    const db = c.env.DB;
    const post = await db.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
    if (!post) return c.text('Not found', 404);

    const existing = await db.prepare('SELECT 1 FROM votes WHERE user_id = ? AND post_id = ?').bind(user.id, postId).first();
    await db.batch(existing
      ? [
          db.prepare('DELETE FROM votes WHERE user_id = ? AND post_id = ?').bind(user.id, postId),
          db.prepare('UPDATE posts SET score = MAX(score - 1, 0) WHERE id = ?').bind(postId),
        ]
      : [
          db.prepare('INSERT OR IGNORE INTO votes (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(user.id, postId, now()),
          db.prepare('UPDATE posts SET score = score + 1 WHERE id = ?').bind(postId),
        ]);
    purgePostPage(c, postId);
    purgePage(c, `/u/${user.username}/upvoted`);
    if (wantsJson(c)) {
      const { score } = await db.prepare('SELECT score FROM posts WHERE id = ?').bind(postId).first();
      return c.json({ voted: !existing, score });
    }
    return c.redirect(next, 303);
  });

  // Toggle an upvote on a comment; the author's karma follows
  app.post('/comment-vote', async (c) => {
    const form = await c.req.parseBody();
    const commentId = parseInt(form.comment_id, 10);
    const next = safeNext(form.next);
    const blocked = requireUser(c, next);
    if (blocked) return blocked;
    const user = c.get('user');
    const db = c.env.DB;
    const comment = await db.prepare('SELECT id, user_id, post_id FROM comments WHERE id = ? AND deleted = 0').bind(commentId).first();
    if (!comment) return c.text('Not found', 404);
    if (comment.user_id === user.id) return wantsJson(c) ? c.json({ error: '不能给自己的评论投票' }, 400) : c.redirect(next, 303);

    const existing = await db.prepare('SELECT 1 FROM comment_votes WHERE user_id = ? AND comment_id = ?').bind(user.id, commentId).first();
    const delta = existing ? -1 : 1;
    await db.batch([
      existing
        ? db.prepare('DELETE FROM comment_votes WHERE user_id = ? AND comment_id = ?').bind(user.id, commentId)
        : db.prepare('INSERT OR IGNORE INTO comment_votes (user_id, comment_id, created_at) VALUES (?, ?, ?)').bind(user.id, commentId, now()),
      db.prepare('UPDATE comments SET score = MAX(score + ?, 0) WHERE id = ?').bind(delta, commentId),
      db.prepare('UPDATE users SET karma = MAX(karma + ?, 0) WHERE id = ?').bind(delta, comment.user_id),
    ]);
    purgePostPage(c, comment.post_id);
    if (wantsJson(c)) {
      const { score } = await db.prepare('SELECT score FROM comments WHERE id = ?').bind(commentId).first();
      return c.json({ voted: !existing, score });
    }
    return c.redirect(next, 303);
  });

  // Toggle following a blog (by its public number)
  app.post('/follow', async (c) => {
    const form = await c.req.parseBody();
    const num = parseInt(form.num, 10);
    const next = safeNext(form.next);
    const blocked = requireUser(c, next);
    if (blocked) return blocked;
    const user = c.get('user');
    const db = c.env.DB;
    const blog = await db.prepare('SELECT id FROM blogs WHERE num = ? AND removed = 0').bind(num).first();
    if (!blog) return c.text('Not found', 404);
    const existing = await db.prepare('SELECT 1 FROM follows WHERE user_id = ? AND blog_id = ?').bind(user.id, blog.id).first();
    await (existing
      ? db.prepare('DELETE FROM follows WHERE user_id = ? AND blog_id = ?').bind(user.id, blog.id)
      : db.prepare('INSERT OR IGNORE INTO follows (user_id, blog_id, created_at) VALUES (?, ?, ?)').bind(user.id, blog.id, now())
    ).run();
    // Follower counts show on the blog page and the directory
    for (const path of [`/b/${num}`, `/b/${num}/followers`, `/u/${user.username}/following`, '/blogs', '/blogs/active']) purgePage(c, path);
    if (wantsJson(c)) {
      const { n } = await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE blog_id = ?').bind(blog.id).first();
      return c.json({ following: !existing, followers: n });
    }
    return c.redirect(next, 303);
  });

  app.post('/comment', async (c) => {
    const form = await c.req.parseBody();
    const postId = parseInt(form.post_id, 10);
    const parentId = form.parent_id ? parseInt(form.parent_id, 10) : null;
    const body = String(form.body ?? '').replace(/\r\n/g, '\n').trim();
    const back = `/p/${postId}`;
    const blocked = requireUser(c, back);
    if (blocked) return blocked;
    const user = c.get('user');
    const db = c.env.DB;
    const error = (message) => c.redirect(`${back}?error=${encodeURIComponent(message)}#comment-form`, 303);

    if (!body) return error('评论不能为空。');
    if (body.length > COMMENT_MAX_LENGTH) return error(`评论最多 ${COMMENT_MAX_LENGTH} 个字。`);
    const post = await db.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
    if (!post) return c.text('Not found', 404);
    let parent = null;
    if (parentId) {
      parent = await db.prepare('SELECT user_id, deleted FROM comments WHERE id = ? AND post_id = ?').bind(parentId, postId).first();
      if (!parent) return error('要回复的评论不存在。');
    }
    const t = now();
    const recent = await db.prepare('SELECT MAX(created_at) AS last, COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?')
      .bind(user.id, t - 86400).first();
    if (recent.last && t - recent.last < COMMENT_MIN_INTERVAL) return error('评论太快了，请稍等几秒再发。');
    if (recent.n >= COMMENTS_PER_DAY) return error('今天的评论数已达上限。');

    const [{ results: [inserted] }] = await db.batch([
      db.prepare('INSERT INTO comments (post_id, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
        .bind(postId, parentId, user.id, body, t),
      db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(postId),
    ]);
    // Tell the parent comment's author about the reply (not when replying to yourself)
    if (parent && !parent.deleted && parent.user_id !== user.id) {
      await db.prepare("INSERT INTO notifications (user_id, type, comment_id, created_at) VALUES (?, 'reply', ?, ?)")
        .bind(parent.user_id, inserted.id, t).run();
    }
    purgePostPage(c, postId);
    purgePage(c, `/u/${user.username}`);
    return c.redirect(`${back}#c${inserted.id}`, 303);
  });

  // Authors (and admins) can delete a comment; replies stay visible under "[已删除]"
  app.post('/comment/:id{[0-9]+}/delete', async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const comment = await db.prepare('SELECT id, user_id, post_id FROM comments WHERE id = ? AND deleted = 0')
      .bind(parseInt(c.req.param('id'), 10)).first();
    if (!comment) return c.text('Not found', 404);
    if (!user || (user.id !== comment.user_id && !user.is_admin)) return c.text('Forbidden', 403);
    await db.batch([
      db.prepare("UPDATE comments SET deleted = 1, body = '' WHERE id = ?").bind(comment.id),
      db.prepare('DELETE FROM notifications WHERE comment_id = ?').bind(comment.id),
      db.prepare('UPDATE posts SET comment_count = MAX(comment_count - 1, 0) WHERE id = ?').bind(comment.post_id),
    ]);
    purgePostPage(c, comment.post_id);
    return c.redirect(`/p/${comment.post_id}`, 303);
  });
}
