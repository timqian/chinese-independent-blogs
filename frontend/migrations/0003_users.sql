-- Users sign in with GitHub or an emailed code. An account found by either
-- method with the same verified email is the same account.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE,  -- NULL until chosen on /welcome
  email TEXT UNIQUE COLLATE NOCASE,     -- verified email, never shown publicly
  github_id INTEGER UNIQUE,
  github_login TEXT,
  avatar_url TEXT,
  karma INTEGER NOT NULL DEFAULT 0,     -- upvotes received on comments
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- One-time sign-in codes sent by email; also used for rate limiting sends.
CREATE TABLE email_codes (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  ip TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX email_codes_email ON email_codes (email, created_at);
CREATE INDEX email_codes_ip ON email_codes (ip, created_at);

CREATE TABLE votes (
  user_id INTEGER NOT NULL REFERENCES users(id),
  post_id INTEGER NOT NULL REFERENCES posts(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX votes_post ON votes (post_id);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  parent_id INTEGER REFERENCES comments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_post ON comments (post_id, created_at);
CREATE INDEX comments_user ON comments (user_id, created_at DESC);

CREATE TABLE comment_votes (
  user_id INTEGER NOT NULL REFERENCES users(id),
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comment_id)
);

-- Denormalized counters so list pages don't need to join votes/comments
ALTER TABLE posts ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX posts_active ON posts (score, comment_count) WHERE score > 0 OR comment_count > 0;
