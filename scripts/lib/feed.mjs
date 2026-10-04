// Shared helpers for parsing blogs-original.csv and fetching/parsing feeds.
// Used by the scripts in this folder (Node) and the website's Worker
// (frontend/worker), so it must only use web-standard APIs. No dependencies.

export const USER_AGENT =
  'Mozilla/5.0 (compatible; ChineseIndependentBlogsBot/1.0; +https://github.com/timqian/chinese-independent-blogs)';
const TIMEOUT_MS = 20_000;
// A feed bigger than this is skipped, so one huge (or hostile) response can't
// exhaust a Worker's 128 MB of memory
const MAX_FEED_BYTES = 8 * 1024 * 1024;

// Read a response body as UTF-8 text, giving up past `maxBytes`
export async function readTextCapped(res, maxBytes) {
  if (+res.headers.get('content-length') > maxBytes) {
    res.body?.cancel();
    throw Object.assign(new Error(`response larger than ${maxBytes} bytes`), { code: 'TOO_LARGE' });
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel();
      throw Object.assign(new Error(`response larger than ${maxBytes} bytes`), { code: 'TOO_LARGE' });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
const DAY = 24 * 60 * 60 * 1000;
// Earlier dates are placeholders like 1970-01-01, not real posts
const MIN_DATE = Date.UTC(1995, 0, 1);

// Rows of blogs-original.csv as { Introduction, Address, 'RSS feed', tags }.
// The file has no quoting (scripts/lint.mjs rejects quotes), so a plain split works.
export function parseCsvRows(text) {
  const [header, ...lines] = text.trim().split('\n');
  const keys = header.split(',').map((s) => s.trim());
  return lines.filter((line) => line.trim()).map((line) => {
    const values = line.split(',').map((s) => s.trim());
    return Object.fromEntries(keys.map((k, i) => [k, values[i] ?? '']));
  });
}

export function parseBlogsCsv(text) {
  return parseCsvRows(text).map((row) => {
    return {
      id: blogId(row.Address),
      name: row.Introduction,
      url: row.Address,
      feed: row['RSS feed'],
      tags: row.tags ? row.tags.split(';').map((t) => t.trim()).filter(Boolean) : [],
    };
  });
}

// Stable identifier for a blog, e.g. "www.ruanyifeng.com/blog"
export function blogId(address) {
  try {
    const u = new URL(address);
    return (u.host + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Text content of an XML element (titles, dates, links)
export function decodeText(raw) {
  return decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain text from an element that holds (usually escaped) HTML, e.g. <description>
function htmlToText(raw) {
  let html = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  if (!/<[a-z]/i.test(html)) html = decodeEntities(html);
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(raw, now) {
  const text = decodeText(raw);
  if (!text) return null;
  let d = new Date(text);
  if (Number.isNaN(d.getTime())) {
    const m = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
    if (!m) return null;
    d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  // Ignore obviously bogus dates
  if (d.getTime() > now + 2 * DAY || d.getTime() < MIN_DATE) return null;
  return d;
}

function entryLink(entry, feedType, baseUrl) {
  let link;
  if (feedType === 'sitemap') {
    link = entry.match(/<loc[^>]*>([\s\S]*?)<\/loc>/)?.[1];
  } else {
    // Atom style: <link rel="alternate" href="..."/>; skip rel="self" / "edit" etc.
    for (const [tag] of entry.matchAll(/<link\b[^>]*>/g)) {
      const href = tag.match(/href=["']([^"']+)["']/)?.[1];
      const rel = tag.match(/rel=["']([^"']+)["']/)?.[1];
      if (href && (!rel || rel === 'alternate')) {
        link = href;
        break;
      }
    }
    // RSS style: <link>...</link>
    link ??= entry.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1];
  }
  if (!link) return undefined;
  try {
    const url = new URL(decodeText(link), baseUrl);
    // Feeds are untrusted: a javascript: or data: link would run script on our site
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// Returns { feedType, entryCount, entries } or null if the body isn't a feed.
// `entries` only includes dated entries, newest first.
export function parseFeed(text, baseUrl, now = Date.now()) {
  const head = text.slice(0, 3000);
  let feedType;
  if (/<feed[\s>]/.test(head)) feedType = 'atom';
  else if (/<(rss|rdf:RDF)[\s>]/.test(head)) feedType = 'rss';
  else if (/<urlset[\s>]/.test(head)) feedType = 'sitemap';
  else return null;

  const entryTag = { atom: 'entry', rss: 'item', sitemap: 'url' }[feedType];
  const raw = text.match(new RegExp(`<${entryTag}[\\s>][\\s\\S]*?</${entryTag}>`, 'g')) ?? [];

  // Only look at dates inside entries; channel-level dates are often build times.
  // Prefer publish dates: generators like Hexo set <updated> to the build time.
  const latestDate = (entry, tags) => {
    let date = null;
    for (const [, d] of entry.matchAll(new RegExp(`<(?:${tags})[^>]*>([\\s\\S]*?)<\\/`, 'g'))) {
      const parsed = parseDate(d, now);
      if (parsed && (!date || parsed > date)) date = parsed;
    }
    return date;
  };
  const entries = [];
  for (const entry of raw) {
    const date = latestDate(entry, 'pubDate|published|dc:date|dc:created|issued') ?? latestDate(entry, 'updated|modified|lastmod');
    if (!date) continue;
    const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
    const body = entry.match(/<(description|summary|content:encoded|content)\b[^>]*>([\s\S]*?)<\/\1>/)?.[2];
    entries.push({
      date,
      title: title ? decodeText(title) : undefined,
      url: entryLink(entry, feedType, baseUrl),
      summary: body ? htmlToText(body).slice(0, 200) : undefined,
    });
  }
  entries.sort((a, b) => b.date - a.date);
  return { feedType, entryCount: raw.length, entries };
}

function classifyError(err) {
  if (err.name === 'TimeoutError') return ['network_error', 'timeout'];
  const code = err.cause?.code ?? err.code ?? '';
  const message = err.cause?.message ?? err.message;
  if (/CERT|SSL|TLS/.test(code)) return ['ssl_error', `${code}: ${message}`];
  return ['network_error', code ? `${code}: ${message}` : message];
}

// Fetch and parse one blog's feed.
// Returns { status, error?, feedType?, entryCount?, entries?, redirectedTo? }
// Pass `blog.etag` / `blog.last_modified` from a previous response to make a
// conditional request; an unchanged feed then returns { status: 'not_modified' }.
export async function fetchFeed(blog, now = Date.now()) {
  if (!blog.feed) return { status: 'no_rss' };

  let res, text;
  try {
    res = await fetch(blog.feed, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        ...(blog.etag && { 'If-None-Match': blog.etag }),
        ...(blog.last_modified && { 'If-Modified-Since': blog.last_modified }),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 304) {
      res.body?.cancel();
      return { status: 'not_modified' };
    }
    if (!res.ok) {
      res.body?.cancel();
      return { status: 'http_error', error: `HTTP ${res.status}` };
    }
    text = await readTextCapped(res, MAX_FEED_BYTES);
  } catch (err) {
    if (err.code === 'TOO_LARGE') return { status: 'not_a_feed', error: 'feed larger than 8 MB' };
    const [status, error] = classifyError(err);
    return { status, error: error.slice(0, 200) };
  }

  const feed = parseFeed(text.trimStart(), res.url, now);
  if (!feed) return { status: 'not_a_feed', error: 'response is not RSS/Atom' };
  return {
    status: feed.entries.length ? 'ok' : 'no_dates',
    feedType: feed.feedType,
    entryCount: feed.entryCount,
    entries: feed.entries,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    ...(res.url !== blog.feed && { redirectedTo: res.url }),
  };
}

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      if (++done % 100 === 0) console.error(`${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// Errors worth one more try in the same run: network trouble, rate limiting,
// and server errors (including Cloudflare's 52x origin errors). Not 404s,
// certificate errors or 530 (Cloudflare's "domain doesn't resolve").
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
export function isTransient(result) {
  if (result.status === 'network_error') return true;
  return result.status === 'http_error' && TRANSIENT_HTTP.has(parseInt(result.error?.replace('HTTP ', ''), 10));
}

// Fetch every feed, then retry transient failures once at lower concurrency. Workers only allow 6 requests waiting for headers at a
// time (extra ones queue while their timeout runs), so pass concurrency: 6 there.
export async function fetchAllFeeds(blogs, now = Date.now(), { concurrency = 64, retryConcurrency = 8 } = {}) {
  const results = await mapWithConcurrency(blogs, concurrency, (b) => fetchFeed(b, now));
  const retryIdx = results.flatMap((r, i) => (isTransient(r) ? [i] : []));
  console.error(`Retrying ${retryIdx.length} transient errors`);
  const retried = await mapWithConcurrency(retryIdx.map((i) => blogs[i]), Math.min(retryConcurrency, concurrency), (b) => fetchFeed(b, now));
  retryIdx.forEach((i, j) => (results[i] = retried[j]));
  return results;
}
