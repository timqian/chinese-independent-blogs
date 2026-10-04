// Write README.md from blogs-original.csv and data/blogs.json.
//
// Usage: node scripts/render-readme.mjs
//
// Blogs are sorted by their latest post; ones the website flagged as dead go
// to a collapsed section at the end.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseCsvRows } from './lib/feed.mjs';

const CSV_FILE = new URL('../blogs-original.csv', import.meta.url);
// Downloaded from the website by scripts/sync-status.mjs
const DATA_FILE = new URL('../data/blogs.json', import.meta.url);
const README_FILE = new URL('../README.md', import.meta.url);

const beijingDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

function loadHealth() {
  if (!existsSync(DATA_FILE)) return new Map();
  return new Map(JSON.parse(readFileSync(DATA_FILE, 'utf-8')).blogs.map((b) => [b.url, b]));
}

// Text safe inside a markdown table cell
const cell = (text) => text.split(/\s+/).filter(Boolean).join(' ').replace(/\|/g, '\\|');

function lastPostCell(health) {
  const post = health?.lastPost;
  if (!post) return '-';
  const date = beijingDate.format(new Date(post.publishedAt));
  return post.url ? `[${date}](<${post.url}>)` : date;
}

const healthByUrl = loadHealth();
const rows = parseCsvRows(readFileSync(CSV_FILE, 'utf-8')).map((row) => {
  let health = healthByUrl.get(row.Address);
  // Ignore stale data if the feed URL changed since the last check
  if (health && health.feed !== row['RSS feed']) health = undefined;
  return { row, health };
});

const publishedAt = ({ health }) => health?.lastPost?.publishedAt ?? '';
const alive = rows.filter(({ health }) => !health?.dead);
const dead = rows.filter(({ health }) => health?.dead);
// Stable sort: blogs without a known post date keep their original order at the end
alive.sort((a, b) => (publishedAt(b) > publishedAt(a) ? 1 : publishedAt(b) < publishedAt(a) ? -1 : 0));

const aliveRows = alive.map(({ row, health }) =>
  `| ${row['RSS feed'] ? `[Feed](${row['RSS feed']})` : 'None'} | ${row.Introduction} | ${row.Address} | ${lastPostCell(health)} | ${row.tags} |`);
const deadRows = dead.map(({ row, health }) =>
  `| ${row.Introduction} | ${row.Address} | ${cell(health.error ?? health.status)} | ${lastPostCell(health)} |`);

