-- Profile pictures, stored like favicons. users.avatar_url points at
-- /avatars/<user id>?v=<updated_at> once a row exists here.
CREATE TABLE avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
