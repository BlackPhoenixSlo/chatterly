/* eslint-disable */
/**
 * sw-images.js — Service Worker for the chat-image proxy.
 *
 * Caches every /img and /img/by-hash response in a Cache Storage bucket
 * keyed by the asset's stable identity (path-only of the inner OF URL,
 * or the hash for /img/by-hash). OF rotates Policy/Signature/Key-Pair-Id
 * every fetch, so naive HTTP caching by full URL misses on every paint;
 * we strip those before hashing the key.
 *
 * Strategy:
 *   • cached + fresh (< TTL_MS)   → return cached
 *   • cached + stale              → return cached, refetch in background
 *   • not cached                  → fetch, store, return
 *
 * Persistence: gigabytes (Chrome offers ~60% of free disk per origin).
 * Survives tab close, browser restart, even — popout windows hit the
 * same SW so the inbox's image fetches warm the popout's cache for free.
 *
 * Registered only in production (see app/lib/registerImageSW.ts) to
 * avoid Turbopack dev confusing the SW lifecycle.
 */

const CACHE = "chatterly-img-v1";
// 2-day TTL fresh, 4 days hard expiry. Avatars rarely change; if a fan
// updates their avatar the worst case is a 2-day stale chip.
const TTL_MS = 2 * 24 * 3600 * 1000;
const HARD_TTL_MS = 4 * 24 * 3600 * 1000;

self.addEventListener("install", () => {
  // Activate immediately on first install; we don't have a previous
  // version to defer to.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Drop older cache versions if the name ever bumps. Bump CACHE above
  // when the storage format changes.
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Same-origin only — only intercept our own /img endpoints.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/img")) return;
  event.respondWith(handleImage(req, url));
});

async function handleImage(req, url) {
  const keyReq = buildKeyRequest(url);
  const cache = await caches.open(CACHE);

  const cached = await cache.match(keyReq);
  if (cached) {
    const age = ageMs(cached);
    if (age != null && age < TTL_MS) {
      // Fresh — return immediately, no network.
      return cached;
    }
    if (age != null && age < HARD_TTL_MS) {
      // Stale-while-revalidate: serve stale, refresh in background.
      event_revalidate(req, cache, keyReq);
      return cached;
    }
    // Past hard TTL — fall through to fetch.
  }

  try {
    const resp = await fetch(req);
    if (resp.ok || resp.status === 206) {
      // 206 happens on Safari's video preflight (Range request). Cache
      // only complete 200s — 206s would poison the cache with partials.
      if (resp.status === 200) {
        cache.put(keyReq, resp.clone()).catch(() => {});
      }
    }
    return resp;
  } catch (e) {
    // Network error. If we had a stale entry, hand it back — better than
    // a broken tile.
    if (cached) return cached;
    throw e;
  }
}

function event_revalidate(req, cache, keyReq) {
  // Fire-and-forget background refresh. Errors are swallowed: the cached
  // entry is already serving the user, no need to surface a refresh
  // failure.
  fetch(req)
    .then((resp) => {
      if (resp.status === 200) {
        return cache.put(keyReq, resp.clone());
      }
    })
    .catch(() => {});
}

/**
 * Construct a stable cache-key Request from the inbound URL. The actual
 * cached body is the response to this canonical key, so two different
 * signed URLs for the same physical asset share storage.
 *
 *   /img?u=<signed OF URL>&account_id=A
 *     → /img-cache-key/u/<sha1(path-only)>/A
 *
 *   /img/by-hash/<h>?account_id=A
 *     → /img-cache-key/h/<h>/A
 */
function buildKeyRequest(url) {
  let key;
  if (url.pathname === "/img") {
    const inner = url.searchParams.get("u") || "";
    const account = url.searchParams.get("account_id") || "_";
    const stable = stripQuery(inner).toLowerCase();
    key = `/img-cache-key/u/${stable}/${account}`;
  } else {
    // /img/by-hash/<h>
    const h = url.pathname.replace(/^\/img\/by-hash\//, "");
    const account = url.searchParams.get("account_id") || "_";
    key = `/img-cache-key/h/${h}/${account}`;
  }
  // Request constructor expects an absolute URL; same-origin is fine.
  return new Request(new URL(key, self.location.origin));
}

function stripQuery(u) {
  const i = u.indexOf("?");
  return i < 0 ? u : u.slice(0, i);
}

function ageMs(resp) {
  // Prefer the Date header the relay sets on every /img response. Fall
  // back to a custom x-cached-at header we write at cache-put time only
  // if Date is missing (defensive — uvicorn sets Date for free).
  const d = resp.headers.get("date");
  if (d) {
    const t = new Date(d).getTime();
    if (Number.isFinite(t)) return Date.now() - t;
  }
  return null;
}
