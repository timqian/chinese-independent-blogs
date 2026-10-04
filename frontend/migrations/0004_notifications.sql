-- In-site notifications. For now the only kind is a reply to your comment.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),        -- recipient
  type TEXT NOT NULL,                                   -- 'reply'
  comment_id INTEGER NOT NULL REFERENCES comments(id),  -- the reply
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_comment ON notifications (comment_id);
