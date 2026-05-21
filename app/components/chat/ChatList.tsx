"use client";

/**
 * ChatList — the left rail of /inbox.
 *
 * Rows display fan avatar, name, last message preview, unread dot, and
 * (in Unified mode) a colored dot identifying the model account. The
 * dot color comes from AccountMeta.color, which Setup lets the user set.
 *
 * Click a row → notify parent with (accountId, fanId). Parent owns the
 * "which chat is selected" state because that state also drives the
 * right-pane MessageList.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import { useChatList } from "@/hooks/useChatList";
import { useActiveAccounts } from "@/hooks/useAccounts";
import { useFanSpend } from "@/hooks/useFanSpend";
import { useFanDrawerDefault } from "@/hooks/useFanDrawerDefault";
import { useBlurMode } from "@/hooks/useBlurMode";
import { useDeferredMount } from "@/hooks/useDeferredMount";
import { useFanActivity } from "@/hooks/useLastPurchases";
import {
  useAllChatFolders,
  useChatFolders,
  usePinChatFolder,
} from "@/hooks/useChatFolders";
import { useScope } from "@/contexts/ScopeContext";
import { cn, decodeHtmlEntities, fmtRelTime, interpretSubStatus } from "@/lib/utils";
import { proxyImage, relay, type OFChatItem, type OFMessage, type OFMessagesResp, type OFUserMini } from "@/lib/relay";

/** Built-in OF chat filters — most are server-side filters supported
 *  by /chats. `owe-reply` is CLIENT-SIDE only: there's no OF filter for
 *  "fan sent last and we haven't replied," so we fetch ALL and filter
 *  locally. Auto-paginates until OWE_REPLY_TARGET rows are filled or
 *  OWE_REPLY_SCAN_CAP rows have been scanned (whichever comes first).
 */
type BuiltinFilter = "all" | "unread" | "pinned" | "priority" | "owe-reply";

const OWE_REPLY_TARGET = 8;       // stop early once we have this many on screen
const OWE_REPLY_SCAN_CAP = 100;   // and never scan more than this many chats deep

/** Active selection: either a built-in filter or a custom folder by id. */
type ActiveChip =
  | { kind: "builtin"; key: BuiltinFilter }
  | { kind: "folder"; listId: string };

// Hard cap on background pagination. Search bypasses (otherwise typo'd
// queries dead-end after 200 rows). "Load more" click extends by another step.
const SCROLL_CAP_STEP = 200;

if (typeof window !== "undefined" && !(window as unknown as { __chatlistBuildLogged?: boolean }).__chatlistBuildLogged) {
  console.info("[ChatList] build chats-scroll-cap-v6 (rt-row-bubble) loaded");
  (window as unknown as { __chatlistBuildLogged?: boolean }).__chatlistBuildLogged = true;
}

export interface ChatListSelection {
  accountId: string;
  fanId: number;
  chat: OFChatItem;
}

