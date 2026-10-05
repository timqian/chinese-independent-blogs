// Telegram group notifications: new blogs (after each list sync) and the
// weekly top upvoted posts. Does nothing unless TELEGRAM_BOT_TOKEN (a secret)
// and TELEGRAM_CHAT_ID are set.

const MAX_NEW_BLOGS = 10;
const WEEK = 7 * 24 * 3600;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const telegramEnabled = (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

async function send(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body).result;
}

// `blogs`: [{ num, name, url }] that were just added to the list
export async function announceNewBlogs(env, blogs) {
  if (!telegramEnabled(env) || !blogs.length) return;
  const site = env.SITE_URL || 'https://indi.blog';
  const shown = blogs.slice(0, MAX_NEW_BLOGS);
  const lines = shown.map((b) => `• <a href="${esc(site)}/b/${b.num}">${esc(b.name)}</a> · ${esc(b.url)}`);
  if (blogs.length > shown.length) lines.push(`…以及另外 ${blogs.length - shown.length} 个`);
  try {
    await send(env, `🆕 新收录 ${blogs.length} 个博客\n${lines.join('\n')}`);
  } catch (err) {
    console.error('Telegram new-blog message failed', err.message);
  }
}

// The 10 posts with the most upvotes cast in the last 7 days
export async function announceWeeklyTop(env, now = Math.floor(Date.now() / 1000)) {
  if (!telegramEnabled(env)) return { sent: false, reason: 'not configured' };
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.url, p.title, b.num AS blog_num, b.name AS blog, COUNT(*) AS votes,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted = 0) AS comments
    FROM votes v JOIN posts p ON p.id = v.post_id JOIN blogs b ON b.id = p.blog_id
    WHERE v.created_at > ? AND b.removed = 0
    GROUP BY p.id ORDER BY votes DESC, p.published_at DESC LIMIT 10`).bind(now - WEEK).all();
  if (!results.length) return { sent: false, reason: 'no votes' };
  const site = env.SITE_URL || 'https://indi.blog';
  // Title links to the article, blog name to its Indi page, the counts to the discussion on Indi
  const dot = ' ● ';
  const lines = results.map((r, i) => `${i + 1}. <a href="${esc(r.url)}">${esc(r.title)}</a>${dot}<a href="${esc(site)}/b/${r.blog_num}">${esc(r.blog)}</a>${dot}<a href="${esc(site)}/p/${r.id}">▲${r.votes} ✎${r.comments}</a>`);
  const msg = await send(env, `🔥 本周获赞最多的 ${results.length} 篇文章\n${lines.join('\n')}`);
  return { sent: true, posts: results.length, messageId: msg?.message_id, chat: msg?.chat, thread: msg?.message_thread_id };
}

// Which chat the bot is posting to (does not send anything)
export async function describeChat(env) {
  if (!telegramEnabled(env)) return { configured: false };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(env.TELEGRAM_CHAT_ID)}`, { signal: AbortSignal.timeout(10_000) });
  const { result } = await res.json();
  return { id: result?.id, type: result?.type, title: result?.title, username: result?.username, is_forum: result?.is_forum };
}
