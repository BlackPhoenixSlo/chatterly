"use client";

/**
 * VaultPicker — modal dialog over the chat surface for picking vault
 * media to attach to an outgoing message.
 *
 * Multi-select. Tap a tile to toggle; the selected count + Attach button
 * live in the footer. Type filter chips (all / photo / video / gif)
 * reset pagination. Infinite scroll via IntersectionObserver on the
 * sentinel at the bottom.
 *
 * Returns the chosen media as VaultMedia[] so the caller can render
 * preview chips immediately without re-fetching. The Composer keeps
 * only their ids in send-payload form.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { useVaultLists, useVaultMedia } from "@/hooks/useVaultMedia";
import { useFanVaultHistory, type FanVaultEntry } from "@/hooks/useFanVaultHistory";
import { useWallMedia } from "@/hooks/useWallMedia";
import { useBlurMode, blurImageClass } from "@/hooks/useBlurMode";
import { proxyImage, proxyScrubFrame, type VaultMedia } from "@/lib/relay";

// Hover-preview slideshow tuning. 12 evenly-spaced frames @ 600ms each
// cycles a full video clip in 7.2 seconds — comfortable scrub speed and
// long enough that a user actually paying attention can pick the moment
// they want before clicking through.
const SCRUB_FRAMES = 12;
const SCRUB_INTERVAL_MS = 600;

type MediaType = "all" | "photo" | "video" | "gif";
type Sort = "newest" | "oldest";

const TYPE_CHIPS: Array<{ value: MediaType; label: string }> = [
  { value: "all",   label: "All"    },
  { value: "photo", label: "Photos" },
  { value: "video", label: "Videos" },
  { value: "gif",   label: "GIFs"   },
];

const MRU_CAP = 3;

interface PickerFanState {
  listId: number | null;
  sort: Sort;
  type: MediaType;
}

function fanStateKey(accountId: string | null, fanId: number | null): string | null {
  if (!accountId || fanId == null) return null;
  return `chatterly:vault-state:${accountId}:${fanId}`;
}

function fanMruKey(accountId: string | null, fanId: number | null): string | null {
  if (!accountId || fanId == null) return null;
  return `chatterly:vault-mru:${accountId}:${fanId}`;
}

function accountCountsKey(accountId: string | null): string | null {
  if (!accountId) return null;
  return `chatterly:vault-folder-counts:${accountId}`;
}

/** Full picker state for one fan — folder, sort order, media type. We
 *  persist all three so reopening the picker is byte-identical to where
 *  the chatter left it (no forced "pop to last folder" surprises). */
function loadFanState(accountId: string | null, fanId: number | null): PickerFanState | null {
  const k = fanStateKey(accountId, fanId);
  if (!k || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PickerFanState>;
    return {
      listId: typeof parsed.listId === "number" ? parsed.listId : null,
      sort: parsed.sort === "oldest" ? "oldest" : "newest",
      type:
        parsed.type === "photo" || parsed.type === "video" || parsed.type === "gif"
          ? parsed.type
          : "all",
    };
  } catch {
    return null;
  }
}

function saveFanState(accountId: string | null, fanId: number | null, state: PickerFanState): void {
  const k = fanStateKey(accountId, fanId);
  if (!k || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(k, JSON.stringify(state));
  } catch { /* quota / private mode — ignore */ }
}

/** Per-fan folder MRU. Drives the quick-chip row when this specific fan
 *  has history. Most-recent first, capped at MRU_CAP. */
function loadFanMru(accountId: string | null, fanId: number | null): number[] {
  const k = fanMruKey(accountId, fanId);
  if (!k || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(k);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number").slice(0, MRU_CAP);
  } catch { return []; }
}

function saveFanMru(accountId: string | null, fanId: number | null, mru: number[]): void {
  const k = fanMruKey(accountId, fanId);
  if (!k || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(k, JSON.stringify(mru.slice(0, MRU_CAP)));
  } catch { /* ignore */ }
}

/** Account-wide folder usage counters — sum of picks across every fan.
 *  Used as the fallback ranking when the current fan has no per-fan
 *  history yet, so the chip row still shows folders the chatter
 *  actually uses (not just the first three OF returns). */
function loadAccountCounts(accountId: string | null): Record<string, number> {
  const k = accountCountsKey(accountId);
  if (!k || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(k);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
  } catch { return {}; }
}

function bumpAccountCount(accountId: string | null, folderId: number): void {
  const k = accountCountsKey(accountId);
  if (!k || typeof window === "undefined") return;
  try {
    const cur = loadAccountCounts(accountId);
    cur[String(folderId)] = (cur[String(folderId)] || 0) + 1;
    window.localStorage.setItem(k, JSON.stringify(cur));
  } catch { /* ignore */ }
}

