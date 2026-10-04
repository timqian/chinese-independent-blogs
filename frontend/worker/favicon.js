// Find and download a blog's favicon.
import { readTextCapped, USER_AGENT } from '../../scripts/lib/feed.mjs';

export const FAVICON_MAX_BYTES = 64 * 1024;

const IMAGE_TYPES = [
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/x-icon', (b) => b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8],
  ['image/gif', (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ['image/webp', (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'],
  ['image/svg+xml', (b) => /<svg[\s>]/i.test(ascii(b, 0, 1024))],
];

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

// Detect the format from the bytes; many sites answer /favicon.ico with an HTML page
function imageType(bytes) {
  if (bytes.length < 64 || bytes.length > FAVICON_MAX_BYTES) return null;
  return IMAGE_TYPES.find(([, test]) => test(bytes))?.[0] ?? null;
}

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return res;
}

// Candidate icon URLs from the homepage's <link rel="icon"> tags, best first,
// then /favicon.ico as the fallback.
async function faviconCandidates(siteUrl) {
  const candidates = [];
  let base = siteUrl;
  try {
    const res = await get(siteUrl);
    base = res.url;
    const html = (await readTextCapped(res, 2 * 1024 * 1024)).slice(0, 300_000);
    const head = html.split(/<\/head>/i)[0];
    for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
      const rel = tag.match(/rel\s*=\s*["']?([^"'>]+)/i)?.[1].toLowerCase() ?? '';
      const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? tag.match(/href\s*=\s*([^\s>]+)/i)?.[1];
      if (!href || !/\bicon\b/.test(rel) || rel.includes('mask-icon')) continue;
      const size = parseInt(tag.match(/sizes\s*=\s*["']?(\d+)/i)?.[1] ?? '0', 10);
      const isSvg = /\.svg(\?|$)/i.test(href) || /image\/svg/i.test(tag);
      // Prefer small regular icons around 32–64px; apple-touch-icons (180px) are a decent fallback
      let score = rel.includes('apple-touch') ? 50 : 100;
      if (size) score -= Math.abs(Math.min(size, 128) - 48) / 4;
      if (isSvg) score -= 5;
      try {
        candidates.push({ url: new URL(href.replace(/&amp;/g, '&'), base).href, score });
      } catch {}
    }
  } catch {}
  candidates.sort((a, b) => b.score - a.score);
  const urls = candidates.map((c) => c.url);
  try {
    urls.push(new URL('/favicon.ico', base).href);
  } catch {}
  return [...new Set(urls)];
}

async function download(url) {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:[^;,]*(;base64)?,(.*)$/s);
    if (!m) return null;
    if (m[1]) return Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new TextEncoder().encode(decodeURIComponent(m[2]));
  }
  const res = await get(url);
  if (+res.headers.get('content-length') > FAVICON_MAX_BYTES) {
    res.body?.cancel();
    return null;
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Returns { bytes, contentType } or null
export async function fetchFavicon(siteUrl) {
  for (const url of await faviconCandidates(siteUrl)) {
    try {
      const bytes = await download(url);
      const contentType = bytes && imageType(bytes);
      if (contentType) return { bytes, contentType };
    } catch {}
  }
  return null;
}

export async function iconKey(blogId) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(blogId));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}
