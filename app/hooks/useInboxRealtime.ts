"use client";

/**
 * useInboxRealtime — listens to the SSE bus and invalidates the right
 * TanStack Query keys so the inbox updates without polling.
 *
 * Events we care about (matching service/event_transcoder.py):
 *   • api2_chat_message  — a new message in some chat
 *   • chat_messages      — a chat preview update (OF push)
 *
 * Strategy:
 *   • For chat message events, append the message to that chat's cache
 *     directly (zero round-trip) and bump the chat-list cache so the
 *     row jumps to the top.
 *   • Fallback: invalidate the chat-list query so the next paint refetches.
 *
 * Mount this once at the top of /inbox.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { eventBus, type EventEnvelope } from "@/lib/events";
import type { OFChatItem, OFMessage } from "@/lib/relay";

interface ChatMessagePayload {
  id: number;
  text?: string;
  fromUser?: { id: number; name?: string; username?: string; avatar?: string };
  createdAt?: string;
  mediaCount?: number;
  media?: OFMessage["media"];
  price?: number;
  isFree?: boolean;
  isTip?: boolean;
  isOpened?: boolean;
}

// SSE envelope shape: { api2_chat_message: {...payload}, __account_id, ... }.
// The OF event type is the top-level key holding the actual message body —
// NOT a flat `message` field. We had this wrong, which is why incoming
// messages weren't updating the inbox without a manual refresh.
interface ChatMessageEvent {
  api2_chat_message?: ChatMessagePayload;
  __account_id?: string;
}

export function useInboxRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    const offMsg = eventBus.on("api2_chat_message", (env: EventEnvelope) => {
      const e = env as unknown as ChatMessageEvent;
      const accountId = e.__account_id ?? null;
      const msg = e.api2_chat_message ?? null;
      const fromUser = msg?.fromUser ?? null;
      if (!accountId || !msg || !fromUser) return;

      // direction inference: fromUser.id === accountId (numeric match) → outgoing.
      // OF doesn't include the recipient in api2_chat_message, so for outgoing
      // events we can't tell which chat to bump. Skip — local sends already
      // patched the cache optimistically; sends from another device get
      // reconciled by the 60s refetchInterval on useChatList.
      const fanId = Number(fromUser.id);
      if (!Number.isFinite(fanId)) return;
      if (String(fanId) === accountId) return;

      const candidate: OFMessage = {
        id: msg.id,
        text: msg.text ?? "",
        fromUser: { id: Number(fromUser.id), name: fromUser.name ?? fromUser.username ?? "" },
        createdAt: msg.createdAt ?? new Date().toISOString(),
        media: msg.media ?? [],
        mediaCount: msg.mediaCount ?? 0,
        price: msg.price ?? 0,
      };

      // Append to messages cache (de-dup by id).
      qc.setQueryData<OFMessage[]>(["messages", accountId, fanId], (prev = []) => {
        const incoming = String(candidate.id);
        if (prev.some((m) => String(m.id) === incoming)) return prev;
        return [...prev, candidate];
      });

      // Move the matching row to the top of page 0 — matches legacy /ui
      // behavior (incoming message bubbles to the top, unread badge bumps).
      // The InfiniteData cache is shaped { pages: [{ rows, hasMore }], pageParams }.
      // Strategy: pluck the row from whatever page it's on, update it,
      // prepend to page 0. useChatList's flatten step dedupes by
      // (accountId, fanId) so any stale copy on a later page is ignored.
      type Page = { rows: OFChatItem[]; hasMore: boolean };
      type Infinite = { pages: Page[]; pageParams: unknown[] };
      qc.getQueryCache().findAll({ queryKey: ["chats"] }).forEach((q) => {
        const data = q.state.data as Infinite | undefined;
        if (!data?.pages?.length) return;

        let existing: OFChatItem | null = null;
        const stripped: Page[] = data.pages.map((p) => ({
          ...p,
          rows: p.rows.filter((c) => {
            if ((c.__accountId ?? "") !== accountId) return true;
            if (c.withUser.id !== fanId) return true;
            existing = c;
            return false;
          }),
        }));

        const base: OFChatItem = existing ?? ({
          __accountId: accountId,
          withUser: { id: fanId, name: fromUser.name ?? fromUser.username ?? "" },
        } as OFChatItem);
        const updatedRow: OFChatItem = {
          ...base,
          hasUnread: true,
          unreadMessagesCount: (base.unreadMessagesCount ?? 0) + 1,
          lastMessage: {
            id: candidate.id as number,
            text: candidate.text,
            createdAt: candidate.createdAt,
            mediaCount: candidate.mediaCount ?? 0,
            fromUser: candidate.fromUser,
          },
        };

        const [first, ...rest] = stripped;
        const newPages: Page[] = [
          { ...first, rows: [updatedRow, ...first.rows] },
          ...rest,
        ];
        qc.setQueryData(q.queryKey, { ...data, pages: newPages });
      });
    });

    // Note: we used to invalidate ["chats"] on every "chat_messages" event,
    // but with useInfiniteQuery that refetches *every* loaded page — after a
    // few "load more" clicks that becomes 40+ pages per OF preview event.
    // The api2_chat_message handler above already patches rows in place
    // (preview, unread flag), and the 60s refetchInterval on useChatList
    // covers anything that slipped through.

    return () => { offMsg(); };
  }, [qc]);
}
