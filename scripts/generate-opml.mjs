// Write feed.opml: every blog in blogs-original.csv that has an RSS feed.
//
// Usage: node scripts/generate-opml.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsvRows } from './lib/feed.mjs';

const CSV_FILE = new URL('../blogs-original.csv', import.meta.url);
const OPML_FILE = new URL('../feed.opml', import.meta.url);

const attr = (value) => `"${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"`;

const outlines = parseCsvRows(readFileSync(CSV_FILE, 'utf-8'))
  .filter((row) => row['RSS feed'])
  .map((row) => `<outline text=${attr(row.Introduction)} title=${attr(row.Introduction)} type="rss" xmlUrl=${attr(row['RSS feed'])} htmlUrl=${attr(row.Address)}/>\n`);

writeFileSync(
  OPML_FILE,
  `<?xml version="1.0" encoding="UTF-8"?><opml version="1.0"><head><title>中文独立博客列表</title></head><body>${outlines.join('')}</body></opml>`,
);
console.log(`feed.opml: ${outlines.length} feeds`);
