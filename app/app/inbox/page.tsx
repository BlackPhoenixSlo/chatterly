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

  // Background-warm wall-media for every account, slowly. Wall-media
  // walks up to 5 OF post pages per account (10–18s each) — when we
  // fired them eagerly on mount they DOMINATED the cold load. Now:
  //   • we wait 10s post-mount so /chats + first paint + decoration
  //     waves are all done,
  //   • we serialize accounts with a 4s gap so the relay/OF stay free
  //     for click-through traffic.
  // VaultPicker reads from this same query cache, so by the time the
  // user opens it the blue ring data is already populated. If they
  // open faster than the warmer reaches that account, the picker
  // renders anyway — rings just pop in when the call lands.
  useEffect(() => {
    if (accounts.length === 0) return;
    let cancelled = false;
    const warm = async () => {
      // Initial pause: give the UI a clean 10s of zero background load
      // so cold-load decoration + first interaction is unimpeded.
      await new Promise((r) => setTimeout(r, 10_000));
      for (const acc of accounts) {
        if (cancelled) return;
        // vault-lists is cheap (~500ms) — kicks off first so the
        // folder dropdown is instant when the picker opens.
        await qc.prefetchQuery({
          queryKey: ["vault-lists", acc.id],
          queryFn: () =>
            relay.get("/api/of/v2/vault/lists?view=main&limit=50", { accountId: acc.id }),
          staleTime: 5 * 60 * 1000,
        }).catch(() => {});
        if (cancelled) return;
        // First page of vault media (default "all" type, no folder) — the
        // exact query useVaultMedia issues when the picker opens. With this
        // warm, the grid renders instantly; without it the user waits for
        // /vault/media (~700ms) on first open. Key shape mirrors
        // useVaultMedia: ["vault-media", accountId, type, listId].
        await qc.prefetchInfiniteQuery({
          queryKey: ["vault-media", acc.id, "all", null],
          initialPageParam: 0,
          queryFn: () =>
            relay.get(
              "/api/of/v2/vault/media?limit=24&offset=0&type=all",
              { accountId: acc.id },
            ),
          staleTime: 60_000,
        }).catch(() => {});
        if (cancelled) return;
        // wall-media is the expensive one (5-page OF post walk). Cached
        // already from a previous session? prefetchQuery is a no-op when
        // staleTime hasn't elapsed.
        await qc.prefetchQuery({
          queryKey: ["wall-media", acc.id],
          queryFn: () =>
            relay.get(`/admin/vault/wall-media?account_id=${encodeURIComponent(acc.id)}`),
          staleTime: 60 * 60 * 1000,
        }).catch(() => {});
        if (cancelled) return;
        // Pace between accounts so a 5-account workspace doesn't pin
        // the relay's stream pool for 90s straight.
        await new Promise((r) => setTimeout(r, 4_000));
      }
    };
    void warm();
    return () => { cancelled = true; };
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
