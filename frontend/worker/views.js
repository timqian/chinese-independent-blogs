// Server-rendered HTML. Every page is complete without JavaScript, so search
// engines (Baidu doesn't run JS) see the real content; /app.js only adds
// in-place voting and following, and directory search.
import { html, raw } from 'hono/html';
import { CATEGORIES } from './categories.js';

export const SITE_NAME = 'Indi';
// What Indi is, for titles and descriptions that need the Chinese keywords
export const SITE_TAGLINE = '中文独立博客';
const TZ = 'Asia/Shanghai';
const DAY = 86400;

const fDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fTime = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fDate = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fMonth = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric' });

export const categoryName = (id) => CATEGORIES.find(([cid]) => cid === id)?.[1];
// Links to blogs and posts come from feeds and the CSV; only http(s) may become an href
const safeHref = (url) => (/^https?:\/\//i.test(url ?? '') ? url : '#');
const iso = (t) => new Date(t * 1000).toISOString();
const dayKey = (t) => fDayKey.format(t * 1000);
export const host = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};
const hue = (s) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
};
const glyph = (name) => ([...name.replace(/^[\s\p{P}\p{S}]+/u, '')][0] ?? '·').toUpperCase();
const current = (on) => (on ? raw(' aria-current="page"') : '');

function ago(t, now) {
  if (!t) return '—';
  const d = (now - t) / DAY;
  if (d < 1) return '今天';
  if (d < 2) return '昨天';
  if (d < 30) return `${Math.floor(d)} 天前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

// Finer-grained than ago(), for comments
function timeAgo(t, now) {
  const s = now - t;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < DAY) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 30 * DAY) return `${Math.floor(s / DAY)} 天前`;
  return fDate.format(t * 1000);
}

// Favicon over a letter tile; the tile shows if there's no icon or it fails to load
function avatar(blog, cls = '') {
  return html`<span class="av ${cls}" style="--h:${hue(blog.id)}" aria-hidden="true">${glyph(blog.name)}${blog.icon ? html`<img src="${blog.icon}" alt="" loading="lazy" decoding="async">` : ''
    }</span>`;
}

function spark(m, w = 62, h = 16) {
  if (!m) return html`<svg class="spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const max = Math.max(...m, 1);
  const bw = w / 12;
  const bars = m.map((v, i) => {
    const bh = v ? Math.max(3, (v / max) * h) : 2;
    return `<rect class="${v ? 'on' : 'off'}" x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
  });
  const total = m.reduce((a, b) => a + b, 0);
  return html`<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="近 12 个月 ${total} 篇">${raw(bars.join(''))}</svg>`;
}

const favicon = (blog) => avatar(blog, 'sm');

// A user's picture, or a letter tile from their name; round to tell people from blogs
const userAvatar = (u, cls = 'xs') => avatar({ id: u.username ?? '?', name: u.username ?? '?', icon: u.avatar_url }, `round ${cls}`);

// A plain form like voting; following needs an account (it lives on the server)
// Follower count next to the button; `showZero` keeps "0 人关注" visible on blog pages
function followButton(blog, following, next, { showZero = false } = {}) {
  const on = following?.has(blog.num);
  const n = blog.followers ?? 0;
  return html`<div class="follow-box">
    <a class="followers" href="/b/${blog.num}/followers"${n || showZero ? '' : raw(' hidden')}>${n} 人关注</a>
    <form class="follow-form" method="post" action="/follow">
      <input type="hidden" name="num" value="${blog.num}"><input type="hidden" name="next" value="${next}">
      <button type="submit" class="follow" aria-pressed="${on ? 'true' : 'false'}">${on ? '已关注' : '关注'}</button>
    </form>
  </div>`;
}

// A plain form, so voting works without JS; app.js upgrades it to fetch()
function voteForm({ action, field, id, score, voted, next, label }) {
  return html`<form class="vote" method="post" action="${action}">
    <input type="hidden" name="${field}" value="${id}"><input type="hidden" name="next" value="${next}">
    <button type="submit" aria-pressed="${voted ? 'true' : 'false'}" aria-label="${label}" title="${label}">▲</button><span class="score">${score || ''}</span>
  </form>`;
}
const postVote = (p, voted, next) => voteForm({ action: '/vote', field: 'post_id', id: p.id, score: p.score, voted: voted?.has(p.id), next, label: '给这篇文章投票' });

const commentsLink = (p) => html`<a class="discuss" href="/p/${p.id}">${p.comment_count ? `${p.comment_count} 条评论` : '讨论'}</a>`;

function jsonLdScript(data) {
  // Escape "<" so a title can't close the script tag
  return raw(`<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`);
}

function breadcrumbs(site, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: site + path })),
  };
}

const NAV = [
  ['latest', '/latest', '最新'],
  ['blogs', '/blogs', '博客列表'],
  ['following', '/following', '我的关注'],
];

// Shown when "每小时抓取一次 RSS" is clicked; keep in sync with nextCheckIn in crawl.js
const CRAWL_DETAILS = '30 天内有更新的博客每小时检查一次，一年内有更新的每 3 小时，更久没更新的每 12 小时。抓取失败时会先照常重试，失败超过一天后逐步降低频率（12 小时、3 天、7 天）；连续 7 天抓不到标记为疑似失效，超过 90 天标记为已失效、每 90 天才检查一次。恢复后自动回到正常节奏。RSS 没有变化时只发一个很小的请求，不会重复下载。';

// GitHub-style "Star | 12.3k" button, drawn here instead of loading a badge
// image from a third-party service (slow from mainland China)
const GITHUB_MARK = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';
function githubBadge(stars) {
  const count = stars == null ? '' : stars >= 1000 ? `${(stars / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(stars);
  return html`<a class="gh-badge" href="https://github.com/timqian/chinese-independent-blogs" target="_blank" rel="noopener" title="在 GitHub 上给这个项目点 Star">
    <span class="gh-star"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="${GITHUB_MARK}"/></svg>Star</span>${count ? html`<span class="gh-count">${count}</span>` : ''}
  </a>`;
}

// Category links: in the sidebar on wide screens, and as one scrolling row
// above the latest list on narrow ones
function categoryLinks(cat, cls) {
  return html`<nav class="${cls}" aria-label="分类">
    <a href="/latest"${current(cat === '')}>全部</a>
    ${CATEGORIES.map(([id, name]) => html`<a href="/c/${id}"${current(cat === id)}>${name}</a>`)}
  </nav>`;
}

// ---------- layout ----------

export function layout({ site, path, title, description, nav, noindex, jsonLd = [], stats, user, cat = null, body }) {
  const canonical = site + path;
  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
${noindex ? html`<meta name="robots" content="noindex, follow">` : ''}
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
<meta property="og:locale" content="zh_CN">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#12151b" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
${jsonLd.map(jsonLdScript)}
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="brand" href="/" title="${SITE_NAME} · ${SITE_TAGLINE}">${SITE_NAME}</a>
    <nav class="tabs" aria-label="主导航">
      ${NAV.map(([id, href, label]) => html`<a href="${href}"${current(nav === id)}>${label}</a>`)}
    </nav>
    <div class="account">${user
      ? html`${user.username
        ? html`<a class="inbox" href="/notifications" title="${user.unread ? `${user.unread} 条未读回复` : '消息'}">消息${user.unread ? html`<span class="unread">${user.unread > 99 ? '99+' : user.unread}</span>` : ''}</a>
              <a class="me" href="/u/${user.username}" title="${user.username}" aria-label="${user.username}">${userAvatar(user)}</a>`
        : html`<a href="/settings">设置用户名</a>`}`
      : html`<a href="/login?next=${encodeURIComponent(path)}" rel="nofollow">登录</a>`}</div>
  </header>
  <div class="page">
    <main>${body}</main>
    <aside class="side">
      ${stats ? html`<p class="stats">收录 <b>${stats.blogs.toLocaleString('en-US')}</b> 个博客<br>本周 <b>${stats.weekBlogs}</b> 位博主更新<br>24 小时内 <b>${stats.dayPosts}</b> 篇</p>` : ''}
      <h2>分类</h2>
      ${categoryLinks(cat, 'side-cats')}
      <p class="side-links"><a href="/random" rel="nofollow">随机逛一个博客 →</a></p>
      ${githubBadge(stats?.stars)}
      <div class="about">${SITE_NAME} 收录中文独立博客，<details class="hint"><summary>每小时检查一次 RSS。</summary><span class="hint-body">${CRAWL_DETAILS}</span></details>欢迎在 GitHub 上<a href="https://github.com/timqian/chinese-independent-blogs">提交你的博客</a>。</div>
    </aside>
  </div>
</div>
<div class="toast" id="toast" role="status" hidden></div>
</body>
</html>`;
}

function pager(base, page, hasMore, labels = ['← 较新的文章', '更早的文章 →']) {
  if (page <= 1 && !hasMore) return '';
  const href = (n) => (n <= 1 ? base || '/' : `${base}/page/${n}`);
  return html`<nav class="pager" aria-label="翻页">
    ${page > 1 ? html`<a class="btn" rel="prev" href="${href(page - 1)}">${labels[0]}</a>` : html`<span></span>`}
    <span class="pager-page">第 ${page} 页</span>
    ${hasMore ? html`<a class="btn" rel="next" href="${href(page + 1)}">${labels[1]}</a>` : html`<span></span>`}
  </nav>`;
}

// ---------- latest (/latest, /c/:cat) ----------

// A blog showing more than this many posts on one day is folded into a link
const PER_BLOG_PER_DAY = 2;

// Two lines, HN style: title, then blog · time · comments. No summary on lists.
function postItem(p, { now, folded, voted, next, showDate, rank }) {
  return html`<li class="item${rank ? ' ranked-item' : ''}">
    ${rank ? html`<span class="rank">${rank}.</span>` : ''}
    ${postVote(p, voted, next)}
    <div class="item-main">
      <a class="item-title" href="${safeHref(p.url)}" target="_blank" rel="noopener">${p.title || '(无标题)'}</a>
      <div class="meta">
        <a class="who" href="/b/${p.blog.num}">${favicon(p.blog)}${p.blog.name}</a>
        <time datetime="${iso(p.published_at)}">${showDate ? timeAgo(p.published_at, now) : fTime.format(p.published_at * 1000)}</time>
        ${commentsLink(p)}
        ${folded ? html`<a class="more-from" href="/b/${p.blog.num}">同日另有 ${folded} 篇</a>` : ''}
      </div>
    </div>
  </li>`;
}

// A plain list. A blog with more than PER_BLOG_PER_DAY posts on one day shows
// the first ones and folds the rest into a link to its page.
function foldedList(posts, opts) {
  const key = (p) => `${p.blog.num}:${dayKey(p.published_at)}`;
  const count = new Map();
  for (const p of posts) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
  const seen = new Map();
  const items = [];
  for (const p of posts) {
    const n = (seen.get(key(p)) ?? 0) + 1;
    seen.set(key(p), n);
    if (n > PER_BLOG_PER_DAY) continue;
    const total = count.get(key(p));
    items.push(postItem(p, { ...opts, folded: total > PER_BLOG_PER_DAY && n === PER_BLOG_PER_DAY ? total - PER_BLOG_PER_DAY : 0 }));
  }
  return html`<ul class="items">${items}</ul>`;
}

export function timelinePage({ site, stats, user, voted, posts, page, hasMore, cat, now }) {
  const name = cat && categoryName(cat);
  const base = cat ? `/c/${cat}` : '/latest';
  const path = page > 1 ? `${base}/page/${page}` : base;
  const pageSuffix = page > 1 ? ` · 第 ${page} 页` : '';
  const title = name ? `${name}${pageSuffix} · ${SITE_NAME}` : `最新文章${pageSuffix} · ${SITE_NAME}`;
  const description = name
    ? `${SITE_TAGLINE}中「${name}」分类的最新文章，点击直达原博客。`
    : `${stats?.blogs ?? 1400} 个${SITE_TAGLINE}的最新文章，点击直达原博客。`;
  return layout({
    site, stats, user, title, description, path, cat: cat || '',
    nav: 'latest',
    jsonLd: name ? [breadcrumbs(site, [[SITE_NAME, '/'], [name, base]])] : [],
    body: html`
      <h1 class="${name ? 'page-title' : 'visually-hidden'}">${name || '最新文章'}</h1>
      ${categoryLinks(cat || '', 'top-cats')}
      ${posts.length ? foldedList(posts, { now, voted, next: path, showDate: true }) : html`<p class="empty-note">这里还没有文章。</p>`}
      ${pager(base, page, hasMore)}`,
  });
}

// ---------- hot (/) ----------

export function hotPage({ site, stats, user, voted, posts, page, hasMore, now, offset }) {
  const path = page > 1 ? `/page/${page}` : '/';
  const description = `收录 ${stats?.blogs ?? 1400} 个${SITE_TAGLINE}，用一个简单的算法，帮助你找到值得读的内容。`;
  return layout({
    site, stats, user, path, description,
    title: page > 1 ? `热门 · 第 ${page} 页 · ${SITE_NAME}` : `${SITE_NAME} · ${SITE_TAGLINE}`,
    nav: 'hot',
    jsonLd: page === 1 ? [{ '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, alternateName: SITE_TAGLINE, url: `${site}/`, description, inLanguage: 'zh-CN' }] : [],
    body: html`
      <h1 class="visually-hidden">${SITE_NAME} · ${SITE_TAGLINE}热门文章</h1>
      ${posts.length
        ? html`<ol class="items">${posts.map((p, i) => postItem(p, { now, voted, next: path, showDate: true, rank: offset + i + 1 }))}</ol>`
        : html`<p class="empty-note">最近还没有文章。</p>`}
      ${pager('', page, hasMore, ['← 上一页', '下一页 →'])}`,
  });
}

// ---------- directory (/blogs) ----------

const DIRECTORY_VIEWS = {
  all: ['全部', '/blogs'],
  active: ['一年内活跃', '/blogs/active'],
  dead: ['疑似失效', '/blogs/dead'],
};

// A crawl error in words people can act on
function errorReason(error) {
  if (!error) return '抓取失败';
  if (error === 'HTTP 404' || error === 'HTTP 410') return `RSS 地址不存在（${error.slice(5)}）`;
  if (error === 'HTTP 530') return '域名无法解析';
  // Cloudflare's codes for sites behind it: 525/526 bad origin certificate, 521–523 origin unreachable
  if (error === 'HTTP 525' || error === 'HTTP 526') return `证书错误（${error.slice(5)}）`;
  if (['HTTP 521', 'HTTP 522', 'HTTP 523'].includes(error)) return `服务器无响应（${error.slice(5)}）`;
  if (error.startsWith('HTTP 5')) return `服务器错误（${error.slice(5)}）`;
  if (error.startsWith('HTTP ')) return `请求被拒绝（${error.slice(5)}）`;
  if (error === 'ssl_error' || /CERT|SSL|TLS/.test(error)) return '证书错误';
  if (error === 'not_a_feed' || error.startsWith('response is not')) return '返回的不是 RSS';
  return '无法连接';
}

const failureBadge = (b) => html`<span class="badge${b.dead ? '' : ' mild'}">${b.gone ? '已失效' : b.dead ? '疑似失效' : '抓取失败'}</span>`;

function blogRow(b, now, following, next, { showFailure = false } = {}) {
  const search = [b.name, host(b.url), ...b.tags].join(' ').toLowerCase();
  const failingFor = !b.failingSince ? '' : now - b.failingSince < DAY
    ? `${Math.max(1, Math.floor((now - b.failingSince) / 3600))} 小时`
    : `${Math.floor((now - b.failingSince) / DAY)} 天`;
  return html`<li class="blog" data-search="${search}" data-cats="${b.categories.join(' ')}">${avatar(b)}
    <div class="blog-main"><a class="blog-name" href="/b/${b.num}">${b.name}</a>
      <div class="blog-sub">${host(b.url)}${showFailure && b.failingSince
      ? ` · ${errorReason(b.error)} · 已失败 ${failingFor}`
      : b.tags.length ? ` · ${b.tags.slice(0, 4).join(' / ')}` : ''}</div></div>
    <div class="blog-stat">${b.dead || (showFailure && b.failingSince) ? failureBadge(b) : spark(b.monthly)}<span class="ago">${ago(b.last, now)}</span></div>
    ${followButton(b, following, next)}</li>`;
}

export function directoryPage({ site, stats, user, following, blogs, view, now }) {
  const [label, path] = DIRECTORY_VIEWS[view];
  return layout({
    site, stats, user, path,
    title: view === 'all' ? `博客列表 · ${SITE_NAME}` : `博客列表：${label} · ${SITE_NAME}`,
    description: `${blogs.length} 个中文独立博客，按最近更新排序，附每月发文数量。`,
    nav: 'blogs',
    noindex: view === 'dead',
    jsonLd: [breadcrumbs(site, [[SITE_NAME, '/'], ['博客列表', '/blogs']])],
    body: html`
      <h1 class="visually-hidden">博客列表</h1>
      <div class="controls">
        <input type="search" id="q" placeholder="搜索博客名、域名或标签" aria-label="搜索博客">
        <nav class="seg" aria-label="状态">
          ${Object.entries(DIRECTORY_VIEWS).map(([id, [text, href]]) => html`<a href="${href}"${current(id === view)}>${text}</a>`)}
        </nav>
      </div>
      <div class="top-cats always" id="dir-chips">
        <button data-cat="" aria-pressed="true">全部</button>
        ${CATEGORIES.map(([id, name]) => html`<button data-cat="${id}" aria-pressed="false">${name}</button>`)}
      </div>
      <div class="result-count" id="result-count">共 ${blogs.length} 个博客</div>
      ${view === 'dead' ? html`<p class="list-note">以下博客的 RSS 目前抓取失败，最近失败的在前。连续失败 7 天（RSS 不存在、域名失效等明确错误为 1 天）标记为疑似失效，90 天为已失效。如果你知道正确的 RSS 地址，欢迎<a href="https://github.com/timqian/chinese-independent-blogs/edit/master/blogs-original.csv" target="_blank" rel="noopener">在 GitHub 上修改</a>，合并后一小时内会重新抓取。</p>` : ''}
      <ul class="blogs" id="bloglist">${blogs.map((b) => blogRow(b, now, following, path, { showFailure: view === 'dead' }))}</ul>`,
  });
}

// ---------- blog page (/b/:num) ----------

export function blogPage({ site, stats, user, voted, following, blog, posts, page, hasMore, now }) {
  const base = `/b/${blog.num}`;
  const path = page > 1 ? `${base}/page/${page}` : base;
  const latest = posts[0]?.title;
  const description = `${blog.name}（${host(blog.url)}）的全部文章与更新${blog.tags.length ? `，关于${blog.tags.slice(0, 5).join('、')}` : ''}。${latest ? `最近一篇：${latest}` : ''}`.slice(0, 160);
  const total = blog.monthly ? blog.monthly.reduce((a, b) => a + b, 0) : 0;
  const months = Array.from({ length: 12 }, (_, i) => fMonth.format((now - (11 - i) * 30.44 * DAY) * 1000));
  const failingDays = blog.failingSince ? Math.floor((now - blog.failingSince) / DAY) : 0;
  const status = blog.gone
    ? html`<span class="badge">已失效：RSS 已经 ${failingDays} 天无法访问，每 90 天重新检查一次</span>`
    : blog.dead
      ? html`<span class="badge">疑似失效：RSS 已经 ${failingDays} 天无法访问</span>`
      : !blog.feed
        ? html`<span class="badge">没有提供 RSS</span>`
        : html`最近更新 <b>${ago(blog.last, now)}</b>`;
  return layout({
    site, stats, user, description, path,
    title: `${blog.name}${page > 1 ? ` · 第 ${page} 页` : ''} · ${SITE_NAME}`,
    nav: 'blogs',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Blog',
        name: blog.name,
        url: blog.url,
        inLanguage: 'zh-CN',
        ...(blog.tags.length && { keywords: blog.tags.join(', ') }),
        blogPost: posts.slice(0, 10).map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: p.url, datePublished: iso(p.published_at) })),
      },
      breadcrumbs(site, [[SITE_NAME, '/'], ['博客列表', '/blogs'], [blog.name, base]]),
    ],
    body: html`
      <article class="blog-page">
        <header class="bp-head">${avatar(blog, 'lg')}
          <div class="bp-title"><h1>${blog.name}</h1><a href="${safeHref(blog.url)}" target="_blank" rel="noopener">${host(blog.url)} ↗</a>${blog.feed ? html` · <a href="${safeHref(blog.feed)}" target="_blank" rel="noopener nofollow">RSS</a>` : ''}</div>
          ${followButton(blog, following, path, { showZero: true })}
        </header>
        ${blog.tags.length ? html`<div class="tags">${blog.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : ''}
        <div class="bp-pulse">
          <div class="label"><span>${status}</span><span>近 12 个月 ${blog.monthly ? `${total} 篇` : '—'}</span></div>
          ${blog.monthly ? html`${spark(blog.monthly, 480, 44)}<div class="label"><span>${months[0]}</span><span>${months[11]}（本月）</span></div>` : ''}
        </div>
        <h2 class="section-title">文章</h2>
        ${posts.length
        ? html`<ul class="bp-posts">${posts.map((p) => html`<li>
              ${postVote(p, voted, path)}
              <a href="${safeHref(p.url)}" target="_blank" rel="noopener">${p.title || '(无标题)'}</a>
              <span class="bp-post-meta">${commentsLink(p)}<time datetime="${iso(p.published_at)}">${fDate.format(p.published_at * 1000)}</time></span>
            </li>`)}</ul>`
        : html`<p class="empty-note">还没有收录到这个博客的文章。</p>`}
        ${pager(base, page, hasMore)}
      </article>`,
  });
}

// ---------- post page (/p/:id) ----------

// Plain text with blank-line paragraphs; URLs become links that pass no SEO weight
function formatBody(text) {
  const escaped = text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const linked = escaped.replace(/https?:\/\/[^\s<"']+[^\s<"'.,;:!?)\]，。！？）」]/g, (url) => `<a href="${url}" rel="ugc nofollow noopener" target="_blank">${url}</a>`);
  return raw(linked.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join(''));
}

function replyForm(postId, parentId) {
  return html`<form class="comment-form" method="post" action="/comment">
    <input type="hidden" name="post_id" value="${postId}">
    ${parentId ? html`<input type="hidden" name="parent_id" value="${parentId}">` : ''}
    <textarea name="body" rows="${parentId ? 3 : 4}" maxlength="5000" required placeholder="${parentId ? '写下你的回复' : '说说你的看法'}"></textarea>
    <button type="submit" class="btn primary">${parentId ? '回复' : '发表评论'}</button>
  </form>`;
}

function commentTree(comments, { post, user, voted, now }) {
  const children = new Map();
  for (const c of comments) {
    const key = c.parent_id ?? 0;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(c);
  }
  const loginNext = `/login?next=${encodeURIComponent(`/p/${post.id}`)}`;
  const render = (parentId, depth) => (children.get(parentId) ?? []).map((c) => {
    const kids = children.get(c.id);
    // A deleted comment only stays as a placeholder when it has replies
    if (c.deleted && !kids) return '';
    const own = user && user.id === c.user_id;
    return html`<div class="comment" id="c${c.id}" style="--depth:${Math.min(depth, 6)}">
      <div class="c-head">
        ${c.deleted || own ? '' : voteForm({ action: '/comment-vote', field: 'comment_id', id: c.id, score: c.score, voted: voted?.has(c.id), next: `/p/${post.id}#c${c.id}`, label: '给这条评论投票' })}
        ${c.deleted ? html`<span class="c-user">[已删除]</span>` : html`<a class="c-user" href="/u/${c.username}">${userAvatar(c)}${c.username}</a>`}
        <a class="c-time" href="#c${c.id}"><time datetime="${iso(c.created_at)}">${timeAgo(c.created_at, now)}</time></a>
      </div>
      ${c.deleted ? '' : html`<div class="c-body">${formatBody(c.body)}</div>
      <div class="c-actions">
        ${user
          ? html`<details class="reply"><summary>回复</summary>${replyForm(post.id, c.id)}</details>`
          : html`<a href="${loginNext}" rel="nofollow">登录后回复</a>`}
        ${own || user?.is_admin ? html`<form method="post" action="/comment/${c.id}/delete" class="inline-form"><button type="submit" class="link-button">删除</button></form>` : ''}
      </div>`}
      ${kids ? html`<div class="c-children">${render(c.id, depth + 1)}</div>` : ''}
    </div>`;
  });
  return render(0, 0);
}

export function postPage({ site, stats, user, post, blog, morePosts, comments, voted, commentVoted, error, now }) {
  const path = `/p/${post.id}`;
  const title = `${post.title || '(无标题)'} · ${blog.name}`;
  const description = (post.summary || `${blog.name} 发表于 ${fDate.format(post.published_at * 1000)} 的文章。`).slice(0, 160);
  const visible = comments.filter((c) => !c.deleted);
  return layout({
    site, stats, user, title, description, path,
    nav: 'latest',
    // Index a post page only once it has discussion of its own; until then it
    // is just a title and summary, and the original article should rank instead.
    noindex: post.comment_count === 0,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'DiscussionForumPosting',
        headline: post.title,
        url: site + path,
        datePublished: iso(post.published_at),
        author: { '@type': 'Person', name: blog.name, url: blog.url },
        ...(post.summary && { text: post.summary }),
        sharedContent: { '@type': 'WebPage', url: post.url },
        interactionStatistic: [
          { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.comment_count },
          { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: post.score },
        ],
        ...(visible.length && {
          comment: visible.slice(0, 20).map((c) => ({
            '@type': 'Comment', text: c.body, datePublished: iso(c.created_at), author: { '@type': 'Person', name: c.username, url: `${site}/u/${c.username}` },
          })),
        }),
      },
      breadcrumbs(site, [[SITE_NAME, '/'], [blog.name, `/b/${blog.num}`], [post.title || '(无标题)', path]]),
    ],
    body: html`
      <article class="post-page">
        <div class="pp-title">
          ${postVote(post, voted, path)}
          <h1><a href="${safeHref(post.url)}" target="_blank" rel="noopener">${post.title || '(无标题)'}</a></h1>
        </div>
        <div class="meta">
          ${avatar(blog)}<a class="who" href="/b/${blog.num}">${blog.name}</a>
          <span>${host(post.url)}</span>
          <time datetime="${iso(post.published_at)}">${fDate.format(post.published_at * 1000)}</time>
        </div>
        ${post.summary ? html`<p class="pp-summary">${post.summary}…</p>` : ''}
        <a class="btn primary" href="${safeHref(post.url)}" target="_blank" rel="noopener">阅读原文 ↗</a>
        <section class="comments" id="comments">
          <h2 class="section-title">${post.comment_count ? `${post.comment_count} 条评论` : '讨论'}</h2>
          <div id="comment-form">
            ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
            ${user
        ? user.username ? replyForm(post.id) : html`<p class="empty-note"><a href="/settings?next=${encodeURIComponent(path)}">设置用户名</a>后就可以参与讨论。</p>`
        : html`<p class="login-prompt"><a class="btn" href="/login?next=${encodeURIComponent(path)}" rel="nofollow">登录后参与讨论</a></p>`}
          </div>
          ${comments.length ? commentTree(comments, { post, user, voted: commentVoted, now }) : html`<p class="empty-note">还没有评论，来说第一句吧。</p>`}
        </section>
        ${morePosts.length ? html`<section>
          <h2 class="section-title">${blog.name} 的其他文章</h2>
          <ul class="bp-posts">${morePosts.map((p) => html`<li>
            <a href="/p/${p.id}">${p.title || '(无标题)'}</a>
            <time datetime="${iso(p.published_at)}">${fDate.format(p.published_at * 1000)}</time></li>`)}</ul>
        </section>` : ''}
      </article>`,
  });
}

// ---------- user page (/u/:username) ----------

const USER_TABS = [
  ['comments', '', '评论'],
  ['upvoted', '/upvoted', '点赞'],
  ['following', '/following', '关注的博客'],
];

function userHeader(profile, tab, user) {
  const base = `/u/${profile.username}`;
  return html`<header class="user-head">
    ${userAvatar(profile, 'xl')}
    <div>
      <h1>${profile.username}</h1>
      <p class="note">${fDate.format(profile.created_at * 1000)} 加入 · 获得 ${profile.karma} 个赞${profile.github_login ? html` · <a href="https://github.com/${profile.github_login}" rel="nofollow noopener" target="_blank">GitHub</a>` : ''}${user?.id === profile.id ? html` · <a href="/settings">编辑资料</a> · <form method="post" action="/logout" class="inline-form"><button type="submit" class="link-button">退出登录</button></form>` : ''}</p>
    </div>
  </header>
  <nav class="subnav" aria-label="${profile.username} 的动态">
    ${USER_TABS.map(([id, suffix, label]) => html`<a href="${base}${suffix}"${current(tab === id)}>${label}</a>`)}
  </nav>`;
}

export function userPage({ site, stats, user, profile, comments, now }) {
  return layout({
    site, stats, user, path: `/u/${profile.username}`,
    title: `${profile.username} · ${SITE_NAME}`,
    description: `${profile.username} 在 ${SITE_NAME} 的评论。`,
    noindex: comments.length === 0,
    body: html`
      ${userHeader(profile, 'comments', user)}
      ${comments.length
        ? html`<ul class="user-comments">${comments.map((c) => html`<li>
            <div class="c-head"><a href="/p/${c.post_id}#c${c.id}">${timeAgo(c.created_at, now)}</a> · 评论于 <a href="/p/${c.post_id}">${c.post_title || '(无标题)'}</a></div>
            <div class="c-body">${formatBody(c.body)}</div>
          </li>`)}</ul>`
        : html`<p class="empty-note">还没有评论。</p>`}`,
  });
}

export function userUpvotedPage({ site, stats, user, profile, posts, voted, now }) {
  const path = `/u/${profile.username}/upvoted`;
  return layout({
    site, stats, user, path, noindex: true,
    title: `${profile.username} 点赞的文章 · ${SITE_NAME}`,
    description: `${profile.username} 在 ${SITE_NAME} 点赞的文章。`,
    body: html`
      ${userHeader(profile, 'upvoted', user)}
      ${posts.length
        ? html`<ul class="items">${posts.map((p) => postItem(p, { now, voted, next: path, showDate: true }))}</ul>`
        : html`<p class="empty-note">还没有点赞。</p>`}`,
  });
}

// ---------- notifications (/notifications) ----------

export function notificationsPage({ site, stats, user, items, now }) {
  return layout({
    site, stats, user, path: '/notifications', noindex: true,
    title: `消息 · ${SITE_NAME}`,
    description: '回复你的评论。',
    body: html`
      <h1 class="page-title">消息</h1>
      ${items.length
        ? html`<ul class="notifications">${items.map((n) => html`<li class="${n.read_at ? '' : 'is-unread'}">
            <div class="c-head">
              <a class="c-user" href="/u/${n.actor}">${userAvatar({ username: n.actor, avatar_url: n.actor_avatar })}${n.actor}</a> 回复了你 ·
              <a href="/p/${n.post_id}#c${n.comment_id}"><time datetime="${iso(n.created_at)}">${timeAgo(n.created_at, now)}</time></a>
              ${n.read_at ? '' : html`<span class="new-dot">新</span>`}
            </div>
            <a class="n-body" href="/p/${n.post_id}#c${n.comment_id}">${n.body.length > 140 ? `${n.body.slice(0, 140)}…` : n.body}</a>
            <div class="n-post">在《<a href="/p/${n.post_id}">${n.post_title || '(无标题)'}</a>》下</div>
          </li>`)}</ul>`
        : html`<div class="empty"><h2>还没有消息</h2>有人回复你的评论时，会在这里通知你。</div>`}`,
  });
}

// ---------- sign in ----------

export function loginPage({ site, next, github, email = '', error }) {
  return layout({
    site, path: '/login', noindex: true,
    title: `登录 · ${SITE_NAME}`,
    description: `登录 ${SITE_NAME}，给文章投票、参与讨论。`,
    body: html`
      <div class="auth">
        <h1 class="page-title">登录</h1>
        <p class="note">登录后可以给文章投票、参与讨论。没有账号会自动创建。</p>
        ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
        ${github ? html`<a class="btn block-btn" href="/login/github?next=${encodeURIComponent(next)}">使用 GitHub 登录</a><div class="or"><span>或</span></div>` : ''}
        <form method="post" action="/login/email" class="auth-form">
          <input type="hidden" name="next" value="${next}">
          <label for="email">邮箱</label>
          <input type="email" id="email" name="email" value="${email}" required autocomplete="email" placeholder="you@example.com">
          <button type="submit" class="btn primary block-btn">发送验证码</button>
          <p class="note">邮箱只用于登录，不会公开。</p>
        </form>
      </div>`,
  });
}

export function verifyPage({ site, email, next, error }) {
  return layout({
    site, path: '/login', noindex: true,
    title: `输入验证码 · ${SITE_NAME}`,
    description: '输入邮件里的验证码完成登录。',
    body: html`
      <div class="auth">
        <h1 class="page-title">输入验证码</h1>
        <p class="note">验证码已发送到 <b>${email}</b>，10 分钟内有效。没收到的话看看垃圾邮件文件夹。</p>
        ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
        <form method="post" action="/login/verify" class="auth-form">
          <input type="hidden" name="email" value="${email}">
          <input type="hidden" name="next" value="${next}">
          <label for="code">验证码</label>
          <input type="text" id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="6 位数字" autofocus>
          <button type="submit" class="btn primary block-btn">登录</button>
        </form>
        <p class="note"><a href="/login?next=${encodeURIComponent(next)}">换个邮箱或重新发送</a></p>
      </div>`,
  });
}

export function settingsPage({ site, user, next, username, error, avatarError }) {
  const first = !user.username;
  return layout({
    site, user, path: '/settings', noindex: true,
    title: `${first ? '设置用户名' : '账号设置'} · ${SITE_NAME}`,
    description: '设置你在本站显示的用户名和头像。',
    body: html`
      <div class="auth">
        <h1 class="page-title">${first ? '欢迎！先取个用户名' : '账号设置'}</h1>
        <p class="note">用户名会显示在你的评论旁边。2–20 个字符，可以用中文、字母、数字、下划线和连字符。</p>
        ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
        <form method="post" action="/settings" class="auth-form">
          <input type="hidden" name="next" value="${next}">
          <label for="username">用户名</label>
          <input type="text" id="username" name="username" value="${username ?? user.username ?? ''}" required minlength="2" maxlength="20" autocomplete="username">
          <button type="submit" class="btn primary block-btn">保存</button>
        </form>
        ${first ? '' : html`
          <h2 class="section-title">头像</h2>
          ${avatarError ? html`<p class="form-error" role="alert">${avatarError}</p>` : ''}
          <div class="avatar-edit">
            <span id="avatar-preview">${userAvatar(user, 'xl')}</span>
            <div>
              <form method="post" action="/settings/avatar" enctype="multipart/form-data" id="avatar-form" class="avatar-form">
                <input type="file" id="avatar" name="avatar" accept="image/png,image/jpeg,image/webp,image/gif" required>
                <button type="submit" class="btn">上传</button>
              </form>
              <p class="note">PNG、JPEG、WebP 或 GIF。会裁剪成正方形。</p>
              ${user.avatar_url ? html`<form method="post" action="/settings/avatar/delete" class="inline-form"><button type="submit" class="link-button">删除头像</button></form>` : ''}
            </div>
          </div>`}
        ${first ? html`<form method="post" action="/logout" class="inline-form"><button type="submit" class="link-button">退出登录</button></form>` : ''}
      </div>`,
  });
}

// ---------- following (/following) ----------

export function followingPage({ site, stats, user, voted, posts, blogCount, page, hasMore, now }) {
  const path = page > 1 ? `/following/page/${page}` : '/following';
  let body;
  if (!user) {
    body = html`<div class="empty"><h2>登录后关注博客</h2>关注的博主发表的文章，会按时间顺序汇总在这里。<p><a class="btn" href="/login?next=/following" rel="nofollow">登录</a></p></div>`;
  } else if (!blogCount) {
    body = html`<div class="empty"><h2>还没有关注任何博客</h2>在<a href="/blogs">博客列表</a>或博客主页点「关注」，它们的文章会按时间顺序出现在这里。</div>`;
  } else {
    body = html`
      <p class="list-note">${blogCount} 个博客（公开） · <a href="/following/blogs">管理</a> · <a href="/following.opml">导出 OPML</a></p>
      ${posts.length ? html`<ul class="items">${posts.map((p) => postItem(p, { now, voted, next: path, showDate: true }))}</ul>` : html`<p class="empty-note">关注的博客还没有文章。</p>`}
      ${pager('/following', page, hasMore)}`;
  }
  return layout({
    site, stats, user, path, nav: 'following', noindex: true,
    title: `我的关注 · ${SITE_NAME}`,
    description: '你关注的博主发表的文章。',
    body: html`<h1 class="visually-hidden">我的关注</h1>${body}`,
  });
}

// ---------- public follow lists ----------

export function userFollowingPage({ site, stats, user, profile, blogs, following, now }) {
  const path = `/u/${profile.username}/following`;
  return layout({
    site, stats, user, path, noindex: true,
    title: `${profile.username} 关注的博客 · ${SITE_NAME}`,
    description: `${profile.username} 在 ${SITE_NAME} 关注的博客。`,
    body: html`
      ${userHeader(profile, 'following', user)}
      ${blogs.length ? html`<ul class="blogs">${blogs.map((b) => blogRow(b, now, following, path))}</ul>` : html`<p class="empty-note">还没有关注任何博客。</p>`}`,
  });
}

export function blogFollowersPage({ site, stats, user, blog, people, now }) {
  const path = `/b/${blog.num}/followers`;
  return layout({
    site, stats, user, path, noindex: true, nav: 'blogs',
    title: `关注 ${blog.name} 的人 · ${SITE_NAME}`,
    description: `在 ${SITE_NAME} 关注 ${blog.name} 的人。`,
    body: html`
      <h1 class="page-title">关注 <a href="/b/${blog.num}">${blog.name}</a> 的人</h1>
      ${people.length
        ? html`<ul class="people">${people.map((p) => html`<li><a href="/u/${p.username}">${userAvatar(p, 'sm')}${p.username}</a><span>${timeAgo(p.created_at, now)}关注</span></li>`)}</ul>`
        : html`<p class="empty-note">还没有人关注。</p>`}`,
  });
}

export function followingBlogsPage({ site, stats, user, blogs, following, now }) {
  return layout({
    site, stats, user, path: '/following/blogs', nav: 'following', noindex: true,
    title: `关注的博客 · ${SITE_NAME}`,
    description: '你关注的博客。',
    body: html`
      <h1 class="page-title">关注的博客</h1>
      <p class="list-note"><a href="/following">← 返回文章列表</a> · <a href="/following.opml">导出 OPML</a></p>
      ${blogs.length ? html`<ul class="blogs">${blogs.map((b) => blogRow(b, now, following, '/following/blogs'))}</ul>` : html`<p class="empty-note">还没有关注任何博客。</p>`}`,
  });
}

export function followingOpml(blogs) {
  const outlines = blogs.filter((b) => b.feed)
    .map((b) => `  <outline text="${xml(b.name)}" title="${xml(b.name)}" type="rss" xmlUrl="${xml(b.feed)}" htmlUrl="${xml(b.url)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0"><head><title>我在 ${SITE_NAME} 关注的博客</title></head><body>
${outlines}
</body></opml>`;
}

export function errorPage({ site, stats, user, status, message }) {
  return layout({
    site, stats, user,
    title: `${message} · ${SITE_NAME}`,
    description: message,
    path: '/',
    noindex: true,
    body: html`<div class="empty"><h1>${message}</h1><p>${status === 410 ? '这个博客已经从名单中移除。' : '找不到这个页面。'} <a href="/">回到首页</a></p></div>`,
  });
}

// ---------- sitemap ----------

const xml = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function sitemap({ site, blogs, discussed, now }) {
  const url = (path, lastmod) => `  <url><loc>${xml(site + path)}</loc>${lastmod ? `<lastmod>${iso(lastmod).slice(0, 10)}</lastmod>` : ''}</url>`;
  const lines = [
    url('/', now),
    url('/latest', now),
    url('/blogs', now),
    ...CATEGORIES.map(([id]) => url(`/c/${id}`, now)),
    ...blogs.map((b) => url(`/b/${b.num}`, b.last)),
    // Only post pages with discussion are indexable (see postPage)
    ...discussed.map((p) => url(`/p/${p.id}`, p.last)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${lines.join('\n')}
</urlset>`;
}
