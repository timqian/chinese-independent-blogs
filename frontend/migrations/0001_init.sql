-- Blogs mirror blogs-original.csv plus crawl state. Rows are never deleted:
-- a blog removed from the CSV is marked removed = 1 so its posts stay linked.
CREATE TABLE blogs (
  id TEXT PRIMARY KEY,            -- host + path, e.g. "www.ruanyifeng.com/blog"
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  feed TEXT,
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON array, as written in the CSV
  categories TEXT NOT NULL DEFAULT '[]',  -- JSON array of category ids
  position INTEGER NOT NULL,      -- row order in the CSV
  removed INTEGER NOT NULL DEFAULT 0,
  status TEXT,                    -- ok | no_dates | no_rss | http_error | network_error | ssl_error | not_a_feed
  error TEXT,
  last_checked_at INTEGER,        -- unix seconds
  last_ok_at INTEGER,
  failing_since INTEGER,          -- first failure in the current failure streak
  last_post_at INTEGER,
  icon_key TEXT                   -- set when a favicon is stored
);

-- Every post ever seen in a feed. Feeds only expose their latest entries, so
-- this table is the only place older posts survive.
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  blog_id TEXT NOT NULL REFERENCES blogs(id),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  published_at INTEGER NOT NULL,  -- unix seconds
  first_seen_at INTEGER NOT NULL,
  UNIQUE (blog_id, url)
);
CREATE INDEX posts_published ON posts (published_at DESC);
CREATE INDEX posts_blog_published ON posts (blog_id, published_at DESC);

CREATE TABLE favicons (
  key TEXT PRIMARY KEY,           -- short hash of the blog id, used in /icons/<key>
  blog_id TEXT NOT NULL UNIQUE,
  content_type TEXT,
  data BLOB,                      -- NULL when no icon could be found
  fetched_at INTEGER NOT NULL
);

-- Small key/value store; holds the precomputed homepage snapshot.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
