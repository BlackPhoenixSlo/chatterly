"use client";

/**
 * ChatSurface — the right pane: title bar + MessageList + Composer.
 *
 * Owns the per-chat hook (useChatMessages) and the send hook
 * (useSendMessage) — keeping them here means the ChatList re-rendering
 * doesn't unmount the active chat, and switching chats unmounts/remounts
 * this subtree cleanly (we pass a `key` from the parent).
 *
 * Click the header (avatar/name) to open the FanDrawer with the
 * editable profile overlay.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn, decodeHtmlEntities } from "@/lib/utils";
import { openGroupTab } from "@/lib/groupChannel";

import { useChatMessages } from "@/hooks/useChatMessages";
import { useSendMessage } from "@/hooks/useSendMessage";
import { useLikeMessage } from "@/hooks/useLikeMessage";
import { useTogglePinMessage } from "@/hooks/useTogglePinMessage";
import { useFan } from "@/hooks/useFan";
import { readFanDrawerDefault, useFanDrawerDefault } from "@/hooks/useFanDrawerDefault";
import { usePendingScheduled, pendingToPseudoMessage } from "@/hooks/usePendingScheduled";
import { useEmployee } from "@/contexts/EmployeeContext";
import { proxyImage, relay, type OFChatItem, type OFMessage, type OFUserMini } from "@/lib/relay";

import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { FanDrawer } from "./FanDrawer";
import { ScheduledForChat } from "./ScheduledForChat";
import { ChatSearch } from "./ChatSearch";
import { ChatActionsMenu } from "./ChatActionsMenu";
import { PinnedBar, PinnedPopover, PinnedSidePanel } from "./PinnedPanel";

export interface QuotedReply {
  /** OF message id we're quoting from. */
  messageId: number;
  /** Plain-text preview shown in the composer + prepended on send. */
  preview: string;
  /** Author name for the preview header — defaults to "fan" if absent. */
  authorName: string;
}

interface MeResp {
  id: number;
  name?: string;
  username?: string;
}

