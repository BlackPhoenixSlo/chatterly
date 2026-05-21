"use client";

/**
 * /inbox — Unified Inbox + per-model.
 *
 * Layout: two-pane. Left = ChatList (scope-aware). Right = ChatSurface
 * for the selected chat, or an empty placeholder.
 *
 * Why selection lives here: switching chats should unmount and remount
 * the ChatSurface (fresh hooks, fresh refs), which we do via `key=`.
 * That's the React-idiomatic answer to the desktop-app's `connectionId`
 * key pattern from §12.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ChatList, type ChatListSelection } from "@/components/chat/ChatList";
import { ChatSurface } from "@/components/chat/ChatSurface";
import { useInboxRealtime } from "@/hooks/useInboxRealtime";
import { useActiveAccounts } from "@/hooks/useAccounts";
import { useScope } from "@/contexts/ScopeContext";
import { relay } from "@/lib/relay";

export default function InboxPage() {
  const [selected, setSelected] = useState<ChatListSelection | null>(null);
  useInboxRealtime();
  const qc = useQueryClient();
  const accounts = useActiveAccounts();
  const { scope } = useScope();

  // Clear the selected chat when the new scope no longer covers it.
  // Unified ("all") keeps everything; switching to a different model
  // hides the surface so the user picks a fan from the new model's list.
  useEffect(() => {
    if (!selected) return;
    if (scope.kind === "model" && selected.accountId !== scope.accountId) {
      setSelected(null);
    }
  }, [scope, selected]);

  // Background-warm the vault caches so the first VaultPicker open is
  // instant. Two waves, both tagged `X-Priority: background` so the
  // relay's per-account lane (4 total / 2 background slots, see
  // service/server.py `_priority_lane`) always keeps reserved slots for
  // a user click that lands mid-warm. Within an account, lists + first
  // page of media run in parallel. Across accounts, accounts also run
  // in parallel — lanes are per-account so they don't interfere, and
  // network is the only shared resource.
  //
  // Wave 1 (cheap, fires ~800ms after mount): vault-lists + vault-media
  //   first page. These are what VaultPicker reads on open. Together
  //   they cover the "click vault → grid is already there" case.
  //
  // Wave 2 (expensive, fires ~15s after mount): wall-media. This walks
  //   5 OF post pages per account and drives the blue "sent on wall"
  //   rings in the picker. The grid renders without it; rings just pop
  //   in when wave 2 lands. Delayed so it doesn't share bandwidth with
  //   wave 1 or with first-click traffic.
  //
  // If a user opens the picker between mount and wave 1 they pay the
  // OF cold cost once — but the relay lane reservation means their
  // call jumps ahead of anything still queued for background.
  useEffect(() => {
    if (accounts.length === 0) return;
    let cancelled = false;
    const BG = { priority: "background" as const };

    const warmAccount = async (aid: string) => {
      if (cancelled) return;
      await Promise.all([
        qc.prefetchQuery({
          queryKey: ["vault-lists", aid],
          queryFn: () =>
            relay.get("/api/of/v2/vault/lists?view=main&limit=50", { accountId: aid, ...BG }),
          staleTime: 5 * 60 * 1000,
        }).catch(() => {}),
        qc.prefetchInfiniteQuery({
          queryKey: ["vault-media", aid, "all", null],
          initialPageParam: 0,
          queryFn: () =>
            relay.get(
              "/api/of/v2/vault/media?limit=24&offset=0&type=all",
              { accountId: aid, ...BG },
            ),
          staleTime: 60_000,
        }).catch(() => {}),
      ]);
    };

    const warmWallMedia = async (aid: string) => {
      if (cancelled) return;
      await qc.prefetchQuery({
        queryKey: ["wall-media", aid],
        queryFn: () =>
          relay.get(
            `/admin/vault/wall-media?account_id=${encodeURIComponent(aid)}`,
            BG,
          ),
        staleTime: 60 * 60 * 1000,
      }).catch(() => {});
    };

    const t1 = window.setTimeout(() => {
      if (cancelled) return;
      void Promise.all(accounts.map((a) => warmAccount(a.id)));
    }, 800);

    const t2 = window.setTimeout(() => {
      if (cancelled) return;
      void Promise.all(accounts.map((a) => warmWallMedia(a.id)));
    }, 15_000);

    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [accounts, qc]);

  return (
    <div className="h-[calc(100vh-3.5rem)] grid grid-cols-[320px_minmax(0,1fr)] overflow-hidden">
      <ChatList selected={selected} onSelect={setSelected} />
      {selected ? (
        <ChatSurface
          key={`${selected.accountId}:${selected.fanId}`}
          accountId={selected.accountId}
          fanId={selected.fanId}
          chat={selected.chat}
        />
      ) : (
        <div className="grid place-items-center h-full text-sm text-fg-dim">
          Pick a conversation on the left.
        </div>
      )}
    </div>
  );
}
