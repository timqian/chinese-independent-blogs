// Check blogs-original.csv before a PR is merged.
//
// Usage: node scripts/lint.mjs
//
// Exits with status 1 and prints the first problem found.
import { readFileSync } from 'node:fs';

const CSV_FILE = new URL('../blogs-original.csv', import.meta.url);
const COLUMNS = ['Introduction', 'Address', 'RSS feed', 'tags'];

class LintError extends Error {}
function check(ok, message) {
  if (!ok) throw new LintError(message);
}

function checkTags(tags) {
  check(tags === tags.trim(), 'leading/trailing whitespace');
  check(!tags.split(',').some((t) => t.startsWith(' ') || t.endsWith(' ')), 'leading/trailing whitespace in tags');
  check(!tags.split(',').some((t) => t === ''), 'empty tag');

  const list = tags.split('; ');
  check(!list.some((t) => t.includes(';')), 'no trailing space after `;`');
  check(!list.some((t) => t.includes('；')), '不应使用中文全角 `；`');
  check(!list.some((t) => t !== t.trim()), 'leading/trailing space in tags');
  check(!list.some((t) => t.split(' ').length - 1 > 1), "multiple spaces in tag, you should use ';' as separator, or consider using '-'/'_' instead of space");
  check(list.length === new Set(list).size, 'duplicate tag(s)');
}

// Fields as Python's csv module with skipinitialspace=True reads them:
// spaces right after a comma are dropped, everything else is kept
const splitRow = (line) => line.split(',').map((field, i) => (i === 0 ? field : field.replace(/^ +/, '')));

function lint(text) {
  check(text.endsWith('\n'), 'the file must end with a newline');
  const lines = text.slice(0, -1).split('\n');
  check(JSON.stringify(splitRow(lines[0])) === JSON.stringify(COLUMNS), 'incorrect column names/order');

  const addresses = new Set();
  const feeds = new Set();
  lines.slice(1).forEach((line, i) => {
    const lineNumber = i + 2;
    try {
      // Quotes would change how CSV readers split the row
      check(!line.includes('"'), 'contains `"` character(s)');
      const values = splitRow(line);
      check(values.length === COLUMNS.length, 'incorrect number of , characters');
      check(!values.some((v) => v.includes('|')), 'contains `|` character(s)');
      const [introduction, address, feed, tags] = values;

      check(introduction && address, 'empty value');
      check(introduction === introduction.trim(), 'leading/trailing whitespace');
      check(address === address.trim(), 'leading/trailing whitespace');
      check(introduction !== address, 'Introduction and Address are the same');
      check(!address.includes('#') && !feed.includes('#'), 'Address or RSS feed contains `#` character(s)');
      check(/^https?:\/\//.test(address), 'Address does not start with `http(s)://`');

      // Ignore scheme, case and trailing slash so near-duplicates are caught
      const normalized = address.split('://')[1].replace(/\/+$/, '').toLowerCase();
      check(!addresses.has(normalized), 'duplicate Address');
      addresses.add(normalized);

      if (feed) {
        check(/^https?:\/\//.test(feed), 'RSS feed does not start with `http(s)://`');
        check(feed !== address, 'RSS feed and Address are the same');
        check(!feeds.has(feed), 'duplicate RSS feed');
        feeds.add(feed);
      }
      if (tags) checkTags(tags);
    } catch (err) {
      if (!(err instanceof LintError)) throw err;
      throw new LintError(`${err.message} in row ${lineNumber}: ${line}`);
    }
  });
  return lines.length - 1;
}

try {
  const rows = lint(readFileSync(CSV_FILE, 'utf-8'));
  console.log(`blogs-original.csv: ${rows} rows OK`);
} catch (err) {
  if (!(err instanceof LintError)) throw err;
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
