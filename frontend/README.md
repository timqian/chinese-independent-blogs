# Indi

中文独立博客列表的网站，名字叫 Indi。一个 Node 进程完成全部工作：

- `public/`：静态页面（原生 JS，无构建步骤）
- `src/`：Hono 应用：API、favicon、服务端渲染的页面
- `migrations/`：SQLite 数据库表结构（启动时自动应用）
- `lib/`：Node 相关的基础设施：SQLite 适配、页面缓存、SMTP、定时调度
- 博客名单：每次抓取时从 GitHub 拉取 master 上的 `blogs-original.csv`（`BLOGS_CSV_URL`），合并的 PR 一小时内生效，不用重新部署；拉取失败时用仓库里打包的那份。RSS 解析逻辑和仓库根目录 `scripts/` 下的脚本共用 `../scripts/lib/feed.mjs`

所有抓取到的文章都存进 SQLite（`node:sqlite`，默认 `data/indi.db`），不会因为文章被挤出 RSS 而丢失。页面缓存、定时抓取都在同一个进程里，需要一个 Node ≥ 22.5 的普通服务器（或 Docker）。

## 本地开发

```sh
npm install
cp .env.example .env     # 至少把 CACHE_TTL 改成 0、ADMIN_TOKEN 随便填一个
npm run db:migrate       # 建表（启动时也会自动执行）
npm run db:seed          # 写入一组本地测试博客和最近文章
npm run dev              # http://localhost:8787
```

本地测试登录请使用「邮箱验证码」，不要点 GitHub 登录：输入任意可接受的邮箱后，验证码会打印在终端中（`.env` 里 `EMAIL_DEV_LOG=1` 时不会真正发信），GitHub OAuth 通常只配置了线上回调地址。

`npm run db:seed` 会创建「本地屏蔽测试博客」和 3 篇近期文章，因此“最新”和“最热”页面都有可见内容。登录后进入该博客主页点击「屏蔽」，该博客文章应从你的最新、分类最新和最热页面消失；在用户主页的「屏蔽的博客」标签中取消后，文章会重新出现。该种子命令可重复运行，不会重复插入文章。若想测试真实 RSS 抓取，可保持服务运行并另开终端执行 `npm run crawl`（需要服务端 `.env` 里的 `ADMIN_TOKEN`）；这会向外请求并抓取全部博客，耗时较长。

可以直接用 `npm run db:sql` 查看数据（不需要安装 sqlite3 CLI）：

```sh
npm run db:sql -- "SELECT COUNT(*) FROM posts"
```

## 页面与接口

页面全部在服务端渲染（Hono + `hono/html`），不依赖 JS 就能看到完整内容，方便搜索引擎抓取（百度基本不执行 JS）。`public/app.js` 只负责投票和关注不刷新页面、目录搜索和复制按钮；没有 JS 时这些表单照常可用。

| 路径 | 说明 |
| --- | --- |
| `/`、`/page/2` | 热门（首页）：`(1 ÷ √博客本周发文数 + 票数×3 + 评论数) ÷ (小时数+2)^0.8`，候选为 7 天内的文章及 30 天内有互动的文章；同一博客的文章在榜单中依次乘 0.4。参数在 `src/discuss.js` 的 `HOT` |
| `/latest`、`/latest/page/2` | 最新文章，平铺列表；同一博客同一天超过 2 篇时折叠 |
| `/c/<分类>`、`/c/<分类>/page/2` | 分类下的最新文章 |
| `/blogs`、`/blogs/active`、`/blogs/dead` | 博客目录（全部 / 一年内活跃 / 疑似失效），显示关注数；抓取失败页列出所有当前失败的博客、原因和持续时间，方便纠错 |
| `/b/<数字 id>`、`/b/<id>/page/2` | 博客主页：信息、发文统计、全部文章 |
| `POST /b/<数字 id>/refresh` | 登录后立即重新抓取该博客的 RSS 并更新文章 |
| `/b/<id>/followers` | 关注这个博客的人（公开，`noindex`） |
| `/p/<数字 id>` | 文章讨论页。没有评论前是 `noindex`，避免几万个只有摘要的页面被判为薄内容 |
| `/following`、`/following/page/2` | 我的关注：关注博主的全部文章，按时间倒序（需要登录，`noindex`） |
| `/following/blogs`、`/following.opml` | 管理关注的博客、导出 OPML |
| `/u/<用户名>`、`/u/<用户名>/upvoted`、`/u/<用户名>/following` | 用户主页：评论 / 点赞的文章 / 关注的博客（都公开） |
| `/u/<用户名>/blocked` | 管理自己屏蔽的博客；仅本人可见，屏蔽仅影响自己的最新、分类最新和最热时间线 |
| `/avatars/<用户 id>` | 用户头像 |
| `/random` | 302 到一个最近活跃的博客 |
| `/sitemap.xml`、`/robots.txt` | |
| `/icons/<key>` | 博客 favicon |
| `POST /api/admin/crawl?all=1&favicons=all` | 手动抓取，需要 `Authorization: Bearer $ADMIN_TOKEN` |

博客的数字 id 在第一次入库时分配（当前最大值 + 1），之后不变。渲染好的页面在内存里缓存 `CACHE_TTL` 秒（默认 300），本地开发在 `.env` 里设为 0。

## 部署到普通服务器

需要 Node ≥ 22.5（内置 `node:sqlite`），内存 512 MB 起步（首次全量抓取时解析很多 feed，建议 1 GB）。不需要任何外部数据库或 Cloudflare 账号。

