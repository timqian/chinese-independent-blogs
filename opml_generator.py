from xml.sax.saxutils import quoteattr


with open('blogs-original.csv', 'r') as f:
    file_content = f.read()

lines = file_content.split('\n')

HEAD = '<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><head><title>中文独立博客列表</title></head><body>'
END = '</body></opml>'
ITEM = '<outline text={title} title={title} type="rss" xmlUrl={rss_link} htmlUrl={link}/>'

content = HEAD

for line in lines[1:]:
    line = line.strip()
    if not line:
        continue

    parts = line.split(',')
    if len(parts) != 4:
        continue
    parts = [part.strip() for part in parts]
    
    if parts[2]:
        content += ITEM.format(title=quoteattr(parts[0]), link=quoteattr(parts[1]), rss_link=quoteattr(parts[2]))

content += END

with open('feed.opml', 'w') as f:
    f.write(content)

