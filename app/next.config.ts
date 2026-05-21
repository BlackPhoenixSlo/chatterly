import type { NextConfig } from "next";

/**
 * Dev rewrites: the browser only ever talks to localhost:3001 (the
 * Next.js dev server). Anything that's a relay endpoint — signed OF
 * paths, admin CRUD, SSE — gets transparently proxied to the Python
 * relay on localhost:8787. This keeps the share-token cookie + the
 * SameSite story trivial, and the relay never sees CORS preflight.
 *
 * Production: a single reverse proxy fronts both, so rewrites are a no-op.
 */

const RELAY_URL = process.env.RELAY_URL || "http://127.0.0.1:8787";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next 16 blocks cross-origin dev requests by default. The dev server binds
  // to `localhost:3001` but you may visit via `127.0.0.1:3001` (or LAN IP) —
  // without this, the HMR + chunk loaders 403 and hydration silently stalls
  // on the SSR placeholder.
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.0.27", "macbook-pro.tailca1348.ts.net"],
  async rewrites() {
    return [
      // Health + admin CRUD (employees, audit, accounts, proxies, sessions, rev).
      { source: "/health",       destination: `${RELAY_URL}/health` },
      { source: "/admin/:path*", destination: `${RELAY_URL}/admin/:path*` },
      // The signed OF mirror — anything the browser asks at /api/of/v2/*
      // we proxy untouched. Same handler that powers the existing /ui/.
      { source: "/api/of/:path*", destination: `${RELAY_URL}/api/of/:path*` },
      // CDN image proxy — relay tunnels the fetch through the account's
      // own egress IP, since OF CDN URLs are signed to a specific source IP.
      // /img is the base proxy; /img/scrub and /img/by-hash are sub-routes
      // for the storyboard cache and the stable-hash alias.
      { source: "/img",            destination: `${RELAY_URL}/img` },
      { source: "/img/:path*",     destination: `${RELAY_URL}/img/:path*` },
      // SSE channel + the legacy WebSocket endpoint (Next.js rewrites
      // pass WS upgrades through transparently).
      { source: "/events",       destination: `${RELAY_URL}/events` },
      { source: "/ws/:path*",    destination: `${RELAY_URL}/ws/:path*` },
      // Legacy /ui served by the relay's StaticFiles mount. We expose the
      // funnel at the Next dev port so the new /inbox UI is the default
      // entry, but /ui must still resolve so existing share-token links
      // (and ops cheat-sheet URLs) keep working.
      { source: "/ui",           destination: `${RELAY_URL}/ui/` },
      { source: "/ui/",          destination: `${RELAY_URL}/ui/` },
      { source: "/ui/:path*",    destination: `${RELAY_URL}/ui/:path*` },
      // Drift detection.
      { source: "/admin/rev/:path*", destination: `${RELAY_URL}/admin/rev/:path*` },
    ];
  },
  // Skip image optimization for now — OF media URLs are CDN-hosted with
  // their own caching; Next's loader adds latency for no gain.
  images: { unoptimized: true },
};

export default nextConfig;
