// Update the generated blog-list section from blogs-original.csv and data/blogs.json.
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

const existingReadme = readFileSync(README_FILE, 'utf-8');
const sectionHeading = '## 博客列表\n';
const sectionStart = existingReadme.indexOf(sectionHeading);
if (sectionStart === -1 || existingReadme.indexOf(sectionHeading, sectionStart + sectionHeading.length) !== -1) {
  throw new Error('README.md must contain exactly one "## 博客列表" heading');
}

const readmePrefix = existingReadme.slice(0, sectionStart);
const generatedSection = `## 博客列表

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
`;

const readme = `${readmePrefix}${generatedSection}`;
writeFileSync(README_FILE, readme);
console.log(`README.md: ${alive.length} blogs, ${dead.length} flagged dead`);