export function ChatSurface({
  accountId, fanId, chat, forceDrawerOpen = false, forcePinnedPanelOpen = false,
}: {
  accountId: string;
  fanId: number;
  chat: OFChatItem;
  /** Force the FanDrawer to be pinned + open regardless of the user's
   *  "keep open by default" setting. Used by the standalone popout
   *  window at /chat/[accountId]/[fanId] where the right-side fan info
   *  is the whole point of opening a dedicated window. */
  forceDrawerOpen?: boolean;
  /** Promote the pinned-messages popover into a full-height left
   *  column. Used by the popout — the inbox-style space on the left
   *  has no ChatList there, so it becomes a permanent pinned-messages
   *  surface mirroring the fan-info panel on the right. Hides the
   *  top bar + bottom-left popover to avoid duplicate surfaces. */
  forcePinnedPanelOpen?: boolean;
}) {
  const { current: currentEmployee } = useEmployee();
  const qc = useQueryClient();
  void currentEmployee;

  const [drawerKeepOpenPref] = useFanDrawerDefault();
  const drawerKeepOpen = forceDrawerOpen || drawerKeepOpenPref;
  const [drawerOpen, setDrawerOpen] = useState(
    () => forceDrawerOpen || readFanDrawerDefault(),
  );
  const [quoted, setQuoted] = useState<QuotedReply | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);

  // When the user flips the persisted toggle while a chat is open, mirror
  // the change into local state so the drawer opens/closes live without
  // requiring a chat-switch (which is what triggers the initializer).
  useEffect(() => {
    setDrawerOpen(drawerKeepOpen);
  }, [drawerKeepOpen]);

  // Resolve the model account's OF user id — needed to decide direction
  // (outgoing if message.fromUser.id === ownerUserId).
  const meQ = useQuery<MeResp>({
    queryKey: ["of-me", accountId],
    queryFn: () => relay.get<MeResp>("/api/of/v2/users/me", { accountId }),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const handle = useChatMessages({ accountId, fanId, enabled: true });

  // Prefetch the fan row so opening the drawer is instant. The hook
  // is cheap (one indexed sqlite lookup) and the data drives the
  // custom_nickname we want to show in the header.
  const fanQ = useFan(accountId, fanId);

  // Observe the per-fan profile cache that enrichWithUsers populates from
  // /users/list. ChatList already reads from this side channel so its rows
  // pick up nickname/name/avatar; the surface header needs the same path
  // because the `chat` prop is the slim row (enrichment writes to this
  // cache, not back into the chats list cache). queryFn is a placeholder
  // that never runs (enabled:false) but satisfies react-query v5's
  // "missing queryFn" warning — the cache is written by enrichWithUsers
  // + useFan's onSuccess, not by this query.
  const profileQ = useQuery<OFUserMini>({
    queryKey: ["of-user", accountId, fanId],
    queryFn: () => Promise.reject(new Error("observe-only")),
    enabled: false,
    staleTime: Infinity,
  });
  const profile = profileQ.data;

  // Mark the chat read on open. Patches the inbox cache locally so the
  // blue dot disappears immediately, then fires the server POST in the
  // background (fire-and-forget — OF will catch up on its next poll
  // even if our request 5xxs).
  useEffect(() => {
    if (!chat.hasUnread) return;
    let cancelled = false;
    relay
      .post(`/api/of/v2/chats/${fanId}/mark-as-read`, undefined, { accountId })
      .catch((err) => console.warn("[mark-as-read] failed", err));
    type Page = { rows: OFChatItem[]; hasMore: boolean };
    type Infinite = { pages: Page[]; pageParams: unknown[] };
    qc.getQueryCache().findAll({ queryKey: ["chats"] }).forEach((q) => {
      const data = q.state.data as Infinite | undefined;
      if (!data?.pages) return;
      const newPages: Page[] = data.pages.map((p) => ({
        ...p,
        rows: p.rows.map((c) =>
          (c.__accountId ?? "") === accountId && c.withUser.id === fanId
            ? { ...c, hasUnread: false, unreadMessagesCount: 0 }
            : c,
        ),
      }));
      if (!cancelled) qc.setQueryData(q.queryKey, { ...data, pages: newPages });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, fanId]);

  const sender = useSendMessage({
    accountId,
    fanId,
    fromUserId: meQ.data?.id,
    fromUserName: meQ.data?.name ?? meQ.data?.username ?? "you",
    hookHandle: handle,
  });
  const liker = useLikeMessage(accountId, fanId);
  const pinner = useTogglePinMessage(accountId, fanId);

  // Pre-warm only the fan-specific cache here — the account-wide ones
  // (vault-lists, wall-media) are kicked off from the inbox page at app
  // start so they don't compete with the message fetch on chat-open.
  // Delay even this small query so the visible message list gets first
  // crack at the relay's request budget.
  useEffect(() => {
    if (!accountId || fanId == null) return;
    const t = setTimeout(() => {
      qc.prefetchQuery({
        queryKey: ["vault-history", accountId, fanId],
        queryFn: () =>
          relay.get(`/admin/vault/fan-history?account_id=${encodeURIComponent(accountId)}&fan_id=${fanId}`),
        staleTime: 60_000,
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [accountId, fanId, qc]);

  // Backfill historical vault-sends from chat messages already loaded.
  // We hooked the auto-record at send-time AFTER feature-ship, so any
  // chat that existed before that has no rows — meaning the picker's
  // sent/purchased rings stay empty. Walking the message stream and
  // batch-POSTing missing rows fills that gap lazily, scoped to the
  // chat the user is actually looking at.
  //
  // Idempotent on the backend (dupe-checks by message_id) so it's safe
  // to fire on every load — older pages picked up via loadOlder also
  // trigger this when handle.data changes.
  const backfilledMsgIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!accountId || fanId == null) return;
    const messages = handle.data ?? [];
    const myId = meQ.data?.id;
    if (!myId || messages.length === 0) return;

    const items: Array<{
      message_id: number;
      media_ids: number[];
      price_cents: number;
      was_purchased: boolean | null;
    }> = [];
    for (const m of messages) {
      const mid = typeof m.id === "number" ? m.id : Number(m.id);
      if (!Number.isFinite(mid) || mid <= 0) continue;
      // Only outgoing messages count — incoming ones come from the fan,
      // not from us, so they have no business in vault_sends.
      if (m.fromUser?.id !== myId) continue;
      const mediaIds = (m.media ?? [])
        .map((x) => (typeof x.id === "number" ? x.id : Number(x.id)))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (mediaIds.length === 0) continue;
      if (backfilledMsgIdsRef.current.has(mid)) continue;
      items.push({
        message_id: mid,
        media_ids: mediaIds,
        price_cents: Math.max(0, Math.round((m.price || 0) * 100)),
        // PPV: isOpened flips true once the fan paid. For free sends OF
        // also reports isOpened=true when the fan opens the chat, which
        // is meaningless — leave was_purchased null in that case.
        was_purchased: (m.price ?? 0) > 0 ? !!m.isOpened : null,
      });
      backfilledMsgIdsRef.current.add(mid);
    }
    if (items.length === 0) return;

    relay
      .post("/admin/vault/sends/backfill", {
        account_id: accountId,
        fan_id: fanId,
        items,
      })
      .then((r) => {
        const resp = r as { inserted?: number } | undefined;
        if ((resp?.inserted ?? 0) > 0) {
          qc.invalidateQueries({ queryKey: ["vault-history", accountId, fanId] });
        }
      })
      .catch((err) => console.warn("[vault backfill] failed", err));
  }, [accountId, fanId, handle.data, meQ.data?.id, qc]);

  // The chat-list row holds OF's `lastReadMessageId` — the highest msg id
  // the fan has marked read. We prefer the prop (live from inbox), but
  // fall back to the chat-list cache so the popout page can also show ✓✓.
  const lastReadByPeerId = useMemo<number | null>(() => {
    if (chat.lastReadMessageId != null) return chat.lastReadMessageId;
    type Page = { rows: OFChatItem[]; hasMore: boolean };
    type Infinite = { pages: Page[]; pageParams: unknown[] };
    let found: number | null = null;
    qc.getQueryCache().findAll({ queryKey: ["chats"] }).forEach((q) => {
      const data = q.state.data as Infinite | undefined;
      if (!data?.pages) return;
      for (const p of data.pages) {
        for (const c of p.rows) {
          if ((c.__accountId ?? "") === accountId && c.withUser.id === fanId) {
            if (c.lastReadMessageId != null) found = c.lastReadMessageId;
            return;
          }
        }
      }
    });
    return found;
  }, [accountId, fanId, chat.lastReadMessageId, qc]);

  function onQuoteReply(msg: OFMessage) {
    const preview = stripHtmlPreview(msg.text || "(media)", 140);
    setQuoted({
      messageId: Number(msg.id),
      preview,
      authorName: msg.fromUser?.name || msg.fromUser?.username || "fan",
    });
  }

  function jumpToMessage(id: number) {
    setHighlightId(id);
    setSearchOpen(false);
    // Drop the highlight ring after a couple seconds so it doesn't linger
    // through the next scroll-up that brings it back into view.
    setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 3000);
  }

  // Pending local-wait sends live in a separate cache; merge them into
  // the message stream as pseudo-bubbles so the operator sees what's
  // about to go out (and can cancel) without leaving the chat. Memoize
  // so the MessageList's "did the array change" effect doesn't fire
  // every render — the auto-scroll-to-bottom depends on a stable ref.
  const pendingQ = usePendingScheduled(accountId, fanId);
  const mergedMessages: OFMessage[] = useMemo(() => {
    const real = handle.data ?? [];
    const pending = pendingQ.data ?? [];
    if (pending.length === 0) return real;
    return [...real, ...(pending.map(pendingToPseudoMessage) as unknown as OFMessage[])];
  }, [handle.data, pendingQ.data]);

  // Pinned slice sourced from the loaded messages cache — no extra OF
  // fetch. Only pinned items inside the currently-loaded backlog show;
  // scrolling up to load older pages will surface older pins too.
  const pinnedMessages = useMemo(
    () => (handle.data ?? []).filter((m) => m.isPinned),
    [handle.data],
  );

  const headerName = decodeHtmlEntities(
    fanQ.data?.custom_nickname ||
    profile?.customNickname ||
    chat.withUser.customNickname ||
    profile?.name ||
    chat.withUser.name ||
    profile?.username ||
    chat.withUser.username ||
    `fan ${chat.withUser.id}`,
  );
  const headerAvatarRaw =
    chat.withUser.avatar || profile?.avatar || fanQ.data?.avatar_url || null;
  const headerAvatar = proxyImage(headerAvatarRaw, accountId);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 bg-bg overflow-hidden">
      {forcePinnedPanelOpen && (
        <PinnedSidePanel
          pinned={pinnedMessages}
          ownerUserId={meQ.data?.id ?? null}
          onJumpTo={jumpToMessage}
        />
      )}
      <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
      <header className="relative border-b border-border px-4 py-3 flex items-center gap-3 bg-panel">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left hover:bg-bg-elev-1/40 -mx-1 px-1 py-1 rounded-md transition-colors"
          title="Open fan profile"
        >
          <div className="w-9 h-9 rounded-full bg-bg-elev-1 grid place-items-center text-sm overflow-hidden shrink-0">
            {headerAvatar ? (
              <img
                src={headerAvatar}
                alt=""
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
              />
            ) : (
              <span>{headerName.slice(0, 1).toUpperCase()}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm truncate">{headerName}</div>
            <div className="text-[11px] text-fg-dim truncate">
              @{chat.withUser.username || profile?.username || fanQ.data?.of_username || chat.withUser.id} · acct {accountId}
            </div>
          </div>
        </button>
        <ScheduledForChat accountId={accountId} fanId={fanId} />
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className={cn(
            "text-[11px] underline underline-offset-2",
            searchOpen ? "text-accent" : "text-fg-dim hover:text-fg",
          )}
          title="Search this conversation"
        >
          🔍 search
        </button>
        <a
          href={`/chat/${encodeURIComponent(accountId)}/${fanId}`}
          target="_blank"
          // No rel="noreferrer" / "noopener" on purpose: we want the
          // popout to keep its window.opener set so it can later call
          // window.close() on itself when the user adds it to the
          // group tab via the 👥 button. Same-origin internal link,
          // not security-sensitive.
          className="text-[11px] text-fg-dim hover:text-fg underline underline-offset-2"
          title="Open this chat in a new tab"
        >
          ↗ pop out
        </a>
        <GroupChatButton accountId={accountId} fanId={fanId} />
        <button
          type="button"
          onClick={() => handle.refresh()}
          className="text-[11px] text-fg-dim hover:text-fg underline underline-offset-2"
        >
          refresh
        </button>
        <button
          type="button"
          onClick={() => setActionsOpen((v) => !v)}
          className="text-fg-dim hover:text-fg text-lg leading-none px-1"
          title="More actions"
          aria-label="More actions"
        >
          ⋯
        </button>
        {actionsOpen && (
          <ChatActionsMenu
            accountId={accountId}
            fanId={fanId}
            chat={chat}
            onClosed={() => setActionsOpen(false)}
          />
        )}
      </header>

      {searchOpen && (
        <ChatSearch
          accountId={accountId}
          fanId={fanId}
          messages={mergedMessages}
          ownerUserId={meQ.data?.id ?? null}
          hasOlder={handle.hasOlder}
          loadingOlder={handle.isLoadingOlder}
          onLoadOlder={() => handle.loadOlder()}
          onPick={jumpToMessage}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {!forcePinnedPanelOpen && (
        <PinnedBar
          pinned={pinnedMessages}
          open={pinnedOpen}
          onToggle={() => setPinnedOpen((v) => !v)}
        />
      )}

      <MessageList
        messages={mergedMessages}
        ownerUserId={meQ.data?.id ?? null}
        accountId={accountId}
        isLoading={handle.isLoading}
        isError={handle.isError}
        error={handle.error as Error | null}
        hasOlder={handle.hasOlder}
        loadingOlder={handle.isLoadingOlder}
        onLoadOlder={() => handle.loadOlder()}
        onRetry={sender.retry}
        onCancelScheduled={sender.cancelPendingScheduled}
        onToggleLike={(msg) => liker.toggle(msg)}
        onQuoteReply={onQuoteReply}
        onTogglePin={(msg) => pinner.toggle(msg)}
        highlightId={highlightId}
        lastReadByPeerId={lastReadByPeerId}
      />

      {!forcePinnedPanelOpen && (
        <PinnedPopover
          pinned={pinnedMessages}
          ownerUserId={meQ.data?.id ?? null}
          open={pinnedOpen}
          onClose={() => setPinnedOpen(false)}
          onJumpTo={jumpToMessage}
        />
      )}

      <Composer
        accountId={accountId}
        fanId={fanId}
        quoted={quoted}
        onClearQuoted={() => setQuoted(null)}
        onSend={(args) => {
          // Closing the pinned popover on send is the second half of the
          // hide rule (the first half is click-out, owned by the popover
          // itself). Keep this before the OF call so the panel disappears
          // even if send returns an error.
          setPinnedOpen(false);
          // OF supports native quote-reply via `replyToMessageId`. Threading
          // it through the send body makes the fan's OF client render the
          // quoted message as a card above the reply — same UX as OF web.
          const replyMsgId = quoted?.messageId;
          // Capture the original message body for the optimistic bubble so
          // we render the quote card immediately, without waiting for OF
          // to echo `replyToMessage` back on the next refetch.
          const replySnapshot = quoted
            ? (() => {
                const orig = (handle.data ?? []).find(
                  (m) => Number(m.id) === quoted.messageId,
                );
                if (!orig) {
                  return {
                    id: quoted.messageId,
                    text: quoted.preview,
                    fromUser: { id: -1, name: quoted.authorName },
                  };
                }
                return {
                  id: Number(orig.id),
                  text: orig.text,
                  fromUser: orig.fromUser,
                  createdAt: orig.createdAt,
                  mediaCount: orig.mediaCount,
                };
              })()
            : null;
          setQuoted(null);
          return sender.send({
            text: args.text,
            price: args.price,
            lockedText: args.lockedText,
            attached: args.attached,
            scheduledAt: args.scheduledAt,
            replyToMessageId: replyMsgId,
            replyToMessage: replySnapshot,
          });
        }}
        inflight={sender.inflight}
        placeholder={`Message ${headerName}…`}
        canSend={chat.canSendMessage !== false}
        cannotSendReason={chat.canNotSendReason ?? null}
      />

      {/* Overlay drawer — only when keep-open is OFF. The dimmed backdrop
       *  and click-out close live inside FanDrawer for this branch. */}
      {!drawerKeepOpen && (
        <FanDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          accountId={accountId}
          fanId={fanId}
          chat={chat}
        />
      )}
      </div>
      {/* Pinned drawer — in-flow side column when keep-open is ON. Acts as
       *  a third column inside the inbox (list | chat | drawer). When the
       *  popout passes forceDrawerOpen, the close button becomes a no-op
       *  so the panel stays glued to the right edge for the whole session. */}
      {drawerKeepOpen && drawerOpen && (
        <FanDrawer
          pinned
          alwaysOn={forceDrawerOpen}
          open={drawerOpen}
          onClose={() => { if (!forceDrawerOpen) setDrawerOpen(false); }}
          accountId={accountId}
          fanId={fanId}
          chat={chat}
        />
      )}
    </div>
  );
}

/** Header "👥 group" button. Routes via the BroadcastChannel coord
 *  layer so clicks NEVER navigate the source tab — including the case
 *  where the source IS a popout (`/chat/<acct>/<fan>`). If a /group
 *  tab is alive AND has room, the click pushes a slot into it. If the
 *  current group tab is full (8 slots), a fresh group tab is spawned
 *  with this one fan as its first slot. */
function GroupChatButton({ accountId, fanId }: { accountId: string; fanId: number }) {
  const [flash, setFlash] = useState<null | "added" | "opened" | "focused">(null);
  const onClick = async () => {
    const res = await openGroupTab(accountId, fanId);
    setFlash(
      res.kind === "opened" ? "opened"
        : res.kind === "focused" ? "focused"
        : "added",
    );
    // Popout self-close: when this surface is the standalone /chat
    // popout (URL = /chat/<acct>/<fan>) AND the click resolved into
    // the live group tab (no new tab spawned), close the popout so
    // the user lands on whatever tab takes focus next — ideally the
    // group tab via the broadcast-focus message we just sent. The
    // 80ms delay lets that broadcast reach the group tab before this
    // window dies, otherwise some browsers fast-track focus back to
    // the opener instead of the broadcast target.
    //
    // window.close() only works because the popout link drops
    // rel="noreferrer" — popouts opened before that change can't
    // close themselves; user closes manually.
    if (
      (res.kind === "broadcast" || res.kind === "focused") &&
      typeof window !== "undefined" &&
      /^\/chat\//.test(window.location.pathname)
    ) {
      window.setTimeout(() => { try { window.close(); } catch { /* policy denial */ } }, 80);
    }
    window.setTimeout(() => setFlash(null), 1400);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-[11px] underline underline-offset-2 transition-colors",
        flash === "added" ? "text-ok"
          : flash === "opened" ? "text-accent"
          : flash === "focused" ? "text-fg-dim"
          : "text-fg-dim hover:text-fg",
      )}
      title="Add to group chat tab"
    >
      {flash === "added" ? "✓ added"
        : flash === "opened" ? "↗ opened"
        : flash === "focused" ? "↗ in group"
        : "👥 group"}
    </button>
  );
}

/** Plain-text preview from OF's HTML body — used for both quote previews
 *  and search match snippets. Cheap and intentionally lossy: anything
 *  beyond `max` is truncated with an ellipsis. */
function stripHtmlPreview(s: string, max: number): string {
  const plain = s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
}
