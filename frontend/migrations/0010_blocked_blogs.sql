-- Blogs hidden from a user's latest and hot timelines.
CREATE TABLE blocked_blogs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  blog_id TEXT NOT NULL REFERENCES blogs(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blog_id)
);
