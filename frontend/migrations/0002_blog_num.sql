-- Public numeric id for blog pages (/b/<num>). Assigned once when a blog is
-- first inserted (max + 1) and never changed, so URLs stay stable.
ALTER TABLE blogs ADD COLUMN num INTEGER;
UPDATE blogs SET num = position + 1;
CREATE UNIQUE INDEX blogs_num ON blogs (num);
