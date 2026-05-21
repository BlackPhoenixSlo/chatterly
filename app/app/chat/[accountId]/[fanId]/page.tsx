"use client";

/**
 * /chat/[accountId]/[fanId] — one-fan window. Opened from the inbox via the
 * "↗ open in new tab" button so a chatter can keep two conversations side
 * by side on a wide monitor (or pop one out onto a second display).
 *
 * Renders just the ChatSurface — no chat list, no nav distractions. The
 * chat object is synthesized from a /users/list lookup since this page is
 * reachable directly via URL and can't rely on the inbox cache being
 * populated.
 */

import { useQuery } from "@tanstack/react-query";
import { use, useMemo } from "react";
import Link from "next/link";

import { ChatSurface } from "@/components/chat/ChatSurface";
import { relay, type OFChatItem, type OFUserMini } from "@/lib/relay";

interface UserListResp { [id: string]: OFUserMini & {
  avatarThumbs?: { c50?: string; c144?: string };
} }

export default function ChatPopoutPage({
  params,
}: { params: Promise<{ accountId: string; fanId: string }> }) {
  const { accountId, fanId: fanIdStr } = use(params);
  const fanId = Number(fanIdStr);

  // Fetch the fan profile so the header shows a name/avatar instead of
  // "fan 12345". Falls back gracefully if /users/list fails.
  const userQ = useQuery<OFUserMini | null>({
    queryKey: ["of-user", accountId, fanId],
    queryFn: async () => {
      const resp = await relay.get<UserListResp>(
        `/api/of/v2/users/list?ids=${fanId}&view=m`,
        { accountId },
      );
      const u = resp?.[String(fanId)];
      if (!u) return null;
      return {
        id: fanId,
        name: u.name,
        username: u.username,
        avatar: u.avatarThumbs?.c50 || u.avatarThumbs?.c144 || u.avatar || null,
        customNickname: u.customNickname ?? null,
      };
    },
    enabled: Number.isFinite(fanId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (!Number.isFinite(fanId)) {
    return (
      <div className="grid place-items-center h-[calc(100vh-3.5rem)] text-sm text-err">
        Invalid fan id: {fanIdStr}
      </div>
    );
  }

  // Synthesize the minimum OFChatItem the surface needs. canSendMessage
  // defaults to true; if OF actually blocks the chat the Composer will
  // surface the 400 reason on first send. Acceptable tradeoff for a popout.
  // Memoize so we don't hand ChatSurface a new object reference on every
  // render — its useMemo/useEffect deps that read off `chat` would otherwise
  // recompute on every parent re-render.
  const chat: OFChatItem = useMemo(() => ({
    withUser: {
      id: fanId,
      name: userQ.data?.name,
      username: userQ.data?.username,
      avatar: userQ.data?.avatar ?? null,
      customNickname: userQ.data?.customNickname ?? null,
    },
    __accountId: accountId,
    hasUnread: false,
  }), [accountId, fanId, userQ.data?.name, userQ.data?.username, userQ.data?.avatar, userQ.data?.customNickname]);

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      <div className="border-b border-border px-3 py-1 text-[11px] text-fg-dim flex items-center gap-3 bg-bg-elev-1/40">
        <Link href="/inbox" className="hover:text-fg underline underline-offset-2">
          ← Back to inbox
        </Link>
        <span className="opacity-60">popout · acct {accountId} · fan {fanId}</span>
      </div>
      <div className="flex-1 min-h-0">
        <ChatSurface
          accountId={accountId}
          fanId={fanId}
          chat={chat}
          forceDrawerOpen
          forcePinnedPanelOpen
        />
      </div>
    </div>
  );
}
