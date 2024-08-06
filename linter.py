import csv


csv_file_path = 'blogs-original.csv'

def check_tags(tags: str):
    assert tags == tags.strip(), "leading/trailing whitespace"
    assert not any([tag.startswith(' ') or tag.endswith(' ') for tag in tags.split(',')]), "leading/trailing whitespace in tags"
    assert not any([tag == '' for tag in tags.split(',')]), "empty tag"

    tags_list = tags.split('; ')
    # print(tags_list)
    assert not any([';' in tag for tag in tags_list]), "no trailing space after `;`"
    assert not any(['；' in tag for tag in tags_list]), "不应使用中文全角 `；`"
    assert not any([tag for tag in tags_list if tag != tag.strip()]), "leading/trailing space in tags"
    assert not any([tag for tag in tags_list if tag.count(" ") > 1]), "multiple spaces in tag, you should use ';' as separator, or consider using '-'/'_' instead of space"
    assert len(tags_list) == len(set(tags_list)), "duplicate tag(s)"

def check_csv(csv_file_path):
    err = False
    with open(csv_file_path, mode='r', encoding='utf-8') as file:
        reader = csv.DictReader(file,skipinitialspace=True,strict=True)

        addresses = set()
        rss_feeds = set()
        for row in reader:
            try:
                assert None not in row.values(), "None value"
                assert ['Introduction', 'Address', 'RSS feed', 'tags'] == list(row.keys()), "incorrect column names/order"
                assert None not in row, "incorrect number of , characters"
                assert not any(['|' in value for value in row.values()]), "contains `|` character(s)"

                Introduction = row['Introduction']
                Address = row['Address']
                RSS_feed = row['RSS feed']
                tags = row['tags']

                assert Introduction and Address, "empty value"
                assert Introduction == Introduction.strip(), "leading/trailing whitespace"
                assert Address == Address.strip(), "leading/trailing whitespace"
                assert Introduction != Address, "Introduction and Address are the same"

                assert not any(['#' in [Address, RSS_feed]]), "Address or RSS_feed contains `#` character(s)"

                if not Address.endswith('/'):
                    pass
                    # print("Warning: Address does not end with `/`")
                
                assert Address.startswith('http://') or Address.startswith('https://'), "Address does not start with `http(s)://`"

                assert Address not in addresses, "duplicate Address"
                addresses.add(Address)

                if RSS_feed:
                    assert RSS_feed.startswith('http://') or RSS_feed.startswith('https://'), "RSS feed does not start with `http(s)://`"
                    assert RSS_feed != Address, "RSS feed and Address are the same"

                    assert RSS_feed not in rss_feeds, "duplicate RSS feed"
                    rss_feeds.add(RSS_feed)

                if tags:
                    check_tags(tags)
            except Exception as e:
                print(f"Error: {e} in row {reader.line_num}: {row}")
                exit(1)

def check_nnl(csv_file_path):
    with open(csv_file_path, mode='r', encoding='utf-8') as file:
        for i, line in enumerate(file, start=1):
            assert line.endswith('\n'), f"Line {i} does not end with a newline"

def main(csv_file_path):
    check_csv(csv_file_path)
    check_nnl(csv_file_path)


if __name__ == "__main__":
    main(csv_file_path)