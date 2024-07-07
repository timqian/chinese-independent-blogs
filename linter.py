import csv


csv_file_path = 'blogs-original.csv'

def check_tags(tags: str):
    assert tags == tags.strip(), "leading/trailing whitespace"
    assert not any([tag.startswith(' ') or tag.endswith(' ') for tag in tags.split(',')]), "leading/trailing whitespace in tags"
    assert not any([tag == '' for tag in tags.split(',')]), "empty tag"

    tags_list = tags.split('; ')
    # print(tags_list)
    assert not any([';' in tag for tag in tags_list]), "no trailing space after `;`"
    assert not any([tag for tag in tags_list if tag != tag.strip()]), "leading/trailing whitespace in tags"
    assert len(tags_list) == len(set(tags_list)), "duplicate tag(s)"

def check_csv(csv_file_path):
    with open(csv_file_path, mode='r', encoding='utf-8') as file:
        reader = csv.DictReader(file,skipinitialspace=True,strict=True)
        for row in reader:
            print(row)

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

            if RSS_feed:
                assert RSS_feed.startswith('http://') or RSS_feed.startswith('https://'), "RSS feed does not start with `http(s)://`"
                assert RSS_feed != Address, "RSS feed and Address are the same"

            if tags:
                check_tags(tags)

def check_nnl(csv_file_path):
    with open(csv_file_path, mode='r', encoding='utf-8') as file:
        for i, line in enumerate(file, start=1):
            assert line.endswith('\n'), f"Line {i} does not end with a newline"

def main(csv_file_path):
    check_csv(csv_file_path)
    check_nnl(csv_file_path)


if __name__ == "__main__":
    main(csv_file_path)