const readme = `# 中文独立博客列表

  [![](https://badgen.net/badge/icon/Website?icon=chrome&label)](https://indi.blog)  [![](https://badgen.net/badge/icon/Telegram?icon=telegram&label)](https://t.me/indieBlogs)  [![](https://badgen.net/badge/icon/Blog?icon=chrome&label)](https://blog.t9t.io/cn-indie-blogs-2019-10-29/) [![g-star](https://gitcode.com/timqian/chinese-independent-blogs/star/badge.svg)](https://gitcode.com/timqian/chinese-independent-blogs)

## Sponsors

[琚致远](https://github.com/juzhiyuan) | [Bytebase](https://bytebase.com/) | [Madao](https://madao.me/) | [SecondState](https://bit.ly/3gfWwps)

[Become a sponsor](https://github.com/sponsors/timqian)

## 目录

- [博客列表](#博客列表)
  - [疑似失效](#疑似失效)
- [什么是独立博客](#什么是独立博客)
  - [如何提交](#如何提交)
- [为什么要收集这张列表](#为什么要收集这张列表)

## 博客列表

> 按最近一篇文章的发布时间排序。RSS 由 [Indi](https://indi.blog) 每小时检测，每天同步到这里（结构化数据见 [data/blogs.json](./data/blogs.json)）。RSS 地址不存在、域名失效等明确错误持续 1 天，或其他错误持续 7 天的博客，会被移到[疑似失效](#疑似失效)。欢迎加入 [Telegram 群](https://t.me/indieBlogs) 讨论如何更好地组织和利用这个列表

| RSS feed | Introduction | Address | 最近更新 | tags |
| --- | --- | --- | --- | --- |
${aliveRows.join('\n')}

### 疑似失效

以下 ${dead.length} 个博客的 RSS 持续抓取失败（404、证书错误、无法连接等），最新情况见 [indi.blog/blogs/dead](https://indi.blog/blogs/dead)。如果你是博主并且博客仍在运行，欢迎提 PR 更新 RSS 地址。

<details>
<summary>展开列表</summary>

| Introduction | Address | 失败原因 | 最近更新 |
| --- | --- | --- | --- |
${deadRows.map((r) => `${r}\n`).join('')}
</details>

## 什么是独立博客

- 拥有自己的域名
- 作者本人原创内容

### 如何提交

1. 在 [./blogs-original.csv](./blogs-original.csv) 尾部添加一行，填入博客的 名称、URL、RSS以及标签
2. 提交 PR
3. (自动) PR 被 merge 之后 README 通过 [scripts/render-readme.mjs](./scripts/render-readme.mjs) 生成

## 为什么要收集这张列表

不止一次听到有人说：“在中国, 独立博客的时代已经过去了”。确实，很多博主都转到了公众号，知乎专栏，小密圈，微博……${'  '}
这些平台读者比较多、他们的推荐算法可以让你的内容被更多人看到。${'  '}
${'  '}
但我还是更喜欢独立博客，因为有属于自己的域名，因为可以自由地排版，自由地说话。

不得不承认，独立博客在如何获取新读者方面确实存在问题。“酒香也怕巷子深”，同样的内容放在自己的博客和上述的“自媒体平台”上，哪怕有自己的主动宣传，读者的增长速度看起来也远不及自媒体平台上的增粉速度，对吧？

是否可以做一个工具，可以连接这些独立博主，在保持独立博客的自由的同时，组织一个独立博客的创作和读者群体，让独立博客们也有一个稳定的被发现的渠道。这个工具可能是一个带个性化推荐系统的 RSS 客户端，可能是一个类似微博、twitter 但是主要内容是独立博客的新东西，读者可以点赞，评论。可以知道我们 follow 的博主 follow 了谁……

这个列表是一个开始，先把独立博客们收集起来。欢迎加入 [Telegram 群](https://t.me/indieBlogs)一起思考和讨论如何构建这样一个工具。

## Thanks

- https://feedly.com
- t9t.io community: https://wewe.t9t.io/chat/t9t.io%20community%202 https://wewe.t9t.io/chat/t9t.io%20community
- https://github.com/DIYgod/RSSHub
- https://ohmyrss.com/
- https://github.com/tangqiaoboy/iOSBlogCN
- https://www.zhihu.com/question/19928148

## 博客构建工具推荐

  - [Blogdown](https://github.com/rstudio/blogdown)
  - [Docusaurus](https://docusaurus.io/)
  - [Gatsby](https://gatsbyjs.org/)
  - [Ghost](https://ghost.org/)
  - [Gridea](https://gridea.dev/)
  - [Halo](https://github.com/halo-dev/halo)
  - [Hexo](https://hexo.io/)
  - [Hugo](https://gohugo.io/)
  - [Jekyll](https://jekyllrb.com/)
  - [Pelican](https://blog.getpelican.com/)
  - [Saber](https://saber.land/)
  - [Typecho](https://typecho.org)
  - [Vuepress](https://vuepress.vuejs.org/)
  - [Wordpress](https://wordpress.com/)
  - [Wowchemy](https://wowchemy.com)
  - [Astro](https://astro.build)
  - [Vanblog](https://vanblog.mereith.com/)

## 博客部署工具推荐

  - [Netlify](https://www.netlify.com/)
  - [Vercel](https://vercel.com/)
  - [Cloudflare Pages](https://pages.cloudflare.com/)

`;

writeFileSync(README_FILE, readme);
console.log(`README.md: ${alive.length} blogs, ${dead.length} flagged dead`);
