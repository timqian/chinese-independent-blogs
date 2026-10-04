-- When a failing blog was flagged as 疑似失效. Set by the crawler: after 7 days
-- of failures, or after 1 day when the error is clearly permanent (404, DNS,
-- certificate, not a feed). Cleared as soon as the feed works again.
ALTER TABLE blogs ADD COLUMN dead_since INTEGER;
UPDATE blogs SET dead_since = failing_since + 7 * 86400
WHERE failing_since IS NOT NULL AND failing_since <= strftime('%s', 'now') - 7 * 86400;
CREATE INDEX blogs_dead ON blogs (dead_since);
