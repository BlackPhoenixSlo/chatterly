"use client";

/**
 * useChatList — fetches the inbox chat list, with built-in support for
 * "all models" (Unified Inbox) fan-out.
 *
 * Scope mapping:
 *   • scope.kind === "model" → single call to /api/of/v2/chats with
 *     X-Account-Id pinned to that model.
 *   • scope.kind === "all"   → parallel calls across every account that
 *     has a session. We merge by lastMessage.createdAt, tag each row with
 *     __accountId so the UI can show the colored dot.
 *
 * Polling: 60s, matching the desktop-app's cadence. SSE events drive
 * cheaper between-poll invalidations (Phase B.2).
 */

import { useInfiniteQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { useScope } from "@/contexts/ScopeContext";
import { relay, type OFChatItem, type OFChatsResp, type OFUserMini } from "@/lib/relay";
import { useActiveAccounts } from "./useAccounts";

const PAGE_SIZE = 25;

interface ChatListParams {
  filter?: "unread" | "pinned" | "priority" | null;
  /** Custom fan-list id to filter by (e.g. a pinned chat-folder). */
  listId?: string | null;
  query?: string | null;
  limit?: number;
}

interface UserListResp { [id: string]: OFUserMini & {
  avatarThumbs?: { c50?: string; c144?: string };
  isActive?: boolean;
  lastSeen?: string | null;
} }

function normalizeChats(resp: OFChatsResp, accountId: string): OFChatItem[] {
  const list = resp.list || resp.chats || [];
  // OF returns `unreadMessagesCount` (number); the rest of the app reads
  // `hasUnread` (boolean). Derive it here so every consumer — the dot,
  // filter chips, mark-all-read, SSE handlers — sees a consistent flag.
  return list.map((c) => {
    const cnt =
      (c as OFChatItem & { unreadMessagesCount?: number }).unreadMessagesCount ?? 0;
    return {
      ...c,
      __accountId: accountId,
      unreadMessagesCount: cnt,
      hasUnread: cnt > 0 || !!c.hasUnread,
    };
  });
}

/** OF's /chats only returns `{withUser: {id, _view}}`. Batch-fetch real
 *  names/avatars via /users/list (max 50 ids per call) and merge.
 *
 *  Also writes each enriched profile to the per-fan `["of-user", aid, fid]`
 *  query cache. ChatList rows observe that cache at render time, so even
 *  if the chats cache later gets overwritten with slim rows (refetch, SSE
 *  patch, etc.), the rail label keeps the enriched name + custom nickname.
 *  The cache is keyed per-fan with stable identity, so refetches of the
 *  chat list don't touch it. */
async function enrichWithUsers(
  chats: OFChatItem[],
  accountId: string,
  qc: QueryClient,
): Promise<OFChatItem[]> {
  if (chats.length === 0) return chats;
  // Dedup ids and chunk by 50 — OF's hard limit for the batch endpoint.
  const ids = Array.from(new Set(chats.map((c) => c.withUser.id))).filter(Boolean);
  if (ids.length === 0) return chats;

  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

  const byId = new Map<number, {
    id: number;
    name?: string;
    username?: string;
    avatar?: string | null;
    isActive?: boolean;
    lastSeen?: string | null;
    customNickname?: string | null;
  }>();
  await Promise.all(
    chunks.map(async (chunk) => {
      const qs = new URLSearchParams();
      for (const id of chunk) qs.append("ids", String(id));
      qs.set("view", "m");
      try {
        const resp = await relay.get<UserListResp>(
          `/api/of/v2/users/list?${qs.toString()}`,
          { accountId },
        );
        for (const [k, u] of Object.entries(resp || {})) {
          const nid = Number(k);
          if (!Number.isFinite(nid)) continue;
          const profile = {
            id: nid,
            name: u.name,
            username: u.username,
            avatar: u.avatarThumbs?.c50 || u.avatarThumbs?.c144 || u.avatar || null,
            isActive: u.isActive,
            lastSeen: u.lastSeen ?? null,
            customNickname: u.customNickname ?? null,
          };
          byId.set(nid, profile);
          // Stable per-fan cache. Survives any subsequent chats refetch
          // because the key is (accountId, fanId), not the chats list key.
          // MERGE rather than replace: `useOFUser` keys on the same
          // ["of-user", aid, fid] but stores the rich profile (incl.
          // subscribedOnData + listsStates) that backs FanDrawer's live
          // spend grid and ChatActionsMenu's lists submenu. A bare
          // replace here would wipe those fields on every 60s chats
          // refetch / SSE patch and the panel would go blank until
          // staleTime expired. Spreading prev preserves rich data
          // already in cache; if none exists, we still seed the slim
          // shape the ChatList rail wants.
          qc.setQueryData<Record<string, unknown> | undefined>(
            ["of-user", accountId, nid],
            (prev) => ({
              ...(prev ?? {}),
              id: nid,
              name: u.name,
              username: u.username,
              avatar: profile.avatar,
              customNickname:
                profile.customNickname
                ?? (prev as { customNickname?: string | null } | undefined)?.customNickname
                ?? null,
            }),
          );
        }
      } catch (err) {
        // Best-effort: a single chunk failing shouldn't blank the inbox.
        // Rows for those ids will fall back to "fan <id>".
        console.warn("[chats] enrich users/list failed", err);
      }
    }),
  );

  return chats.map((c) => {
    const u = byId.get(c.withUser.id);
    if (!u) return c;
    // Note: `isActive` on /users/list is "account exists/not banned",
    // NOT live online presence. OF doesn't expose presence on this path,
    // so we don't pretend — `isOnline` stays falsy unless OF gives it.
    return { ...c, withUser: { ...c.withUser, ...u } };
  });
}

/** Sort newest-first by lastMessage.createdAt. Falls back to fan id so
 *  rows without a lastMessage still get a stable order. */
function compareChats(a: OFChatItem, b: OFChatItem): number {
  const ta = a.lastMessage?.createdAt ?? "";
  const tb = b.lastMessage?.createdAt ?? "";
  if (ta && tb && ta !== tb) return tb.localeCompare(ta);
  return (b.withUser?.id || 0) - (a.withUser?.id || 0);
}

interface ChatsPage {
  rows: OFChatItem[];
  hasMore: boolean;
}

async function fetchPage(
  scope: ReturnType<typeof useScope>["scope"],
  accounts: ReturnType<typeof useActiveAccounts>,
  offset: number,
  filter: ChatListParams["filter"],
  listId: ChatListParams["listId"],
  query: ChatListParams["query"],
  limit: number,
  qc: QueryClient,
): Promise<ChatsPage> {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  qs.set("order", "recent");
  if (filter) qs.set("filter", filter);
  if (listId) qs.set("list_id", listId);
  if (query) qs.set("query", query);
  const path = `/api/of/v2/chats?${qs.toString()}`;

  if (scope.kind === "model") {
    const resp = await relay.get<OFChatsResp>(path, { accountId: scope.accountId });
    const raw = normalizeChats(resp, scope.accountId);
    // Kick off enrichment in the BACKGROUND so the rail paints immediately.
    // Enrichment writes per-fan profiles to the ["of-user", aid, fid] cache;
    // the row component observes that cache and picks up names + nicknames
    // as soon as /users/list lands. Don't await — that would slow cold paint.
    void enrichWithUsers(raw, scope.accountId, qc).catch(() => {});
    return { rows: raw.sort(compareChats), hasMore: !!resp.hasMore };
  }

  // Unified: each account independently paginates at this offset. We treat
  // hasMore as true if ANY account reported hasMore — that's the safe choice
  // since we want the user to be able to fetch more from the accounts that
  // still have data.
  const results = await Promise.allSettled(
    accounts.map(async (acc) => {
      const r = await relay.get<OFChatsResp>(path, { accountId: acc.id });
      const raw = normalizeChats(r, acc.id);
      void enrichWithUsers(raw, acc.id, qc).catch(() => {});
      return { raw, hasMore: !!r.hasMore };
    }),
  );
  const merged: OFChatItem[] = [];
  let anyMore = false;
  for (const r of results) {
    if (r.status === "fulfilled") {
      merged.push(...r.value.raw);
      if (r.value.hasMore) anyMore = true;
    }
  }
  return { rows: merged.sort(compareChats), hasMore: anyMore };
}

export function useChatList(params: ChatListParams = {}) {
  const { scope } = useScope();
  const accounts = useActiveAccounts();
  const qc = useQueryClient();
  const { filter, listId, query, limit = PAGE_SIZE } = params;

  // Stable query key: unified mode fans out across all session-bearing
  // accounts, so cache invalidation depends on the *set* of ids.
  const accountKey =
    scope.kind === "model"
      ? scope.accountId
      : accounts.map((a) => a.id).sort().join(",");

  const queryKey = [
    "chats", scope.kind, accountKey,
    filter ?? null, listId ?? null, query ?? null, limit,
  ] as const;

  const q = useInfiniteQuery<ChatsPage>({
    queryKey,
    enabled:
      scope.kind === "model" ? !!scope.accountId : accounts.length > 0,
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length * limit : undefined,
    queryFn: ({ pageParam }) =>
      fetchPage(scope, accounts, (pageParam as number) ?? 0, filter, listId, query, limit, qc),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  // Flatten + de-dupe by (accountId, fanId). The realtime SSE handler also
  // moves rows around, so duplication can creep in across pages.
  const rows: OFChatItem[] = [];
  const seen = new Set<string>();
  for (const p of q.data?.pages ?? []) {
    for (const c of p.rows) {
      const key = `${c.__accountId ?? ""}:${c.withUser.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(c);
    }
  }

  return {
    ...q,
    // Mirror the previous useQuery surface so the component doesn't have
    // to know we switched to infinite mode.
    data: rows,
    hasMore: !!q.hasNextPage,
    loadMore: () => q.fetchNextPage(),
    isFetchingMore: q.isFetchingNextPage,
  };
}