export function ChatList({
  selected, onSelect,
}: {
  selected: ChatListSelection | null;
  onSelect: (sel: ChatListSelection) => void;
}) {
  const { scope } = useScope();
  const accounts = useActiveAccounts();
  const qc = useQueryClient();
  const [active, setActive] = useState<ActiveChip>({ kind: "builtin", key: "all" });
  const [query, setQuery] = useState("");
  const [markingAll, setMarkingAll] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const [keepDrawerOpen, setKeepDrawerOpen] = useFanDrawerDefault();
  const [blurMode, setBlurMode] = useBlurMode();
  const [capRows, setCapRows] = useState(SCROLL_CAP_STEP);

  // Hover-prefetch for chat messages. When the pointer rests on a row
  // for ~120ms we kick a prefetchQuery against the same key + queryFn
  // shape useChatMessages uses, so by the time the user actually clicks
  // the first page is already in cache and the chat opens instantly.
  // The 120ms dwell prevents brushing past 30 rows from firing 30
  // requests; TanStack also dedupes if the prefetch is still in flight
  // by the time the click lands. loadOlder reads its cursor from the
  // cached data ([useChatMessages.ts:88-89]) so prefetched warm-cache
  // chats still paginate correctly on scroll-up.
  const prefetchTimerRef = useRef<number | null>(null);
  const PREFETCH_DWELL_MS = 120;
  const PREFETCH_PAGE_SIZE = 30;
  const PREFETCH_STALE_MS = 15_000;
  const prefetchMessages = useCallback((aid: string, fid: number) => {
    if (!aid || !fid) return;
    qc.prefetchQuery({
      queryKey: ["messages", aid, fid],
      queryFn: async () => {
        const resp = await relay.get<OFMessagesResp>(
          `/api/of/v2/chats/${fid}/messages?limit=${PREFETCH_PAGE_SIZE}&order=desc`,
          { accountId: aid },
        );
        // Same shape useChatMessages.queryFn returns: reversed so the UI
        // can render oldest-first top-to-bottom without re-reversing.
        return ((resp.list || []) as OFMessage[]).slice().reverse();
      },
      staleTime: PREFETCH_STALE_MS,
    }).catch(() => { /* fire-and-forget */ });
  }, [qc]);
  const scheduleRowPrefetch = useCallback((aid: string, fid: number) => {
    if (prefetchTimerRef.current != null) window.clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = window.setTimeout(() => {
      prefetchTimerRef.current = null;
      prefetchMessages(aid, fid);
    }, PREFETCH_DWELL_MS);
  }, [prefetchMessages]);
  const cancelRowPrefetch = useCallback(() => {
    if (prefetchTimerRef.current != null) {
      window.clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);
  // Unmount cleanup: a pending prefetch timer would otherwise fire after
  // the component is gone (cheap but pointless network).
  useEffect(() => () => {
    if (prefetchTimerRef.current != null) {
      window.clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  // Defer non-critical decoration queries (spend, last purchase, folders)
  // so they don't compete with /chats + enrichWithUsers for OF bandwidth
  // and the relay thread pool on cold load. Two tiers so chips don't all
  // pop in at once:
  //   • foldersReady  (~2.5s) — folder list + activity (cheap, local DB)
  //   • spendReady    (~5.5s) — /users/list view=x spend chips
  //                              (heaviest OF call, lands last)
  const foldersReady = useDeferredMount(2500);
  const spendReady = useDeferredMount(5500);

  // Pinned chat-folders (per single account). Unified mode hides them
  // because pinning is per-account on OF's side.
  const singleAcctId = scope.kind === "model" ? scope.accountId : null;
  const pinnedFolders = useChatFolders(foldersReady ? singleAcctId : null).data ?? [];

  // If the active folder chip got unpinned (or we switched into unified
  // scope), fall back to "All" so we don't hold a phantom selection.
  useEffect(() => {
    if (active.kind !== "folder") return;
    const stillPinned = pinnedFolders.some((f) => String(f.id) === active.listId);
    if (!stillPinned) setActive({ kind: "builtin", key: "all" });
  }, [active, pinnedFolders]);

  // Settings dropdown — close on outside click + Esc.
  useEffect(() => {
    if (!settingsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSettingsOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  // Server-side filter to send to /chats. The standard built-ins map 1:1
  // (with "all" → null). `owe-reply` is client-side only — we still pull
  // the full list. Folder selections map to filter=null + list_id.
  const serverFilter =
    active.kind === "builtin"
      ? (active.key === "all" || active.key === "owe-reply" ? null : active.key)
      : null;
  const serverListId =
    active.kind === "folder" ? active.listId : null;

  const q = useChatList({
    filter: serverFilter,
    listId: serverListId,
    query: query || null,
  });

  const accountById = useMemo(() => {
    const m = new Map<string, { color?: string | null; nickname?: string | null }>();
    for (const a of accounts) m.set(a.id, { color: a.color, nickname: a.nickname });
    return m;
  }, [accounts]);

  const allRows = q.data ?? [];

  // Owe-reply: client-side filter on `lastFromFan`. Same logic as the
  // yellow-dot pill in the row — fan sent the latest message, ball in
  // our court — but extended to include unread chats (which also imply
  // they sent last).
  const oweReplyActive = active.kind === "builtin" && active.key === "owe-reply";
  const rows = useMemo(() => {
    if (!oweReplyActive) return allRows;
    return allRows.filter((c) => {
      const accountId = c.__accountId ?? (scope.kind === "model" ? scope.accountId : "");
      const myId = Number(accountId);
      const lm = c.lastMessage;
      return !!lm && lm.fromUser?.id != null && lm.fromUser.id !== myId;
    });
  }, [allRows, oweReplyActive, scope]);

  // Deferred: pass empty inputs until the staggered ready flags flip,
  // which short-circuits the inner useQueries fan-out and keeps the cold
  // load free of these chip-population calls. Spend uses the later flag
  // (5.5s) because it issues the heaviest OF call (/users/list view=x);
  // activity uses the earlier flag (2.5s) — payouts is cheap and cached
  // forever after first session.
  const spendMap = useFanSpend(spendReady ? rows : []);
  // One transactions feed per active account in scope. Memoized to avoid
  // re-triggering useQueries when row order changes but account set doesn't.
  const purchaseAccountIds = useMemo(() => {
    if (!foldersReady) return [];
    const set = new Set<string>();
    for (const r of rows) if (r.__accountId) set.add(r.__accountId);
    return Array.from(set).sort();
  }, [rows, foldersReady]);
  const activity = useFanActivity(purchaseAccountIds);
  const lastPurchaseMap = activity.lastPurchase;
  const recentSpendMap = activity.recentSpend;

  // Per-fan profile cache observer. `enrichWithUsers` writes each fan's
  // {name, username, avatar, customNickname} to ["of-user", aid, fid];
  // here we subscribe to those entries without triggering fetches. The
  // chats cache only carries the slim ids/lastMessage shape — names come
  // from this side cache, so refetches / SSE patches on the chats cache
  // can't make the row revert to "fan {id}". Stable keys per fan.
  const profileQueries = useQueries({
    queries: rows.map((r) => ({
      queryKey: ["of-user", r.__accountId, r.withUser.id] as const,
      queryFn: (): Promise<OFUserMini> =>
        Promise.reject(new Error("observe-only")),
      enabled: false,
      staleTime: Infinity,
    })),
  });
  const profileVersion = profileQueries.map((q) => q.dataUpdatedAt).join("|");
  // Row-identity signature: profileQueries[i] is index-aligned with rows[i],
  // so if rows reorder or swap a slot for a fan with the same dataUpdatedAt
  // the memo would otherwise miss the change and serve the old map.
  const rowSig = rows.map((r) => `${r.__accountId ?? ""}:${r.withUser.id}`).join("|");
  const profileMap = useMemo(() => {
    const m = new Map<string, OFUserMini>();
    profileQueries.forEach((q, i) => {
      const r = rows[i];
      if (!r || !q.data) return;
      m.set(`${r.__accountId ?? ""}:${r.withUser.id}`, q.data as OFUserMini);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileVersion, rowSig]);

  async function markAllRead() {
    if (markingAll) return;
    const targets = allRows.filter((c) => c.hasUnread);
    if (targets.length === 0) return;
    if (!confirm(`Mark ${targets.length} chat${targets.length === 1 ? "" : "s"} as read?`)) return;
    setMarkingAll(true);
    try {
      // Sequential POSTs — OF rate-limits aggressively when hammered in
      // parallel. Failures don't roll back; the next inbox refetch picks
      // up whatever stuck.
      for (const c of targets) {
        const accountId = c.__accountId;
        if (!accountId) continue;
        try {
          await relay.post(
            `/api/of/v2/chats/${c.withUser.id}/mark-as-read`,
            undefined,
            { accountId },
          );
        } catch (err) {
          console.warn("[mark-all-read] failed for", c.withUser.id, err);
        }
      }
      qc.invalidateQueries({ queryKey: ["chats"] });
    } finally {
      setMarkingAll(false);
    }
  }

  // Reset the scroll cap whenever the query context changes (new filter,
  // folder, scope, or search). A fresh list should get a fresh 200-row budget.
  useEffect(() => {
    setCapRows(SCROLL_CAP_STEP);
  }, [active, query, scope.kind, scope.kind === "model" ? scope.accountId : null]);

  // True when we've paginated up to the cap with no active search. The
  // budget is measured against the RAW scanned set (allRows), not the
  // filter view — owe-reply only displays a handful of matches but each
  // page still costs a roundtrip, so the cap has to bite either way.
  const capped = !query && allRows.length >= capRows;

  // Owe-reply: keep loading more pages until we either fill the target
  // (5–8 filtered rows on screen) or scan-cap hits (100 raw rows). OF
  // has no native "fan sent last" filter, so we have to walk the chat
  // list ourselves; the cap keeps that walk bounded.
  const oweReplyScanned = oweReplyActive ? allRows.length : 0;
  const oweReplyMatches = oweReplyActive ? rows.length : 0;
  const oweReplyExhausted =
    oweReplyActive &&
    (oweReplyMatches >= OWE_REPLY_TARGET ||
      oweReplyScanned >= OWE_REPLY_SCAN_CAP ||
      !q.hasMore);
  useEffect(() => {
    if (!oweReplyActive) return;
    if (oweReplyExhausted) return;
    if (q.isFetchingMore) return;
    q.loadMore();
  }, [oweReplyActive, oweReplyExhausted, oweReplyMatches, oweReplyScanned, q]);

  // Auto-load more pages only after the user has actually scrolled the
  // panel. Without this gate, an empty/short panel keeps the sentinel in
  // view from the start, so the IntersectionObserver chains loadMore()
  // calls before the user has done anything — burning quota and pulling
  // hundreds of /users/list batches for fans they may never see.
  // Page 1 (~25 rows) loads automatically via useInfiniteQuery; further
  // pages only auto-load once the user starts scrolling.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  useEffect(() => {
    const el = sentinelRef.current;
    const root = el?.parentElement;
    if (!root) return;
    const onScroll = () => {
      if (root.scrollTop > 0) setUserScrolled(true);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);
  // Reset the "has scrolled" flag whenever query context changes so a
  // fresh list doesn't inherit the prior scroll permission.
  useEffect(() => {
    setUserScrolled(false);
  }, [active, query, scope.kind, scope.kind === "model" ? scope.accountId : null]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (!q.hasMore || q.isFetchingMore) return;
        if (capped) return;
        // Owe-reply has its own bounded walk and intentionally pre-scans
        // without waiting for user scroll. Search also bypasses the gate
        // — typing a name implies "keep scanning for matches." Default
        // mode requires an explicit scroll signal before chaining pages.
        if (oweReplyExhausted) return;
        if (!oweReplyActive && !query && !userScrolled) return;
        q.loadMore();
      },
      // rootMargin: 0 means "only fire when the sentinel is actually in
      // the viewport," not 200px before. Combined with the userScrolled
      // gate above, this confines auto-load to real bottom-touches.
      { root: el.parentElement, rootMargin: "0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [q, capped, oweReplyExhausted, oweReplyActive, userScrolled, query]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-panel border-r border-border">
      <div className="p-3 border-b border-border space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-sm truncate">
            {scope.kind === "all" ? "Unified Inbox" : (accountById.get(scope.accountId)?.nickname || scope.accountId)}
          </h2>
          <div className="flex items-center gap-2 shrink-0" ref={settingsRef}>
            <span className="text-[11px] text-fg-dim">
              {q.isFetching ? "…" : rows.length}
            </span>
            <div className="relative">
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                className="w-6 h-6 grid place-items-center rounded-md text-fg-dim hover:text-fg hover:bg-bg-elev-1 text-sm"
                title="Inbox settings"
                aria-label="Inbox settings"
              >
                ⚙
              </button>
              {settingsOpen && (
                <div className="absolute right-0 mt-1 w-[230px] bg-panel border border-border rounded-lg shadow-xl z-30 py-1">
                  <button
                    type="button"
                    onClick={() => { setSettingsOpen(false); q.refetch(); }}
                    disabled={q.isFetching}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-fg hover:bg-bg-elev-1 disabled:opacity-50"
                  >
                    <span className="w-4 text-center">↻</span>
                    <span>Refresh inbox</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSettingsOpen(false); markAllRead(); }}
                    disabled={markingAll || !allRows.some((c) => c.hasUnread)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-fg hover:bg-bg-elev-1 disabled:opacity-50"
                  >
                    <span className="w-4 text-center">✓</span>
                    <span>{markingAll ? "Marking…" : "Mark all as read"}</span>
                  </button>
                  <label className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-bg-elev-1 cursor-pointer select-none border-t border-border/60">
                    <input
                      type="checkbox"
                      checked={keepDrawerOpen}
                      onChange={(e) => setKeepDrawerOpen(e.target.checked)}
                      className="shrink-0"
                    />
                    <span>Keep fan info panel open</span>
                  </label>
                  {/* Image-blur mode. Two checkboxes for the two non-default
                   *  modes; checking one unchecks the other so the user
                   *  always sees the live state. Applied to chat media tiles
                   *  + vault thumbnails via the useBlurMode hook. */}
                  <label className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-bg-elev-1 cursor-pointer select-none border-t border-border/60">
                    <input
                      type="checkbox"
                      checked={blurMode === "hover"}
                      onChange={(e) => setBlurMode(e.target.checked ? "hover" : "off")}
                      className="shrink-0"
                    />
                    <span>Blur images till hover</span>
                  </label>
                  <label className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-bg-elev-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={blurMode === "constant"}
                      onChange={(e) => setBlurMode(e.target.checked ? "constant" : "off")}
                      className="shrink-0"
                    />
                    <span>Blur images constant</span>
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>
        <input
          type="text"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-xs placeholder:text-muted focus:outline-none focus:border-accent"
        />
        {/* Row 1: built-in OF filters. Always visible, never overflows. */}
        <div className="flex items-center gap-1 text-[11px] flex-wrap">
          <FilterChip
            active={active.kind === "builtin" && active.key === "all"}
            onClick={() => setActive({ kind: "builtin", key: "all" })}
          >All</FilterChip>
          <FilterChip
            active={active.kind === "builtin" && active.key === "unread"}
            onClick={() => setActive({ kind: "builtin", key: "unread" })}
          >Unread</FilterChip>
          <FilterChip
            active={active.kind === "builtin" && active.key === "pinned"}
            onClick={() => setActive({ kind: "builtin", key: "pinned" })}
          >📌 Pinned</FilterChip>
          <FilterChip
            active={active.kind === "builtin" && active.key === "priority"}
            onClick={() => setActive({ kind: "builtin", key: "priority" })}
          >⚡ Priority</FilterChip>
          <FilterChip
            active={active.kind === "builtin" && active.key === "owe-reply"}
            onClick={() => setActive({ kind: "builtin", key: "owe-reply" })}
            title="Chats where the fan sent the last message and we haven't replied"
          >↩ Owe reply</FilterChip>
        </div>
        {/* Row 2: pinned custom folders + the picker. Horizontally scrolls
         *  when there are too many to fit — they're optional/secondary. */}
        {(pinnedFolders.length > 0 || scope.kind === "model") && (
          <div className="flex items-center gap-1 text-[11px] overflow-x-auto no-scrollbar">
            {pinnedFolders.map((f) => {
              const id = String(f.id);
              const isActive = active.kind === "folder" && active.listId === id;
              return (
                <FilterChip
                  key={id}
                  active={isActive}
                  onClick={() => setActive({ kind: "folder", listId: id })}
                  title={f.name || `List #${id}`}
                >
                  📂 {f.name || `List #${id}`}
                </FilterChip>
              );
            })}
            {scope.kind === "model" && (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="px-2 py-0.5 rounded-full border border-border text-fg-dim hover:text-fg hover:border-border-light transition-colors shrink-0"
                title="Pick folders to pin as chips"
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>
      {pickerOpen && singleAcctId && (
        <FolderPicker
          accountId={singleAcctId}
          onClose={() => setPickerOpen(false)}
        />
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {q.isError && (
          <div className="p-4 text-xs text-err">
            failed to load: {(q.error as Error)?.message || "unknown"}
          </div>
        )}
        {!q.isError && rows.length === 0 && q.isFetched && (
          <div className="p-4 text-xs text-fg-dim">No chats.</div>
        )}
        {/* Skeleton rows during the cold first fetch. Without these the
         *  panel looks empty for the 1–3s it takes /chats + the per-acct
         *  enrich to settle, which feels broken. 10 rows fills a typical
         *  viewport. Once rows arrive, they replace the skeletons. */}
        {!q.isError && rows.length === 0 && !q.isFetched && (
          Array.from({ length: 10 }).map((_, i) => (
            <div
              key={`skel-${i}`}
              className="px-3 py-2.5 border-b border-border/40 flex items-center gap-3 animate-pulse"
            >
              <div className="w-9 h-9 rounded-full bg-bg-elev-1 shrink-0" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-2.5 w-2/5 bg-bg-elev-1 rounded" />
                <div className="h-2 w-4/5 bg-bg-elev-1/60 rounded" />
              </div>
            </div>
          ))
        )}
        {rows.map((c) => {
          const accountId = c.__accountId ?? (scope.kind === "model" ? scope.accountId : "");
          const acc = accountById.get(accountId);
          const isSelected =
            selected?.accountId === accountId && selected?.fanId === c.withUser.id;
          // Priority: team-set nickname (from our SQLite, stitched onto
          // /users/list by the relay) → OF display name → OF username
          // → numeric id. Reads from the per-fan profile cache first (the
          // stable side channel that enrichWithUsers populates), falling
          // back to whatever's on the chat row — so a chats refetch that
          // drops back to slim withUser doesn't make the rail revert.
          const profile = profileMap.get(`${accountId}:${c.withUser.id}`);
          const fanName = decodeHtmlEntities(
            profile?.customNickname ||
            c.withUser.customNickname ||
            profile?.name ||
            c.withUser.name ||
            profile?.username ||
            c.withUser.username ||
            `fan ${c.withUser.id}`,
          );
          const avatarUrl = proxyImage(c.withUser.avatar || profile?.avatar || null, accountId);
          const spend = spendMap.get(`${accountId}:${c.withUser.id}`);
          const lastPurchase = lastPurchaseMap.get(`${accountId}:${c.withUser.id}`) ?? null;
          const recentSpend = recentSpendMap.get(`${accountId}:${c.withUser.id}`) ?? 0;
          // Prefer the batch /users/list?view=x lifetime total; if that
          // briefly reports 0 (OF cache lag), fall back to the windowed
          // sum from the transactions feed so the chip stops showing a
          // phantom $0 next to a populated last-buy timestamp.
          const displaySpendCents = Math.max(spend?.spend_cents ?? 0, recentSpend);
          return (
            <button
              key={`${accountId}:${c.withUser.id}`}
              type="button"
              data-chat-row
              onClick={() => {
                // No optimistic mark-as-read patch here — ChatSurface owns
                // the timing (1.2s grace window). Firing it on click was
                // overriding that delay so the blue dot vanished instantly.
                onSelect({ accountId, fanId: c.withUser.id, chat: c });
              }}
              onMouseEnter={() => scheduleRowPrefetch(accountId, c.withUser.id)}
              onMouseLeave={cancelRowPrefetch}
              onFocus={() => scheduleRowPrefetch(accountId, c.withUser.id)}
              onBlur={cancelRowPrefetch}
              className={cn(
                "w-full text-left px-3 py-2.5 border-b border-border/40",
                "flex items-start gap-2.5 hover:bg-bg-elev-1 transition-colors",
                isSelected && "bg-bg-elev-1",
              )}
            >
              {scope.kind === "all" && (
                <span
                  className="mt-1 w-2 h-2 rounded-full shrink-0 border border-black/20"
                  style={{ background: acc?.color || "#666" }}
                  title={acc?.nickname || accountId}
                />
              )}
              <div className="w-9 h-9 rounded-full bg-bg-elev-1 grid place-items-center text-xs overflow-hidden shrink-0">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    // Browser hint: avatars are decorative, never above
                    // the fold of attention. Yields network/decode budget
                    // to message media + the active chat surface.
                    fetchPriority="low"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-fg-dim">{fanName.slice(0, 1).toUpperCase()}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{fanName}</span>
                  <span className="text-[10px] text-fg-dim shrink-0">
                    {fmtTime(c.lastMessage?.createdAt)}
                  </span>
                </div>
                <div className="text-xs text-fg-dim truncate">
                  {previewText(c)}
                </div>
                {(displaySpendCents > 0 || lastPurchase || spend?.subscription_status) && (() => {
                  const status = spend
                    ? interpretSubStatus(spend.subscription_status, spend.expired_at)
                    : null;
                  const toneClass =
                    status?.tone === "err" ? "text-err"
                    : status?.tone === "warn" ? "text-warn"
                    : "text-fg-dim";
                  return (
                    <div className="text-[10px] text-fg-dim mt-0.5 flex items-center gap-1.5 flex-wrap">
                      {displaySpendCents > 0 && (
                        <span className="text-ok font-medium">
                          ${(displaySpendCents / 100).toFixed(0)}
                        </span>
                      )}
                      {lastPurchase && (
                        <span title={lastPurchase}>
                          · last buy {fmtRelTime(lastPurchase)}
                        </span>
                      )}
                      {status && status.short !== "—" && (
                        <span className={toneClass} title={spend?.expired_at ?? undefined}>
                          · {status.short === "Active" && spend?.expired_at
                              ? `renews ${fmtRelTime(spend.expired_at)}`
                              : status.short === "Won't renew" && spend?.expired_at
                                ? `ends ${fmtRelTime(spend.expired_at)}`
                                : status.short}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
              {/* Status pill priority:
                 *   • Blue badge (count) → genuinely unread, OF said so
                 *   • Yellow dot         → read but fan sent the last msg
                 *                          ("I owe a reply")
                 *   • Nothing            → we sent last; ball's in their court
                 *
                 *  `accountId` is the model's OF user id (string);
                 *  `lm.fromUser.id` is a number, so the numeric compare
                 *  is the right one. */}
              {(() => {
                const lm = c.lastMessage;
                const myId = Number(accountId);
                const lastFromFan =
                  !!lm && lm.fromUser?.id != null && lm.fromUser.id !== myId;
                const unreadCount = c.unreadMessagesCount ?? 0;
                if (c.hasUnread || unreadCount > 0) {
                  return (
                    <span
                      className="mt-2.5 min-w-[18px] h-[18px] px-1 rounded-full bg-info text-white text-[10px] font-semibold grid place-items-center shrink-0"
                      title={`Unread${unreadCount ? ` (${unreadCount})` : ""}`}
                    >
                      {unreadCount > 0 ? unreadCount : ""}
                    </span>
                  );
                }
                if (lastFromFan) {
                  return <span className="mt-3 w-2 h-2 rounded-full bg-warn shrink-0" title="Read · awaiting your reply" />;
                }
                return null;
              })()}
            </button>
          );
        })}
        <div
          ref={sentinelRef}
          className="h-10 flex items-center justify-center text-[11px] text-fg-dim px-2 text-center"
        >
          {oweReplyActive
            ? (q.isFetchingMore
                ? `Scanning… ${oweReplyMatches} found in ${oweReplyScanned}`
                : oweReplyMatches === 0
                  ? `No replies needed in last ${oweReplyScanned} chats.`
                  : oweReplyScanned >= OWE_REPLY_SCAN_CAP && q.hasMore
                    ? (
                      <button
                        type="button"
                        onClick={() => q.loadMore()}
                        className="text-accent hover:underline"
                      >
                        scanned {oweReplyScanned} · {oweReplyMatches} owed · keep scanning
                      </button>
                    )
                    : !q.hasMore
                      ? `${oweReplyMatches} owed · scanned all ${oweReplyScanned}`
                      : "")
            : q.isFetchingMore
              ? "Loading more…"
              : capped && q.hasMore
                ? (
                  <button
                    type="button"
                    onClick={() => setCapRows(allRows.length + SCROLL_CAP_STEP)}
                    className="text-accent hover:underline"
                  >
                    loaded {allRows.length} chats · load more
                  </button>
                )
                : q.hasMore
                  ? ""
                  : rows.length > 0
                    ? "End of inbox."
                    : ""}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active, onClick, children, title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "px-2 py-0.5 rounded-full border transition-colors whitespace-nowrap shrink-0",
        active
          ? "bg-accent/15 text-accent border-accent/30"
          : "bg-transparent text-fg-dim border-border hover:border-border-light",
      )}
    >
      {children}
    </button>
  );
}

/** Modal-ish popover listing every pinnable list (pinned + unpinned)
 *  with a checkbox toggle. Mirrors /ui/'s folder picker. Closes on outside
 *  click or Esc. */
function FolderPicker({
  accountId, onClose,
}: { accountId: string; onClose: () => void }) {
  const all = useAllChatFolders(accountId);
  const pin = usePinChatFolder(accountId);
  const rows = all.data ?? [];

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute top-24 left-1/2 -translate-x-1/2 w-[320px] max-h-[70vh] flex flex-col bg-panel border border-border rounded-lg shadow-xl"
      >
        <div className="px-3 py-2 border-b border-border text-sm font-semibold">
          Pin folders to chat sidebar
        </div>
        <div className="flex-1 overflow-y-auto">
          {all.isFetching && rows.length === 0 && (
            <div className="p-4 text-xs text-fg-dim">Loading…</div>
          )}
          {all.isError && (
            <div className="p-4 text-xs text-err">
              Failed to load: {(all.error as Error)?.message || "unknown"}
            </div>
          )}
          {!all.isFetching && rows.length === 0 && !all.isError && (
            <div className="p-4 text-xs text-fg-dim">
              No pinnable lists yet — create one in OF first.
            </div>
          )}
          {rows.map((f) => {
            const id = String(f.id);
            const checked = !!f.isPinnedToChat;
            return (
              <label
                key={id}
                className="flex items-center gap-2 px-3 py-2 hover:bg-bg-elev-1 cursor-pointer text-xs"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={pin.isPending}
                  onChange={(e) =>
                    pin.mutate({ listId: f.id, pinned: e.target.checked })
                  }
                />
                <span className="flex-1 truncate">
                  {f.name || `List #${id}`}
                </span>
                <span className="text-fg-dim shrink-0">
                  {f.usersCount ?? f.subscribersCount ?? 0}
                </span>
              </label>
            );
          })}
        </div>
        <div className="px-3 py-2 border-t border-border flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1 rounded border border-border hover:border-border-light"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tag the preview with "you:" when the last message came from us — this
 *  is huge for triage: at a glance you see whether the fan replied or is
 *  still waiting on us. The model account's id is the row's __accountId
 *  (which == that account's OF user id). */
function previewText(c: OFChatItem): string {
  const lm = c.lastMessage;
  if (!lm) return "";
  const fromMe =
    lm.fromUser?.id != null && c.__accountId != null &&
    String(lm.fromUser.id) === c.__accountId;
  const prefix = fromMe ? "you: " : "";
  // Quick visual cues so triage doesn't need opening every row:
  //   💰  tip       — money came in
  //   🔒  PPV       — paid content sent/received
  //   📎 N media    — free media only
  const marker =
    lm.isTip ? "💰 " :
    (lm.isFree === false || lm.lockedText) ? "🔒 " :
    "";
  if (lm.text) return prefix + marker + stripHtml(lm.text);
  if (lm.mediaCount) return `${prefix}${marker || "📎 "}${lm.mediaCount} media`;
  return (prefix + marker).trim();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}


function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
