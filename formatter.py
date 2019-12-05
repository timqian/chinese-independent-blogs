with open('blogs-original.csv', 'r') as f:
    file_content = f.read()

lines = file_content.split('\n')

content = lines[0] + '\n'

for line in lines[1:]:
    line = line.strip()
    if not line:
        continue

    parts = line.split(',')
    if len(parts) != 4:
        continue
    parts = [part.strip() for part in parts]

    if parts[3]:
        parts[3] = parts[3].strip().replace('；', ';')
        tags = parts[3].split(';')
        tags = [tag.strip() for tag in tags]
        parts[3] = '; '.join([tag for tag in tags if tag])
        content += ', '.join(parts) + '\n'

with open('blogs-original.csv', 'w') as f:
    f.write(content)
