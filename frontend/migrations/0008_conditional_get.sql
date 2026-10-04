-- Validators from the last successful feed response, sent back as
-- If-None-Match / If-Modified-Since so unchanged feeds answer 304 with no body.
ALTER TABLE blogs ADD COLUMN etag TEXT;
ALTER TABLE blogs ADD COLUMN last_modified TEXT;
