"use client";

/**
 * useFanSpend — bulk lifetime-spend lookup for ChatList row chips.
 *
 * Pulls the LIVE numbers straight from OF via `/users/list?view=x`,
 * which embeds the full `subscribedOnData` block per fan. That keeps
 * the inbox row chip in sync with OF's own creator view without
 * waiting on our event-transcoder to backfill historical transactions.
 *
 * The chat list spans multiple accounts in "all models" scope, so we
 * group fan ids by `__accountId` and fire one batch call per account.
 * OF caps `users/list` around ~50 ids; we chunk to 40 to be safe.
 *
 * Returns a Map keyed `${accountId}:${fanId}` for O(1) row lookup.
 */

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { relay, type OFChatItem } from "@/lib/relay";

export interface FanSpend {
  /** Lifetime total in cents (derived from totalSumm * 100). */
  spend_cents: number;
  /** OF's expiredAt — when the current subscription ends. We use it
   *  as a "last activity-ish" proxy when the fan has no other timestamps,
   *  but the chip primarily exists for the spend amount. */
  expired_at: string | null;
  /** Subscription status string from OF: "active", "expired", etc. */
  subscription_status: string | null;
}

interface ListedUser {
  id?: number;
  subscribedOnData?: {
    totalSumm?: number;
    expiredAt?: string | null;
    status?: string | null;
  };
}
type ListedUsersResp = Record<string, ListedUser> | ListedUser[];

const CHUNK = 40;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function useFanSpend(rows: OFChatItem[]): Map<string, FanSpend> {
  // Group fan ids by account, then chunk each account into batches OF
  // will accept. Sort within each group so the cache key is stable when
  // only the row order changes (e.g. a new unread bumps a row).
  const groups = useMemo(() => {
    const byAcct = new Map<string, Set<number>>();
    for (const r of rows) {
      const aid = r.__accountId;
      if (!aid) continue;
      if (!byAcct.has(aid)) byAcct.set(aid, new Set());
      byAcct.get(aid)!.add(r.withUser.id);
    }
    const out: Array<{ accountId: string; ids: number[]; key: string }> = [];
    for (const [aid, idSet] of byAcct) {
      const sorted = Array.from(idSet).sort((a, b) => a - b);
      for (const c of chunk(sorted, CHUNK)) {
        out.push({ accountId: aid, ids: c, key: c.join(",") });
      }
    }
    return out;
  }, [rows]);

  const queries = useQueries({
    queries: groups.map((g) => ({
      queryKey: ["fan-spend-of", g.accountId, g.key] as const,
      enabled: g.ids.length > 0,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      queryFn: () => {
        const qs = new URLSearchParams();
        for (const id of g.ids) qs.append("ids", String(id));
        qs.set("view", "x");
        return relay.get<ListedUsersResp>(
          `/api/of/v2/users/list?${qs.toString()}`,
          { accountId: g.accountId },
        );
      },
    })),
  });

  // Same trick as useFanActivity: `useQueries` returns a fresh array each
  // render, so depending on `queries` makes this memo recompute every time.
  // Key off the `dataUpdatedAt` per query so we only rebuild the Map when
  // real fetched data lands.
  const updatedKey = queries.map((q) => q.dataUpdatedAt).join("|");
  return useMemo(() => {
    const out = new Map<string, FanSpend>();
    queries.forEach((q, i) => {
      const aid = groups[i]?.accountId;
      if (!aid || !q.data) return;
      // OF returns dict keyed by user-id string when matches found,
      // empty array when nothing resolves.
      const entries: Array<[string, ListedUser]> = Array.isArray(q.data)
        ? []
        : Object.entries(q.data);
      for (const [fidStr, u] of entries) {
        const d = u.subscribedOnData;
        if (!d) continue;
        const totalSumm = typeof d.totalSumm === "number" ? d.totalSumm : 0;
        out.set(`${aid}:${fidStr}`, {
          spend_cents: Math.round(totalSumm * 100),
          expired_at: d.expiredAt ?? null,
          subscription_status: d.status ?? null,
        });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedKey, groups]);
}
