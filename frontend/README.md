# Indi

中文独立博客列表的网站，名字叫 Indi。一个 Cloudflare Worker 完成全部工作：

- `public/`：静态页面（原生 JS，无构建步骤）
- `worker/`：API、favicon，以及每小时一次的定时抓取
- `migrations/`：D1 数据库表结构
- 博客名单：每次抓取时从 GitHub 拉取 master 上的 `blogs-original.csv`（`BLOGS_CSV_URL`），合并的 PR 一小时内生效，不用重新部署；拉取失败时用部署时打包的那份。RSS 解析逻辑和仓库根目录 `scripts/` 下的脚本共用 `../scripts/lib/feed.mjs`

所有抓取到的文章都存进 D1，不会因为文章被挤出 RSS 而丢失。

## 本地开发

本地用 wrangler 模拟 D1，数据存在 `.wrangler/state` 里的 SQLite 文件中，不需要 Cloudflare 账号。

```sh
cd frontend
npm install
printf 'ADMIN_TOKEN=local-dev-token\nCACHE_TTL=0\n' > .dev.vars
npm run db:migrate      # 建表
npm run dev             # http://localhost:8787
npm run crawl           # 另开一个终端：抓取全部 feed 和 favicon，约 10 分钟
```

可以直接用 sqlite3 查看本地数据：

```sh
sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite "SELECT COUNT(*) FROM posts"
```

## 页面与接口

页面全部由 Worker 在服务端渲染（Hono + `hono/html`），不依赖 JS 就能看到完整内容，方便搜索引擎抓取（百度基本不执行 JS）。`public/app.js` 只负责投票和关注不刷新页面、目录搜索和复制按钮；没有 JS 时这些表单照常可用。

| 路径 | 说明 |
| --- | --- |
| `/`、`/page/2` | 热门（首页）：`(1 ÷ √博客本周发文数 + 票数×3 + 评论数) ÷ (小时数+2)^0.8`，候选为 7 天内的文章及 30 天内有互动的文章；同一博客的文章在榜单中依次乘 0.4。参数在 `worker/discuss.js` 的 `HOT` |
| `/latest`、`/latest/page/2` | 最新文章，平铺列表；同一博客同一天超过 2 篇时折叠 |
| `/c/<分类>`、`/c/<分类>/page/2` | 分类下的最新文章 |
| `/blogs`、`/blogs/active`、`/blogs/dead` | 博客目录（全部 / 一年内活跃 / 疑似失效），显示关注数；抓取失败页列出所有当前失败的博客、原因和持续时间，方便纠错 |
| `/b/<数字 id>`、`/b/<id>/page/2` | 博客主页：信息、发文统计、全部文章 |
| `/b/<id>/followers` | 关注这个博客的人（公开，`noindex`） |
| `/p/<数字 id>` | 文章讨论页。没有评论前是 `noindex`，避免几万个只有摘要的页面被判为薄内容 |
| `/following`、`/following/page/2` | 我的关注：关注博主的全部文章，按时间倒序（需要登录，`noindex`） |
| `/following/blogs`、`/following.opml` | 管理关注的博客、导出 OPML |
| `/u/<用户名>`、`/u/<用户名>/upvoted`、`/u/<用户名>/following` | 用户主页：评论 / 点赞的文章 / 关注的博客（都公开） |
| `/avatars/<用户 id>` | 用户头像 |
| `/random` | 302 到一个最近活跃的博客 |
| `/sitemap.xml`、`/robots.txt` | |
| `/icons/<key>` | 博客 favicon |
| `POST /api/admin/crawl?all=1&favicons=all` | 手动抓取，需要 `Authorization: Bearer $ADMIN_TOKEN` |

博客的数字 id 在第一次入库时分配（当前最大值 + 1），之后不变。渲染好的页面在边缘缓存 `CACHE_TTL` 秒（默认 300），本地开发在 `.dev.vars` 里设为 0。

## 部署到 Cloudflare

需要 **Workers 付费计划**（$5/月）：免费计划每次运行最多只能发 50 个外部请求，不够抓取。

```sh
npx wrangler login
npx wrangler d1 create independent-blogs   # 把输出的 database_id 填进 wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN
# 在 wrangler.jsonc 里把 SITE_URL 设为正式域名（canonical、sitemap、RSS 都用它）
npm run deploy                              # 执行远程迁移并部署
curl -N -X POST -H "Authorization: Bearer <token>" "https://<域名>/api/admin/crawl?all=1&favicons=all"   # 首次全量抓取
```

之后定时任务每小时抓取「到期」的博客：30 天内有更新的每 1 小时，一年内有更新的每 3 小时，其余每 12 小时。抓取失败不到 1 天的保持原频率（可能只是临时故障），1–7 天 12 小时一次；连续 7 天失败标记为「疑似失效」，3 天一次，30 天后 7 天一次；超过 90 天标记为「已失效」，每 90 天检查一次（博客可能复活）。恢复后自动回到正常频率；在 CSV 里改了 feed 地址会立即重新抓取。临时错误（网络错误、429、5xx）会在同一轮里重试一次。手动抓取不带 `all=1` 时也只抓到期的博客。域名在 Cloudflare 的话，在 Worker 的 Settings → Domains & Routes 里添加自定义域名即可。

## 账号与讨论

- 登录方式：GitHub OAuth 和邮箱验证码。同一个已验证邮箱对应同一个账号；邮箱只用于登录，不公开。
- 邮箱登录的新用户需要先在 `/settings` 设置用户名，才能投票和评论。
- 文章投票、嵌套评论、评论投票（不能给自己投），没有 downvote。评论获得的赞计入用户的 karma。
- 头像：GitHub 用户登录时把 GitHub 头像复制到本站（githubusercontent.com 在国内常常打不开）；也可以在 `/settings` 上传，浏览器先裁剪压缩成 160×160 再上传。只接受 PNG/JPEG/WebP/GIF。
- `/icons/*` 和 `/avatars/*` 的响应带 `Content-Security-Policy: sandbox` 和 `nosniff`：favicon 可能是 SVG，直接打开时不能在本站执行脚本。
- 站内信：有人回复你的评论时，右上角「消息」显示未读数，`/notifications` 查看，打开即标为已读。回复自己不通知；回复被删除时通知一起删除。
- 文章讨论页有评论后才允许搜索引擎收录，并进入 sitemap。
- 本地开发时 `.dev.vars` 里的 `EMAIL_DEV_LOG=1` 会把验证码打印到 `wrangler dev` 的输出里，不真正发信。
- 设为管理员（可以删除任何评论）：`npx wrangler d1 execute independent-blogs --remote --command "UPDATE users SET is_admin = 1 WHERE username = '<用户名>'"`

上线前需要：

```sh
# GitHub 登录：在 https://github.com/settings/developers 新建 OAuth App，
# 回调地址填 <SITE_URL>/auth/github/callback，把 Client ID 填进 wrangler.jsonc 的 GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
# 邮箱验证码：开通发信域名，并把 wrangler.jsonc 里的 EMAIL_FROM 改成这个域名下的地址
npx wrangler email sending enable <域名>
```

## Telegram 群通知

有新博客收录时（名单同步发现从没见过的博客）立即发一条消息；每周一北京时间 9:00 发本周获赞最多的 10 篇文章（统计过去 7 天内的点赞）。未配置时什么都不会发。

```sh
# 用 @BotFather 创建 bot，把它拉进群；chat id 填进 wrangler.jsonc 的 TELEGRAM_CHAT_ID（群一般是负数）
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler deploy
# 手动发一次周榜：curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://indi.blog/api/admin/weekly-top
```
