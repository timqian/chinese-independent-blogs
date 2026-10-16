// In-memory page cache for rendered responses. Replaces the Workers Cache API
// (`caches.default`) now that the site runs as a single Node process; entries
// expire after the max-age the cache middleware puts in Cache-Control, and
// discussion actions delete the affected pages (see purgePage in discuss.js).

const MAX_BYTES = 96 * 1024 * 1024;

const entries = new Map(); // url -> { status, headers, body: Uint8Array, expiresAt, bytes }
let totalBytes = 0;

function remove(key, entry) {
  entries.delete(key);
  totalBytes -= entry.bytes;
}

async function put(request, response) {
  // Never cache personalized responses (the middleware already skips signed-in
  // requests; this also covers Set-Cookie responses like the OAuth handshake)
  if (response.headers.has('Set-Cookie')) return;
  const ttl = parseInt(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] ?? '', 10);
  if (!Number.isFinite(ttl) || ttl <= 0) return;

  const body = new Uint8Array(await response.arrayBuffer());
  const key = request.url;
  const entry = {
    status: response.status,
    headers: [...response.headers],
    body,
    bytes: body.byteLength,
    expiresAt: Date.now() + ttl * 1000,
  };
  const previous = entries.get(key);
  if (previous) remove(key, previous);
  entries.set(key, entry);
  totalBytes += entry.bytes;
  // Map iterates in insertion order: evict the oldest entries first
  for (const [oldKey, old] of entries) {
    if (totalBytes <= MAX_BYTES && entries.size <= 1000) break;
    if (oldKey === key) continue;
    remove(oldKey, old);
  }
}

async function match(request) {
  const entry = entries.get(request.url);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    remove(request.url, entry);
    return undefined;
  }
  return new Response(entry.body, { status: entry.status, headers: entry.headers });
}

async function removeUrl(url) {
  const entry = entries.get(url);
  if (entry) remove(url, entry);
}

export const pageCache = {
  match,
  put,
  delete: removeUrl,
};
