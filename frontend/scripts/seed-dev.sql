INSERT OR IGNORE INTO blogs (
  id, name, url, feed, tags, categories, position, removed, status, num
)
SELECT
  'local.dev.block-fixture',
  '本地屏蔽测试博客',
  'https://example.invalid/block-fixture/',
  NULL,
  '[]',
  '["dev"]',
  COALESCE(MAX(position), 0) + 1,
  0,
  'ok',
  COALESCE(MAX(num), 0) + 1
FROM blogs
WHERE 1
ON CONFLICT (id) DO UPDATE SET
  categories = excluded.categories,
  removed = 0,
  status = 'ok';

INSERT INTO posts (blog_id, url, title, summary, published_at, first_seen_at)
VALUES
  ('local.dev.block-fixture', 'https://example.invalid/block-fixture/post-1', '本地测试文章：屏蔽前应显示在最新和最热', '用于本地验证屏蔽功能的测试数据。', unixepoch() - 600, unixepoch()),
  ('local.dev.block-fixture', 'https://example.invalid/block-fixture/post-2', '本地测试文章：分类最新也应被屏蔽', '用于本地验证屏蔽功能的测试数据。', unixepoch() - 1200, unixepoch()),
  ('local.dev.block-fixture', 'https://example.invalid/block-fixture/post-3', '本地测试文章：取消屏蔽后重新显示', '用于本地验证屏蔽功能的测试数据。', unixepoch() - 1800, unixepoch())
ON CONFLICT (blog_id, url) DO UPDATE SET
  title = excluded.title,
  summary = excluded.summary,
  published_at = excluded.published_at;