```sh
git clone https://github.com/timqian/chinese-independent-blogs.git /srv/indi && cd /srv/indi
cp frontend/.env.example frontend/.env
vi frontend/.env           # SITE_URL 填正式域名；ADMIN_TOKEN 用 openssl rand -hex 24 生成
cd frontend
npm ci --omit=dev
npm start                  # 启动时自动建表/迁移；用 systemd 托管见下
```

首次全量抓取（会逐条打印进度，可能需要十几分钟到一小时）：

```sh
npm run crawl -- all=1 favicons=all
```

### systemd

```ini
# /etc/systemd/system/indi.service
[Unit]
Description=Indi (chinese-independent-blogs)
After=network.target

[Service]
Type=simple
User=indi
WorkingDirectory=/srv/indi/frontend
EnvironmentFile=/srv/indi/frontend/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
systemctl enable --now indi
```

### nginx 反向代理

```nginx
server {
  listen 80;
  server_name indi.example.com;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;   # 手动抓取会长时间流式输出
    proxy_buffering off;       # 让抓取进度实时显示
  }
}
```

之后用 certbot 配好 HTTPS，并在 `.env` 里把 `SITE_URL` 改为 `https://` 开头的正式域名、`TRUST_PROXY=1`（登录验证码的限流会使用 X-Forwarded-For 里的真实客户端 IP）。没有反代直接暴露时保持 `TRUST_PROXY=0`。

### Docker

```sh
cp frontend/.env.example frontend/.env   # 同样填好 SITE_URL、ADMIN_TOKEN 等
vi frontend/.env
docker compose up -d --build
docker compose logs -f                   # 看日志
```

数据存在名为 `indi-data` 的 volume 里（容器内 `/data/indi.db`），升级时重新 `docker compose up -d --build` 即可，迁移在启动时自动执行。

### 抓取频率

定时任务每小时第 7 分钟在进程内运行，抓取「到期」的博客：30 天内有更新的每 1 小时，一年内有更新的每 3 小时，其余每 12 小时。抓取失败不到 1 天的保持原频率（可能只是临时故障），1–7 天 12 小时一次；连续 7 天失败标记为「疑似失效」，3 天一次，30 天后 7 天一次；超过 90 天标记为「已失效」，每 90 天检查一次（博客可能复活）。恢复后自动回到正常频率；在 CSV 里改了 feed 地址会立即重新抓取。临时错误（网络错误、429、5xx）会在同一轮里重试一次。手动抓取不带 `all=1` 时也只抓到期的博客。设置 `CRAWL=0` 可以关掉进程内抓取（比如想用外部 crontab 调 `npm run crawl`）。

### 配置

全部配置项见 `frontend/.env.example`。服务器上也可以直接用环境变量（systemd 的 `Environment=`、Docker 的 `environment`），环境变量优先于 `.env` 文件。

## 账号与讨论

- 登录方式：GitHub OAuth 和邮箱验证码。同一个已验证邮箱对应同一个账号；邮箱只用于登录，不公开。
- 邮箱登录的新用户需要先在 `/settings` 设置用户名，才能投票和评论。
- 文章投票、嵌套评论、评论投票（不能给自己投），没有 downvote。评论获得的赞计入用户的 karma。
- 屏蔽博客：在博客主页点击「屏蔽」或「取消屏蔽」；被屏蔽博客的文章只对当前用户隐藏，在自己主页的「屏蔽的博客」标签管理。
- 头像：GitHub 用户登录时把 GitHub 头像复制到本站（githubusercontent.com 在国内常常打不开）；也可以在 `/settings` 上传，浏览器先裁剪压缩成 160×160 再上传。只接受 PNG/JPEG/WebP/GIF。
- `/icons/*` 和 `/avatars/*` 的响应带 `Content-Security-Policy: sandbox` 和 `nosniff`：favicon 可能是 SVG，直接打开时不能在本站执行脚本。
- 站内信：有人回复你的评论时，右上角「消息」显示未读数，`/notifications` 查看，打开即标为已读。回复自己不通知；回复被删除时通知一起删除。
- 文章讨论页有评论后才允许搜索引擎收录，并进入 sitemap。
- 本地开发时 `.env` 里的 `EMAIL_DEV_LOG=1` 会把验证码打印到终端，不真正发信。
- 设为管理员（可以删除任何评论）：`npm run db:sql -- "UPDATE users SET is_admin = 1 WHERE username = '<用户名>'"`

上线前需要：

```sh
# GitHub 登录：在 https://github.com/settings/developers 新建 OAuth App，
# 回调地址填 <SITE_URL>/auth/github/callback，把 Client ID / Secret 填进 .env
# （GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET，留空则不显示 GitHub 登录按钮）

# 邮箱验证码：在 .env 里配置 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS，
# 465 端口要设 SMTP_SECURE=1；不配置时验证码只会打印到日志
```

## Telegram 群通知

有新博客收录时（名单同步发现从没见过的博客）立即发一条消息；每周一北京时间 9:00（UTC 01:00）发本周获赞最多的 10 篇文章（统计过去 7 天内的点赞）。未配置时什么都不会发。

```sh
# 用 @BotFather 创建 bot，把它拉进群；chat id 填进 .env 的 TELEGRAM_CHAT_ID（群一般是负数）
# 同样把 bot token 填进 TELEGRAM_BOT_TOKEN，然后重启服务
# 手动发一次周榜：
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://indi.example.com/api/admin/weekly-top
```