export interface VaultPickerProps {
  open: boolean;
  onClose: () => void;
  accountId: string | null;
  /** When provided, we fetch per-fan send/purchase history and show a
   *  status badge on each tile + enable the fan-aware filter chips.
   *  Leave null for mass-message or post-builder usages where there's
   *  no single fan in scope. */
  fanId?: number | null;
  /** Already-attached ids from the Composer so we can pre-select them. */
  initialSelectedIds: number[];
  /** Caller receives the full media objects so it can render previews. */
  onConfirm: (picked: VaultMedia[]) => void;
}

export function VaultPicker({ open, onClose, accountId, fanId = null, initialSelectedIds, onConfirm }: VaultPickerProps) {
  const [type, setType] = useState<MediaType>("all");
  const [listId, setListId] = useState<number | null>(null);
  const [sort, setSort] = useState<Sort>("newest");
  // Per-fan folder MRU (last 3 used). Lives in localStorage so it
  // survives reloads + transfers between tabs.
  const [folderMru, setFolderMru] = useState<number[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set(initialSelectedIds));
  // Cache of media metadata for ids the user picked across filter switches
  // so we can return the full VaultMedia[] on confirm even if the user
  // selects from one filter then jumps to another.
  const [selectedMeta, setSelectedMeta] = useState<Map<number, VaultMedia>>(
    () => new Map(),
  );

  const vault = useVaultMedia({ accountId, type, listId, enabled: open });
  const listsQ = useVaultLists(accountId, open);
  // Per-fan history only matters when a fan is in scope. The query is
  // cheap (local sqlite) so we fire as soon as the picker opens.
  const historyQ = useFanVaultHistory(accountId, fanId ?? null, open);
  const historyMap = historyQ.data?.by_media ?? {};
  // Wall-posted ids drive the blue ring. Pure decoration, never blocking.
  // Gate the fetch so it doesn't fire alongside the initial vault load —
  // we wait until vault has finished its INITIAL fetch (isLoading=false)
  // before kicking off the ~15s post-walk. Once we flip to ready, we stay
  // ready for the rest of this open: tearing down a half-finished
  // wall-media on every folder switch / background refetch was the bug
  // — the walk never got to finish before being cancelled again, so the
  // rings would never appear (or only flash before vanishing).
  // Closing the picker resets so the next open re-gates on its own
  // initial vault load.
  const [wallReady, setWallReady] = useState(false);
  useEffect(() => {
    if (!open) {
      setWallReady(false);
      return;
    }
    if (wallReady) return;
    if (vault.isLoading) return;
    setWallReady(true);
  }, [open, vault.isLoading, wallReady]);
  const wall = useWallMedia(accountId, open && wallReady);
  const [blurMode] = useBlurMode();
  const blurCls = blurImageClass(blurMode);
  // Hover-to-preview is a 12-frame slideshow served by the relay's
  // /img/scrub endpoint. The previous implementation streamed the actual
  // mp4 through two <video> elements + a canvas scrub pipeline, which
  // pinned uvicorn threadpool slots and deadlocked the relay when users
  // browsed a lot of video tiles. The storyboard approach replaces all
  // that with 12 small JPGs (~20KB each, served from a disk cache the
  // relay populates on first hit), so a hover is at most 12 lightweight
  // image GETs — no streams to stop on switch because there are no
  // streams at all.
  const [hoveredVideoId, setHoveredVideoId] = useState<number | null>(null);
  // Tile-render closures capture `isHovering = hoveredVideoId === m.id` at
  // render time; onLoad/onError handlers fire asynchronously and the user
  // may have moved to another tile before they fire. Comparing m.id against
  // the LATEST hoveredVideoId via ref avoids stale-closure scrubReady flips
  // affecting the wrong tile.
  //
  // useLayoutEffect (NOT useEffect) is critical: when a storyboard is
  // already cached, the browser fires <img>.onLoad synchronously after the
  // commit, BEFORE the post-paint useEffect would update the ref. The guard
  // then rejects (ref still holds prior value), scrubReady never flips,
  // the visible img stays at opacity:0, and only frame 0 ever "shows"
  // (it's actually invisible, but the static thumb beneath leaks through
  // long enough to look like a stuck frame 0). useLayoutEffect runs after
  // commit + before paint, so the ref is current by the time onLoad fires.
  const hoveredVideoIdRef = useRef<number | null>(null);
  useLayoutEffect(() => { hoveredVideoIdRef.current = hoveredVideoId; }, [hoveredVideoId]);
  // Duration of the hovered video, captured at hover-commit time so the
  // countdown effect can compute the wait estimate without needing to
  // forward-reference visibleItems (which is declared after the effect).
  const [hoveredVideoDuration, setHoveredVideoDuration] = useState<number>(0);
  // Raw signed OF URL of the hovered video. Captured so the hover-end
  // cleanup can POST /img/scrub/cancel for THIS specific video — the
  // server-side build loop polls the cancel flag and aborts if the
  // download hasn't crossed ~90%. Without this we'd waste bandwidth
  // (and queue time) on videos the user has already moved past.
  const [hoveredVideoUrl, setHoveredVideoUrl] = useState<string | null>(null);
  // Click-to-open full preview. Storing the whole VaultMedia so the modal
  // has access to videoSources + thumb without re-finding it in the list.
  const [previewMedia, setPreviewMedia] = useState<VaultMedia | null>(null);
  // True while the OF thumb is still the only visible thing — flips to
  // false the moment the first storyboard frame paints. We DON'T show a
  // spinner anymore; the thumb itself is the "loading" state, and the
  // slideshow fades in on top of it once frames are ready.
  const [hoverLoading, setHoverLoading] = useState<boolean>(false);
  // Slideshow cursor — increments mod SCRUB_FRAMES every SCRUB_INTERVAL_MS.
  const [scrubFrameIdx, setScrubFrameIdx] = useState<number>(0);
  // Gate for prefetching frames 1..11. Set true after frame 0 lands so
  // we don't fire 12 parallel requests at once — they'd all pile up on
  // the relay's per-video build lock and Next dev's HTTP proxy would
  // time out on most of them (the ECONNRESET storm we saw).
  const [scrubReady, setScrubReady] = useState<boolean>(false);
  // Countdown shown over the shimmer while the relay extracts the
  // storyboard for a cold video. Initial value is an estimate from the
  // video's duration (relay's measured build time is ≈1s + ~4.5s/min of
  // video). Ticks down 5×/sec so the number feels live. If the frame
  // actually loads before the countdown finishes, the whole overlay is
  // unmounted by `hoverLoading` → false; if the countdown hits 0 first
  // we just show "…" until the frame lands.
  const [scrubCountdownSec, setScrubCountdownSec] = useState<number>(0);
  // Per-hover session id. Recomputed synchronously each time the user
  // commits to a new hovered video. The id is forwarded with both the
  // /img/scrub frame requests AND the /img/scrub/cancel POST, so the
  // server can scope cancellation to THIS hover session — a delayed
  // cancel from a previous hover of the same video can't reach into a
  // freshly-started build for the same hash. Empty string when no hover.
  const hoverSessionId = useMemo<string>(() => {
    if (hoveredVideoId == null) return "";
    // crypto.randomUUID is available in every browser we target. Fall
    // back to a Math.random concoction only if missing (super old WebView).
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }, [hoveredVideoId]);
  useEffect(() => {
    if (hoveredVideoId == null) {
      setHoverLoading(false);
      setScrubReady(false);
      setScrubFrameIdx(0);
      setScrubCountdownSec(0);
      return;
    }
    setHoverLoading(true);
    setScrubReady(false);
    setScrubFrameIdx(0);
    // Duration was captured at hover-commit (see startHoverIntent).
    // Piecewise estimate, calibrated against real cold-build timings
    // with +2s baseline padding across the board so the countdown
    // rarely under-promises in practice:
    //   • ≤ 60s: 4.5 + 0.5 × ceil(dur/15)
    //       — 15s clip ≈ 5s, 30s ≈ 6s, 60s ≈ 7s
    //   • > 60s: 6.5 + 7 × (dur − 60) / 60
    //       — slope is 7s per minute past the 1-min mark, since the
    //         proxy throughput dominates here and longer videos pay
    //         linearly. 2 min ≈ 14s, 4 min ≈ 28s, 8 min ≈ 56s.
    // Min 4s so the countdown still feels honest on tiny clips.
    const dur = Math.max(1, hoveredVideoDuration);
    const estimate = dur <= 60
      ? Math.max(4, Math.round(4.5 + 0.5 * Math.ceil(dur / 15)))
      : Math.max(4, Math.round(6.5 + (7 * (dur - 60)) / 60));
    setScrubCountdownSec(estimate);
    const startedAt = Date.now();
    const slideId = window.setInterval(() => {
      setScrubFrameIdx((n) => (n + 1) % SCRUB_FRAMES);
    }, SCRUB_INTERVAL_MS);
    const tickId = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      setScrubCountdownSec(Math.max(0, estimate - elapsed));
    }, 200);
    // Capture the URL + session id of the hover THIS effect is associated
    // with — the cleanup needs both to cancel the right build. The
    // session id makes the cancel race-safe: if the user re-hovers the
    // same video quickly, the new build runs under a NEW session id, so
    // a late-arriving cancel POST from this hover targets a stale session
    // the server has already cleaned up.
    const urlForCancel = hoveredVideoUrl;
    const sidForCancel = hoverSessionId;
    return () => {
      window.clearInterval(slideId);
      window.clearInterval(tickId);
      // Fire-and-forget: tell the relay to abort the in-flight download
      // for this hover session. Server ignores the cancel if it's already
      // past the keep-threshold (~90% downloaded) or if no build is
      // active for this session id. `keepalive: true` lets the request
      // survive even if the user closes the picker immediately.
      if (urlForCancel) {
        const tok = typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("t")
            ?? window.localStorage.getItem("chatterly:share_token")
          : null;
        const qs = new URLSearchParams();
        qs.set("u", urlForCancel);
        if (sidForCancel) qs.set("sid", sidForCancel);
        if (tok) qs.set("t", tok);
        fetch(`/img/scrub/cancel?${qs.toString()}`, {
          method: "POST",
          keepalive: true,
        }).catch(() => { /* fire-and-forget */ });
      }
    };
  }, [hoveredVideoId, hoveredVideoDuration, hoveredVideoUrl, hoverSessionId]);

  // Hover-dwell debounce. We won't kick off a hover preview until the
  // pointer has been over a tile for HOVER_DELAY_MS — kills "brush past
  // 20 tiles in 200ms" thrash. The relay only pays the storyboard build
  // cost (~1-3s of ffmpeg on first hit) when the user actually commits.
  const HOVER_DELAY_MS = 400;
  const hoverTimerRef = useRef<number | null>(null);
  const startHoverIntent = (id: number, duration: number, rawUrl: string | null) => {
    if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHoveredVideoDuration(duration || 0);
      setHoveredVideoUrl(rawUrl || null);
      setHoveredVideoId(id);
    }, HOVER_DELAY_MS);
  };
  const cancelHoverIntent = (id: number) => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredVideoId((cur) => (cur === id ? null : cur));
  };

  // Reset selection state when the picker transitions from closed → open.
  // Parent passes a fresh `initialSelectedIds` array on every render, so
  // depending on its identity would clobber in-picker selections on every
  // upstream re-render.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSelectedIds(new Set(initialSelectedIds));
      setSelectedMeta(new Map());
      // Restore the whole picker position for this fan: folder, sort,
      // type. If the chatter has never opened the picker for this fan,
      // fall back to All / Newest / All-types. Crucially we DON'T force
      // listId to the MRU head — that would override the user's last
      // explicit "All folders" choice every time.
      const state = loadFanState(accountId, fanId);
      setType(state?.type ?? "all");
      setSort(state?.sort ?? "newest");
      setListId(state?.listId ?? null);
      setFolderMru(loadFanMru(accountId, fanId));
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Persist the full picker state on every change so reopening the
  // picker (same tab, popout, or restart) lands on the exact same view.
  useEffect(() => {
    if (!open) return;
    saveFanState(accountId, fanId, { listId, sort, type });
  }, [open, listId, sort, type, accountId, fanId]);

  // Whenever the user picks a real folder (not "All"), bump it to the
  // head of the per-fan MRU AND the account-wide counter. We do this on
  // listId change (not on confirm) so even a browse counts. The
  // account-wide counter is what the account-wide fallback below ranks
  // by when the current fan has no MRU yet.
  useEffect(() => {
    if (!open || listId == null) return;
    bumpAccountCount(accountId, listId);
    setFolderMru((prev) => {
      const next = [listId, ...prev.filter((id) => id !== listId)].slice(0, MRU_CAP);
      saveFanMru(accountId, fanId, next);
      return next;
    });
  }, [open, listId, accountId, fanId]);

  // Snapshot the account-wide counter once per open so the chip row's
  // tie-break stays stable while the user clicks around (otherwise the
  // act of clicking a chip would re-rank it mid-render).
  const accountCounts = useMemo(
    () => (open ? loadAccountCounts(accountId) : {}),
    [open, accountId],
  );

  // Esc closes. When the preview modal is open, swallow Esc to close just
  // the preview — the second press then closes the whole picker.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (previewMedia) {
        setPreviewMedia(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, previewMedia]);

  // Infinite scroll sentinel.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && vault.hasMore && !vault.isFetchingNextPage) {
          vault.loadMore();
        }
      },
      { root: null, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, vault]);

  function toggle(m: VaultMedia) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      return next;
    });
    setSelectedMeta((prev) => {
      const next = new Map(prev);
      next.set(m.id, m);
      return next;
    });
  }

  const confirm = useMemo(
    () => () => {
      const picked: VaultMedia[] = [];
      const seenInList = new Map(vault.items.map((m) => [m.id, m]));
      for (const id of selectedIds) {
        const m = seenInList.get(id) ?? selectedMeta.get(id);
        if (m) picked.push(m);
        else picked.push({ id, type: "photo" } as VaultMedia);
      }
      onConfirm(picked);
      onClose();
    },
    [vault.items, selectedIds, selectedMeta, onConfirm, onClose],
  );

  // Local sort applied AFTER the server paginated list lands. OF doesn't
  // expose sort=asc on the vault endpoint, so reversing here is the only
  // way to honor "Oldest first". Items arrive in createdAt-DESC order.
  //
  // Dedup by id along the way — OF's vault pagination occasionally returns
  // the same item across adjacent pages (race between a vault edit and
  // our offset-based reads), and React would warn about duplicate keys
  // on the tile <button>s. Keep the FIRST occurrence so the position the
  // user already sees stays stable when a re-fetch overlaps.
  const visibleItems = useMemo(() => {
    const ordered = sort === "oldest" ? [...vault.items].reverse() : vault.items;
    const seen = new Set<number>();
    const out: VaultMedia[] = [];
    for (const m of ordered) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [vault.items, sort]);

  // Folder quick-chips: three-tier fallback so the row is always useful.
  //   1. Per-fan MRU (last 3 folders the chatter used on this fan).
  //      Marked with a ★ — "you used this for this fan recently".
  //   2. Account-wide most-used folders (sum across all fans). Marked
  //      with a • — "you use this folder a lot in general".
  //   3. First few vault folders OF returned, as last-ditch defaults.
  //  Capped at MRU_CAP total. Same id never appears twice.
  type Chip = { id: number; name: string; source: "mru" | "global" | "default" };
  const folderChips = useMemo<Chip[]>(() => {
    const allFolders = listsQ.data?.list ?? [];
    if (allFolders.length === 0) return [];
    const byId = new Map(allFolders.map((l) => [l.id, l]));
    const out: Chip[] = [];
    const seen = new Set<number>();
    const push = (id: number, source: Chip["source"]) => {
      if (out.length >= MRU_CAP || seen.has(id)) return;
      const l = byId.get(id);
      if (!l) return; // folder deleted upstream — skip
      seen.add(id);
      out.push({ id: l.id, name: l.name, source });
    };
    // (1) Per-fan MRU.
    for (const id of folderMru) push(id, "mru");
    // (2) Account-wide most-used. Sort folderIds by count DESC.
    if (out.length < MRU_CAP) {
      const ranked = Object.entries(accountCounts)
        .map(([id, count]) => ({ id: Number(id), count: Number(count) || 0 }))
        .filter((e) => Number.isFinite(e.id) && e.count > 0)
        .sort((a, b) => b.count - a.count);
      for (const e of ranked) push(e.id, "global");
    }
    // (3) First-three default fallback when neither MRU nor counts cover it.
    if (out.length < MRU_CAP) {
      for (const l of allFolders) push(l.id, "default");
    }
    return out;
  }, [listsQ.data, folderMru, accountCounts]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-stretch">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close vault picker"
        className="absolute inset-0 bg-black/40 cursor-default"
      />
      <div className="relative ml-auto w-full max-w-3xl bg-panel border-l border-border flex flex-col shadow-2xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">Vault</h2>
            <p className="text-[11px] text-fg-dim">Pick media to attach.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-sm px-2 py-1"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>

        <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-bg/40 flex-wrap">
          {TYPE_CHIPS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setType(c.value)}
              className={cn(
                "px-3 py-1 rounded-full text-xs border transition-colors",
                type === c.value
                  ? "bg-accent/15 border-accent/40 text-accent"
                  : "bg-transparent border-border text-fg-dim hover:text-fg",
              )}
            >
              {c.label}
            </button>
          ))}

          {(listsQ.data?.list?.length ?? 0) > 0 && (
            <select
              value={listId ?? ""}
              onChange={(e) => setListId(e.target.value ? Number(e.target.value) : null)}
              className="ml-2 bg-bg border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:border-accent"
              title="Filter by folder"
            >
              <option value="">All folders</option>
              {listsQ.data!.list.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({(l.photosCount ?? 0) + (l.videosCount ?? 0) + (l.gifsCount ?? 0) + (l.audiosCount ?? 0)})
                </option>
              ))}
            </select>
          )}

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="ml-2 bg-bg border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:border-accent"
            title="Sort order — applied locally since OF doesn't expose sort on the vault endpoint."
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>

          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => vault.refresh()}
              className="text-[11px] text-fg-dim hover:text-fg underline underline-offset-2"
            >
              refresh
            </button>
          </div>
        </div>

        {folderChips.length > 0 && (
          <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border bg-bg/30 flex-wrap text-[11px]">
            <span className="text-fg-dim mr-1">Folders:</span>
            <button
              type="button"
              onClick={() => setListId(null)}
              className={cn(
                "px-2 py-0.5 rounded-full border transition-colors",
                listId == null
                  ? "bg-info/15 border-info/40 text-info"
                  : "bg-transparent border-border text-fg-dim hover:text-fg",
              )}
              title="All vault items, regardless of folder"
            >
              All
            </button>
            {folderChips.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setListId(f.id)}
                title={
                  f.source === "mru"
                    ? `Switch to '${f.name}' · last-used for this fan`
                    : f.source === "global"
                    ? `Switch to '${f.name}' · most-used across all your fans`
                    : `Switch to '${f.name}'`
                }
                className={cn(
                  "px-2 py-0.5 rounded-full border transition-colors max-w-[10rem] truncate",
                  listId === f.id
                    ? "bg-info/15 border-info/40 text-info"
                    : "bg-transparent border-border text-fg-dim hover:text-fg",
                )}
              >
                {f.source === "mru" && <span className="opacity-60 mr-0.5">★</span>}
                {f.source === "global" && <span className="opacity-50 mr-0.5">•</span>}
                {f.name}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          {vault.isLoading && vault.items.length === 0 && (
            <div className="text-sm text-fg-dim text-center py-12">Loading vault…</div>
          )}
          {/* Only surface an error when (a) we're not actively retrying
           *  and (b) we have nothing cached to show. Otherwise React Query
           *  will keep `vault.error` set from a stale attempt during the
           *  retry backoff window, which used to flash a "Failed: …" line
           *  for ~1s on first open before the retry succeeded. */}
          {vault.error && !vault.isFetching && vault.items.length === 0 && (
            <div className="text-sm text-err text-center py-6">
              Failed: {(vault.error as Error).message || "unknown"}
            </div>
          )}
          {!vault.isLoading && !vault.isFetching && vault.items.length === 0 && !vault.error && (
            <div className="text-sm text-fg-dim text-center py-12">
              No media in this filter.
            </div>
          )}

          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2">
            {visibleItems.map((m) => {
              const selected = selectedIds.has(m.id);
              const rawThumb =
                m.files?.thumb?.url ||
                m.files?.squarePreview?.url ||
                m.files?.preview?.url ||
                null;
              const thumb = proxyImage(rawThumb, accountId);
              // OF returns the playable mp4 under videoSources for most
              // items, but priced/PPV items (and a handful of older uploads)
              // sometimes only ship `files.full.url` or `files.preview.url`.
              // Fall through the list so we play whatever's present.
              const rawVideoSrc =
                m.type === "video"
                  ? (
                      m.videoSources?.["720"] ||
                      m.videoSources?.["240"] ||
                      m.files?.full?.url ||
                      m.files?.preview?.url ||
                      null
                    )
                  : null;
              const videoSrc = proxyImage(rawVideoSrc, accountId);
              const isHovering = hoveredVideoId === m.id;
              // Storyboard scrub uses the same signed video URL, but routes
              // through /img/scrub instead of /img. If we can't build the URL
              // (no rawVideoSrc, no accountId) fall back to the static thumb.
              const showVideoPreview =
                m.type === "video" && isHovering && !!rawVideoSrc && !!accountId;
              // Pass m.duration so the relay can skip its own ffprobe.
              // Pass hoverSessionId so a cancel POST from a previous hover
              // of the same video can't reach into THIS hover's build.
              const scrubSrc = showVideoPreview
                ? proxyScrubFrame(rawVideoSrc, accountId, scrubFrameIdx, m.duration, hoverSessionId)
                : "";
              const fanEntry = fanId != null ? historyMap[String(m.id)] : undefined;
              const onWall = wall.set.has(m.id);
              const status = resolveStatus(fanEntry, onWall);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggle(m)}
                  onMouseEnter={m.type === "video" ? () => startHoverIntent(m.id, m.duration ?? 0, rawVideoSrc) : undefined}
                  onMouseLeave={m.type === "video" ? () => cancelHoverIntent(m.id) : undefined}
                  className={cn(
                    "relative aspect-square rounded-md overflow-hidden bg-bg-elev-1",
                    "border-2 transition-colors",
                    // Status ring wins unless the tile is selected — once
                    // the user picks it the accent ring takes over so
                    // their selection state is unambiguous.
                    selected
                      ? "border-accent ring-2 ring-accent/40"
                      : status
                      ? STATUS_RING_CLASS[status]
                      : "border-border hover:border-fg-dim/40",
                  )}
                >
                  {showVideoPreview ? (
                    <>
                      {/* Skeleton shimmer overlay while the relay extracts
                       *  the storyboard. A light gradient bar slides across
                       *  the gray tile every 1.4s — readable as motion, not
                       *  frozen. Fades out the moment the first frame
                       *  paints. See .scrub-shimmer in globals.css. */}
                      {hoverLoading && (
                        <>
                          <div aria-hidden className="scrub-shimmer pointer-events-none" />
                          {/* Countdown — estimated time until first frame
                           *  is ready (from video duration). Shows the
                           *  expected wait; "…" if the actual extract
                           *  takes longer than estimated. */}
                          <div
                            aria-hidden
                            className="absolute inset-0 grid place-items-center pointer-events-none"
                          >
                            <span className="text-white/85 text-lg font-semibold drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]">
                              {scrubCountdownSec > 0
                                ? `${Math.ceil(scrubCountdownSec)}s`
                                : "…"}
                            </span>
                          </div>
                        </>
                      )}
                      {/* Render all 12 frame <img>s once and toggle the
                       *  visible one via opacity. Each <img> keeps its own
                       *  src for the entire hover — no src swaps means no
                       *  in-flight loads get cancelled by the browser when
                       *  scrubFrameIdx ticks. Through a slow proxy, the old
                       *  src-swap approach kept cancelling each new frame's
                       *  fetch ~600ms after kickoff, so only frame 0 ever
                       *  completed loading and the visible image stayed at
                       *  frame 0 forever. This layered approach loads every
                       *  frame to completion in parallel, then opacity
                       *  switches them instantly.
                       *
                       *  The frame-0 element wears onLoad/onError so we
                       *  still know when "first paint" lands (drives the
                       *  hoverLoading shimmer and scrubReady gate). */}
                      {Array.from({ length: SCRUB_FRAMES }).map((_, idx) => (
                        <img
                          // Per-frame key bound to tile id so a tile
                          // transition forces fresh elements (no stale
                          // paint from the previous tile).
                          key={`${m.id}-frame-${idx}`}
                          src={proxyScrubFrame(rawVideoSrc, accountId, idx, m.duration, hoverSessionId)}
                          alt=""
                          aria-hidden={idx !== scrubFrameIdx}
                          decoding="async"
                          onLoad={idx === 0 ? () => {
                            if (hoveredVideoIdRef.current !== m.id) return;
                            setHoverLoading(false);
                            setScrubReady(true);
                          } : undefined}
                          onError={idx === 0 ? () => {
                            if (hoveredVideoIdRef.current === m.id) setHoverLoading(false);
                          } : undefined}
                          style={{ opacity: idx === scrubFrameIdx && !hoverLoading ? 1 : 0 }}
                          className={cn(
                            "absolute inset-0 w-full h-full object-cover transition-opacity duration-200",
                            blurCls,
                          )}
                        />
                      ))}
                    </>
                  ) : thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className={cn("w-full h-full object-cover", blurCls)}
                    />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-[10px] text-fg-dim">
                      {m.type}
                    </div>
                  )}
                  {m.type === "video" && (
                    // Repurposed as the preview-open affordance. Nested
                    // <button> isn't legal HTML so we use a span with
                    // role="button" + stopPropagation, which keeps tile
                    // selection on the tile click and play-modal on the
                    // pill click. Hover styling makes the interactivity
                    // discoverable.
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewMedia(m);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setPreviewMedia(m);
                        }
                      }}
                      className="absolute bottom-1 right-1 bg-black/60 hover:bg-black/85 text-white text-[10px] px-1.5 py-0.5 rounded cursor-pointer select-none"
                      title="Preview video"
                    >
                      ▶ {fmtDur(m.duration)}
                    </span>
                  )}
                  {m.type === "gif" && (
                    <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
                      GIF
                    </span>
                  )}
                  {/* Price/state corner: replaces the plain dot with a
                   *  small pill that carries the price for locked/unlocked
                   *  ($X), the word "FREE" for sent-free, and the wall
                   *  marker. Still color-matches the ring so the state is
                   *  legible at the smallest grid sizes. */}
                  {status && (() => {
                    const priceLabel = tilePriceLabel(fanEntry);
                    const text =
                      status === "unlocked"
                        ? (priceLabel ?? "PAID")
                        : status === "locked"
                        ? (priceLabel ?? "PPV")
                        : status === "free"
                        ? "FREE"
                        : "WALL";
                    return (
                      <span
                        className={cn(
                          "absolute top-1 left-1 px-1.5 h-4 rounded-full text-[9px] font-bold leading-4 shadow",
                          STATUS_DOT_CLASS[status],
                          // Yellow needs dark text for legibility; the
                          // rest are bright-on-dark.
                          status === "free" ? "text-bg" : "text-white",
                        )}
                        aria-hidden
                      >
                        {text}
                      </span>
                    );
                  })()}
                  {selected && (
                    <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-accent text-white grid place-items-center text-[11px] font-bold shadow">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div ref={sentinelRef} className="h-8 flex items-center justify-center text-[11px] text-fg-dim">
            {vault.isFetchingNextPage ? "Loading more…" : vault.hasMore ? "" : (vault.items.length > 0 ? "End of vault." : "")}
          </div>
        </div>

        <footer className="border-t border-border px-4 py-3 flex items-center gap-3 bg-panel">
          <span className="text-xs text-fg-dim">
            {selectedIds.size === 0
              ? "No items selected"
              : `${selectedIds.size} item${selectedIds.size === 1 ? "" : "s"} selected`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={selectedIds.size === 0} onClick={confirm}>
              Attach
            </Button>
          </div>
        </footer>
      </div>
      {previewMedia && (
        <VaultVideoPreview
          media={previewMedia}
          accountId={accountId}
          onClose={() => setPreviewMedia(null)}
        />
      )}
    </div>
  );
}

/** Full-screen modal video player. Sits above the picker's slide-over
 *  pane so backdrop click closes only the preview. The native <video>
 *  controls give scrub/volume/fullscreen; we don't reimplement them. */
function VaultVideoPreview({
  media, accountId, onClose,
}: { media: VaultMedia; accountId: string | null; onClose: () => void }) {
  const rawSrc =
    media.videoSources?.["720"] ||
    media.videoSources?.["240"] ||
    media.files?.full?.url ||
    media.files?.preview?.url ||
    null;
  // Distinguish "no URL at all" (rawSrc null) from "URL was returned but
  // upstream rejected it" (loadError set by the <video> onError). Both
  // surface the same friendly hint about refresh + transcoding.
  const [loadError, setLoadError] = useState(false);
  useEffect(() => { setLoadError(false); }, [media.id]);
  // Diagnostic for the "no source" case — logs the full vault item so we
  // can see which fields OF actually populated for priced/PPV videos and
  // extend the fallback list above. No-op when a source resolved fine.
  useEffect(() => {
    if (!rawSrc) {
      console.warn("[vault-preview] no playable source", {
        id: media.id,
        type: media.type,
        isReady: media.isReady,
        canView: media.canView,
        hasVideoSources: !!media.videoSources,
        fileKeys: media.files ? Object.keys(media.files) : [],
        media,
      });
    }
  }, [rawSrc, media]);
  const src = proxyImage(rawSrc, accountId);
  const poster = proxyImage(
    media.files?.preview?.url || media.files?.thumb?.url || null,
    accountId,
  );
  const showError = !src || loadError;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute inset-0 bg-black/75"
      />
      <div className="relative max-w-[90%] max-h-[90%] flex flex-col items-center gap-3">
        {!showError ? (
          <video
            src={src}
            poster={poster || undefined}
            autoPlay
            controls
            loop
            playsInline
            onError={() => {
              setLoadError(true);
              console.warn("[vault-preview] video element error", {
                id: media.id, rawSrc, src,
              });
            }}
            className="max-w-full max-h-[80vh] rounded-md shadow-2xl bg-black"
          />
        ) : (
          <div className="px-6 py-12 bg-panel rounded-md text-sm text-fg-dim border border-border max-w-md text-center space-y-2">
            <div>
              {rawSrc ? "Couldn't load this video." : "No playable source for this video."}
            </div>
            <div className="text-[11px] opacity-70">
              {rawSrc
                ? "OF returned a URL but the upstream rejected it — usually a signed URL that expired in cache. Close this and click \"refresh\" at the top of the vault to pull fresh URLs."
                : `OF didn't return a streamable URL for vault id ${media.id}. Freshly-uploaded videos sit without a source until OF finishes transcoding (a few minutes). Try refresh once it's done.`}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-white/80 hover:text-white px-3 py-1 rounded-md bg-black/40 border border-white/15"
        >
          Close (Esc)
        </button>
      </div>
    </div>
  );
}

function fmtDur(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Mutually-exclusive tile state. Order matches the desktop-app:
 *    unlocked (fan paid) > free (we sent free) > locked (sent paid, not
 *    bought) > on-wall (public feed only). Sent-anything beats wall-only
 *    because the per-fan signal is always more actionable than the
 *    public-post signal. Unlocked stays the dominant signal — chatter
 *    must know not to resell paid content. */
type TileStatus = "unlocked" | "free" | "locked" | "on-wall";

const STATUS_RING_CLASS: Record<TileStatus, string> = {
  unlocked: "border-ok",      // green — fan paid
  free:     "border-warn",    // yellow — we sent free
  locked:   "border-err",     // red — sent paid, not bought yet
  "on-wall":"border-info",    // blue — on the public feed
};

const STATUS_DOT_CLASS: Record<TileStatus, string> = {
  unlocked: "bg-ok",
  free:     "bg-warn",
  locked:   "bg-err",
  "on-wall":"bg-info",
};

function resolveStatus(entry: FanVaultEntry | undefined, onWall: boolean): TileStatus | null {
  if (entry?.was_purchased) return "unlocked";
  if (entry) {
    return entry.last_price_cents > 0 ? "locked" : "free";
  }
  if (onWall) return "on-wall";
  return null;
}

/** Tooltip text for each tile — combines media metadata with all known
 *  state so hover gives the full picture (including secondary states the
 *  one-color border can't carry). */
function describeTile(m: VaultMedia, entry: FanVaultEntry | undefined, onWall: boolean): string {
  const base = `${m.type} · ${m.id}`;
  const wallNote = onWall ? " · also on wall" : "";
  if (!entry) return `${base}${onWall ? " · posted on wall" : " · not yet sent to this fan"}`;
  if (entry.was_purchased) {
    const paid = entry.total_paid_cents > 0
      ? ` ($${(entry.total_paid_cents / 100).toFixed(2)})`
      : "";
    return `${base} · UNLOCKED (fan paid)${paid}${wallNote}`;
  }
  const kind = entry.last_price_cents > 0
    ? `locked · sent at $${(entry.last_price_cents / 100).toFixed(2)}`
    : "sent free";
  return `${base} · ${kind} (${entry.send_count}×)${wallNote}`;
}

/** Price string for the corner badge — only set when the tile has a
 *  send-price (locked or unlocked). Free + wall-only return null. */
function tilePriceLabel(entry: FanVaultEntry | undefined): string | null {
  if (!entry) return null;
  const cents = entry.was_purchased && entry.total_paid_cents > 0
    ? entry.total_paid_cents
    : entry.last_price_cents;
  if (!cents || cents <= 0) return null;
  return `$${(cents / 100).toFixed(2)}`;
}
