-- Crawl scheduling: each hourly run fetches the blogs whose next check is due.
-- Healthy feeds come back every 3 hours; failing ones back off (see crawl.js).
ALTER TABLE blogs ADD COLUMN next_check_at INTEGER;
CREATE INDEX blogs_due ON blogs (next_check_at) WHERE removed = 0;
-- Blogs already crawled continue on the normal 3-hour cycle
UPDATE blogs SET next_check_at = last_checked_at + 3 * 3600 WHERE last_checked_at IS NOT NULL;
