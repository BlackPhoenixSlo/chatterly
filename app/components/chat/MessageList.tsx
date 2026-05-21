"use client";

/**
 * MessageList — the message-history pane.
 *
 * Renders the OFMessage[] for one chat. Owns:
 *   • Scroll-only-if-at-bottom (snapshot scroll position before merge,
 *     restore if user was at the bottom OR initial load).
 *   • Load-older button at the top.
 *   • Per-message visual states: pending (faded), failed (red border +
 *     Retry button).
 *
 * Direction inference: `fromUser.id === ownerUserId` → outgoing (right-
 * aligned, accent bubble). Anything else → incoming (left-aligned).
 *
 * Empty/loading states pulled into the same component so the parent
 * doesn't have to switch.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { proxyImage, type OFMessage } from "@/lib/relay";
import { cn } from "@/lib/utils";
import { blurImageClass, useBlurMode } from "@/hooks/useBlurMode";
import { MediaTile, pickEagerMediaIds } from "@/components/chat/MediaTile";


export interface MessageListProps {
  messages: OFMessage[];
  ownerUserId: number | null;  // the model account's OF user id
  accountId: string | null;    // for routing CDN urls through /img proxy
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (tempId: number) => void;
  /** Cancel a local-wait scheduled send. Bubbles only render the cancel
   *  button when this is provided. */
  onCancelScheduled?: (tempId: number) => void;
  /** Double-click toggle for likes on incoming messages. Optional so
   *  read-only contexts (history search, etc.) can render the same list. */
  onToggleLike?: (msg: OFMessage) => void;
  /** Click "reply" on a bubble's hover toolbar. Parent stores the quoted
   *  context and renders it above the composer. */
  onQuoteReply?: (msg: OFMessage) => void;
  /** Click "📌 pin" / "📌 unpin" on a bubble's hover toolbar. Flips the
   *  pinned state on OF; parent owns the optimistic patch via the hook. */
  onTogglePin?: (msg: OFMessage) => void;
  /** Highlight a single message id (used by the search results panel
   *  click-to-jump). The bubble gets a transient ring + scrolls into view. */
  highlightId?: number | string | null;
  /** The OF chat's `lastReadMessageId` — the highest message id the fan
   *  has marked read. Drives the ✓✓ seen indicator on outgoing bubbles. */
  lastReadByPeerId?: number | null;
}

const AT_BOTTOM_PX = 80;

export function MessageList(props: MessageListProps) {
  const {
    messages, ownerUserId, accountId, isLoading, isError, error,
    hasOlder, loadingOlder, onLoadOlder, onRetry, onCancelScheduled,
    onToggleLike, onQuoteReply, onTogglePin, highlightId, lastReadByPeerId,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const lastLenRef = useRef(0);
  // True until the first non-empty message render has been pinned to the
  // bottom. Without this, the IntersectionObserver below fires the
  // moment the top sentinel becomes visible during the initial render
  // (when scrollTop is still 0), which yanks the view back to old
  // messages instead of letting the user see the newest ones.
  const firstLoadPendingRef = useRef(true);
  // Snapshot pre-render scrollHeight + scrollTop so a load-older insert
  // (which pushes content down) can keep the user's eye anchored on the
  // same message instead of jumping back to the bottom.
  const preMergeScrollRef = useRef<{ height: number; top: number } | null>(null);

  // Capture scroll position BEFORE the next render commit.
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    wasAtBottomRef.current =
      c.scrollHeight - c.scrollTop - c.clientHeight < AT_BOTTOM_PX;
    preMergeScrollRef.current = { height: c.scrollHeight, top: c.scrollTop };
  });

  // After render: decide between "stick to bottom" (initial / new message)
  // and "preserve anchor" (older page loaded at top).
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const initial = lastLenRef.current === 0 && messages.length > 0;
    const grew = messages.length > lastLenRef.current && !initial;
    if (initial) {
      // Initial paint: hard-pin to the bottom. Run again next frame +
      // 100ms later to defeat lazy image layout that grows the
      // container after the first scrollTop write.
      const pinBottom = () => { c.scrollTop = c.scrollHeight; };
      pinBottom();
      requestAnimationFrame(pinBottom);
      const t = setTimeout(() => {
        pinBottom();
        firstLoadPendingRef.current = false;
      }, 150);
      lastLenRef.current = messages.length;
      return () => clearTimeout(t);
    }
    if (wasAtBottomRef.current) {
      c.scrollTop = c.scrollHeight;
    } else if (grew && preMergeScrollRef.current) {
      // Older page came in at the top — adjust scrollTop by the height
      // delta so the previously-visible message stays in view.
      const delta = c.scrollHeight - preMergeScrollRef.current.height;
      if (delta > 0) c.scrollTop = preMergeScrollRef.current.top + delta;
    }
    lastLenRef.current = messages.length;
  }, [messages]);

  // Auto-load older when the top sentinel scrolls into view. Same pattern
  // as ChatList's infinite scroll, just inverted (top instead of bottom).
  //
  // Crucially we ignore intersections while `firstLoadPendingRef` is true
  // — on initial render the container is empty so the sentinel is
  // trivially visible, and without this gate the very first paint would
  // immediately fire loadOlder and yank the user away from the newest
  // messages before they could see them.
  useEffect(() => {
    const el = topSentinelRef.current;
    if (!el || !hasOlder) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (firstLoadPendingRef.current) return;
        if (entries.some((e) => e.isIntersecting) && hasOlder && !loadingOlder) {
          onLoadOlder();
        }
      },
      { root: containerRef.current, rootMargin: "200px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasOlder, loadingOlder, onLoadOlder]);

  // Eager-set: the two media tiles (most recent inbound + most recent
  // outbound) that fetch immediately on chat open. Everything else
  // lazy-loads via the per-tile IntersectionObserver. Recomputes only
  // when the messages array changes — the set is tiny so the downstream
  // .has() lookups in MediaStrip are O(1).
  const eagerMediaIds = useMemo(
    () => pickEagerMediaIds(messages, ownerUserId),
    [messages, ownerUserId],
  );

  // Empty / loading / error placeholders share the SAME flex sizing as
  // the populated branch below — without `flex-1 min-h-0` the column
  // collapses to the placeholder's natural height and the Composer
  // floats up into the middle of the pane until messages arrive.
  if (isLoading && messages.length === 0) {
    return (
      <div className="flex-1 min-h-0 grid place-items-center p-8 text-center text-sm text-fg-dim">
        Loading messages…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex-1 min-h-0 grid place-items-center p-8 text-center text-sm text-err">
        Failed to load: {error?.message || "unknown"}
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="flex-1 min-h-0 grid place-items-center p-8 text-center text-sm text-fg-dim">
        No messages yet.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-2"
    >
      {/* Sentinel for IntersectionObserver auto-load + an explicit
       *  click-to-load button. Scroll-up alone isn't enough when the
       *  visible page is short (a chat with only a few recent messages
       *  doesn't produce a scrollbar, so the IO never fires); the button
       *  gives an unconditional way to pull older history. */}
      <div ref={topSentinelRef} className="h-1" />
      {hasOlder ? (
        <div className="flex justify-center py-2">
          <button
            type="button"
            onClick={() => { if (!loadingOlder) onLoadOlder(); }}
            disabled={loadingOlder}
            className={cn(
              "text-[11px] px-3 py-1 rounded-full border border-border bg-bg-elev-1/40",
              "text-fg-dim hover:text-fg hover:bg-bg-elev-1 transition-colors",
              loadingOlder && "opacity-60 cursor-wait",
            )}
            title="Load older messages"
          >
            {loadingOlder ? "Loading older…" : "↑ Load older messages"}
          </button>
        </div>
      ) : messages.length > 0 ? (
        <div className="text-center py-2 text-[11px] text-fg-dim italic">
          Start of conversation.
        </div>
      ) : null}
      {messages.map((m, _i, all) => {
        const isOutgoing = ownerUserId != null && m.fromUser?.id === ownerUserId;
        const isOptimisticOutgoing = (m._tempId ?? 0) < 0;
        // Resolve the quoted message. OF sometimes only sends the id; fall
        // back to a cache walk in that case. Skipping the search when
        // `replyToMessage` is already populated keeps the common path cheap.
        let replyTo = m.replyToMessage ?? null;
        if (!replyTo && m.replyToMessageId) {
          const found = all.find((x) => Number(x.id) === m.replyToMessageId);
          if (found) {
            replyTo = {
              id: Number(found.id),
              text: found.text,
              fromUser: found.fromUser,
              createdAt: found.createdAt,
              mediaCount: found.mediaCount,
            };
          }
        }
        // ✓✓ seen logic: only outgoing real-server messages with an id ≤ the
        // peer's lastRead pointer count as read. Optimistic ids (≤0) and
        // future-scheduled bubbles don't get a tick — they're not on OF yet.
        const numericId = typeof m.id === "number" ? m.id : Number(m.id);
        const isRealOutgoing = isOutgoing && Number.isFinite(numericId) && numericId > 0;
        const seenByPeer =
          isRealOutgoing && lastReadByPeerId != null && numericId <= lastReadByPeerId;
        return (
          <Bubble
            key={String(m.id)}
            msg={m}
            replyTo={replyTo}
            isOutgoing={isOutgoing}
            isOptimisticOutgoing={isOptimisticOutgoing}
            accountId={accountId}
            ownerUserId={ownerUserId}
            onRetry={onRetry}
            onCancelScheduled={onCancelScheduled}
            onToggleLike={onToggleLike}
            onQuoteReply={onQuoteReply}
            onTogglePin={onTogglePin}
            onJumpTo={(id) => {
              // Tapping the quote card scrolls to the original. Same logic
              // as search-result click: set highlightId via the existing
              // jump path — but since Bubble lives inside MessageList, we
              // simulate it by dispatching a click via DOM scrollIntoView.
              const el = containerRef.current?.querySelector(
                `[data-msg-id="${CSS.escape(String(id))}"]`,
              ) as HTMLElement | null;
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            highlighted={highlightId != null && String(highlightId) === String(m.id)}
            isRealOutgoing={isRealOutgoing}
            seenByPeer={seenByPeer}
            eagerMediaIds={eagerMediaIds}
          />
        );
      })}
    </div>
  );
}

function Bubble({
  msg, replyTo, isOutgoing, isOptimisticOutgoing, accountId, ownerUserId,
  onRetry, onCancelScheduled,
  onToggleLike, onQuoteReply, onTogglePin, onJumpTo,
  highlighted, isRealOutgoing, seenByPeer,
  eagerMediaIds,
}: {
  msg: OFMessage;
  replyTo: OFMessage["replyToMessage"] | null;
  isOutgoing: boolean;
  isOptimisticOutgoing: boolean;
  accountId: string | null;
  ownerUserId: number | null;
  onRetry: (tempId: number) => void;
  onCancelScheduled?: (tempId: number) => void;
  onToggleLike?: (msg: OFMessage) => void;
  onQuoteReply?: (msg: OFMessage) => void;
  onTogglePin?: (msg: OFMessage) => void;
  onJumpTo?: (messageId: number) => void;
  highlighted?: boolean;
  isRealOutgoing?: boolean;
  seenByPeer?: boolean;
  eagerMediaIds: Set<number>;
}) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  // Scroll into view when search picks this bubble. Defer to next tick so
  // the container's own scroll-restore effect doesn't fight us for the
  // scrollTop slot.
  useEffect(() => {
    if (!highlighted) return;
    const id = setTimeout(() => {
      bubbleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    return () => clearTimeout(id);
  }, [highlighted]);

  // Optimistic messages can't yet have a real fromUser.id matching
  // ownerUserId — treat tempId<0 as "I sent this".
  const side = isOutgoing || isOptimisticOutgoing ? "right" : "left";
  const failed = !!msg._failed;
  const pending = !!msg._pending && !failed;
  const scheduled = !!msg._isFutureScheduled;
  // OF only lets you like the OTHER party's messages. Hide the affordance
  // on outgoing bubbles even though `isLiked` may still appear there (if
  // the fan reacted to our message).
  const canLike = !!onToggleLike && !isOutgoing && !isOptimisticOutgoing && !scheduled;
  const canReply = !!onQuoteReply && !scheduled && !failed && !pending;
  // Pin works on both directions (unlike `like`, which is incoming-only).
  // Optimistic / failed / scheduled bubbles can't be pinned — they have
  // no real OF message id yet.
  const numericIdForPin = typeof msg.id === "number" ? msg.id : Number(msg.id);
  const canPin = !!onTogglePin && !scheduled && !failed && !pending
    && Number.isFinite(numericIdForPin) && numericIdForPin > 0;

  function onBubbleDoubleClick() {
    if (!canLike) return;
    onToggleLike!(msg);
  }

  // PPV: any positive price + isFree=false means this bubble was sold.
  // OF reports `isOpened=true` once the fan has paid. We render the
  // price tag + lock-state for both sides — outbound so the chatter
  // can see what they sent, inbound (rare; only on tip-back) for parity.
  const isPPV = !!msg.price && msg.price > 0;
  const unlocked = isPPV && !!msg.isOpened;
  // Outgoing PPV: we (the sender) own the content, so show thumbnails
  // even when the fan hasn't paid. Only incoming locked PPV shows the 🔒 tile.
  const locked = isPPV && !unlocked && !(isOutgoing || isOptimisticOutgoing);

  return (
    <div
      ref={bubbleRef}
      className={cn(
        "flex group",
        side === "right" ? "justify-end" : "justify-start",
        highlighted && "rounded-md ring-2 ring-info/60 transition-shadow",
      )}
    >
      <div className="max-w-[75%] flex flex-col gap-1 relative">
        {/* Hover toolbar — sits above the bubble. Only shows when the
         *  message is in a state where actions make sense. */}
        {(canReply || canLike || canPin) && (
          <div
            className={cn(
              "absolute -top-7 opacity-0 group-hover:opacity-100 transition-opacity",
              "flex items-center gap-1 bg-panel border border-border rounded-md shadow-sm px-1 py-0.5 z-10",
              side === "right" ? "right-1" : "left-1",
            )}
          >
            {canReply && (
              <button
                type="button"
                onClick={() => onQuoteReply!(msg)}
                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-bg-elev-1 text-fg-dim hover:text-fg"
                title="Quote-reply"
              >
                ↩ reply
              </button>
            )}
            {canLike && (
              <button
                type="button"
                onClick={() => onToggleLike!(msg)}
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded hover:bg-bg-elev-1",
                  msg.isLiked ? "text-err" : "text-fg-dim hover:text-fg",
                )}
                title={msg.isLiked ? "Unlike" : "Like (or double-click bubble)"}
              >
                {msg.isLiked ? "♥" : "♡"} like
              </button>
            )}
            {canPin && (
              <button
                type="button"
                onClick={() => onTogglePin!(msg)}
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded hover:bg-bg-elev-1",
                  msg.isPinned ? "text-accent" : "text-fg-dim hover:text-fg",
                )}
                title={msg.isPinned ? "Unpin from chat" : "Pin to chat"}
              >
                {msg.isPinned ? "📌 pinned" : "📌 pin"}
              </button>
            )}
          </div>
        )}
        {isPPV && (
          <div
            className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded-md inline-flex items-center gap-1 self-start",
              side === "right" ? "self-end" : "self-start",
              unlocked
                ? "bg-ok/15 text-ok border border-ok/30"
                : "bg-warn/15 text-warn border border-warn/30",
            )}
          >
            <span aria-hidden>{unlocked ? "✓" : "🔒"}</span>
            <span>${msg.price!.toFixed(2)}</span>
            <span className="opacity-70">{unlocked ? "unlocked" : "locked"}</span>
          </div>
        )}
        <div
          onDoubleClick={onBubbleDoubleClick}
          data-msg-id={String(msg.id)}
          className={cn(
            "relative rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
            side === "right"
              ? "bg-accent text-white rounded-br-md"
              : "bg-bg-elev-1 text-fg rounded-bl-md",
            failed && "ring-1 ring-err/60",
            pending && !scheduled && "opacity-70",
            // Local-wait scheduled bubble: dashed outline + faded fill so
            // it's visually obvious this hasn't actually been sent yet.
            scheduled && side === "right" &&
              "!bg-accent/10 !text-accent border-2 border-dashed border-accent/50",
            canLike && "cursor-default select-text",
          )}
        >
          {replyTo && (
            <QuoteCard
              replyTo={replyTo}
              side={side}
              ownerUserId={ownerUserId}
              onClick={() => onJumpTo?.(replyTo.id)}
            />
          )}
          {msg.text && <span>{stripHtml(msg.text)}</span>}
          {msg.media?.length ? <MediaStrip msg={msg} locked={locked} accountId={accountId} eagerMediaIds={eagerMediaIds} /> : null}
          {/* Heart sticker — anchored to the bubble's bottom-corner so the
           *  read state stays attached to the message it belongs to. */}
          {msg.isLiked && (
            <span
              className={cn(
                "absolute -bottom-2 text-[13px] leading-none",
                side === "right" ? "-left-1" : "-right-1",
              )}
              title="Liked"
              aria-label="Liked"
            >
              <span className="inline-grid place-items-center w-4 h-4 rounded-full bg-panel border border-border text-err">
                ♥
              </span>
            </span>
          )}
          {/* Pin sticker — top corner mirror of the heart. Tells the
           *  chatter at a glance which messages are pinned without
           *  having to open the pinned popover. */}
          {msg.isPinned && (
            <span
              className={cn(
                "absolute -top-2 text-[11px] leading-none",
                side === "right" ? "-left-1" : "-right-1",
              )}
              title="Pinned to chat"
              aria-label="Pinned"
            >
              <span className="inline-grid place-items-center w-4 h-4 rounded-full bg-panel border border-border text-accent">
                📌
              </span>
            </span>
          )}
        </div>
        <div className="text-[10px] text-fg-dim px-1 flex items-center gap-1.5 flex-wrap">
          {scheduled
            ? <ScheduledStatus fireAt={msg._fireAt ?? msg.createdAt} />
            : <span>{fmtTime(msg.createdAt)}</span>}
          {/* Delivered / seen receipts on outgoing real-server messages.
           *  We can only assert "delivered" once OF has assigned a real
           *  id (so pending/failed bubbles get nothing). Seen comes from
           *  the chat-list's lastReadMessageId, surfaced by the parent. */}
          {isRealOutgoing && !pending && !failed && (
            <span
              className={cn(seenByPeer ? "text-info" : "text-fg-dim")}
              title={seenByPeer ? "Seen by recipient" : "Delivered"}
            >
              {seenByPeer ? "✓✓ seen" : "✓ delivered"}
            </span>
          )}
          {pending && !scheduled && <span className="text-warn">sending…</span>}
          {scheduled && onCancelScheduled && msg._tempId != null && (
            <button
              type="button"
              onClick={() => msg._tempId != null && onCancelScheduled(msg._tempId)}
              className="text-err hover:underline"
              title="Cancel the pending send. Local-wait only — tab close cancels it too."
            >
              cancel
            </button>
          )}
          {failed && (
            <>
              <button
                type="button"
                onClick={() => msg._tempId != null && onRetry(msg._tempId)}
                className="text-err hover:underline"
              >
                failed — retry
              </button>
              {msg._failedReason && (
                <span className="text-err/80" title={msg._failedReason}>
                  · {truncate(msg._failedReason, 80)}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MediaStrip({ msg, locked, accountId, eagerMediaIds }: {
  msg: OFMessage;
  locked: boolean;
  accountId: string | null;
  eagerMediaIds: Set<number>;
}) {
  const items = msg.media ?? [];
  const [blurMode] = useBlurMode();
  const blurCls = blurImageClass(blurMode);
  // PPV gifts can attach 40+ items; rendering them all blows up the bubble
  // and floods the relay /img proxy. Cap at:
  //   • 2 tiles when the message is still locked (the lock icon repeats —
  //     beyond 2 it's pure noise)
  //   • 3 tiles for visible thumbnails (a clean 3-up row in the bubble)
  // The user expands to see the rest via the "+N more" pill.
  const LOCKED_CAP = 2;
  const IMAGE_CAP = 3;
  const cap = locked ? LOCKED_CAP : IMAGE_CAP;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, cap);
  const hiddenCount = items.length - visible.length;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      {visible.map((m, i) => {
        const rawThumb = m.files?.thumb?.url || m.files?.source?.url || m.url || null;
        const thumb = proxyImage(rawThumb, accountId);
        const fullRaw = m.files?.source?.url || rawThumb;
        const full = proxyImage(fullRaw, accountId);
        if (locked) {
          return (
            <div
              key={m.id ?? i}
              className="aspect-video bg-black/30 rounded-md grid place-items-center text-[11px] text-warn border border-warn/30"
            >
              🔒 locked
            </div>
          );
        }
        if (!thumb) {
          return (
            <div
              key={m.id ?? i}
              className="aspect-video bg-bg/30 rounded-md grid place-items-center text-[10px] opacity-70"
            >
              processing…
            </div>
          );
        }
        const isEager = m.id != null && eagerMediaIds.has(m.id);
        return (
          <a
            key={m.id ?? i}
            href={full || thumb}
            target="_blank"
            rel="noreferrer"
            className="block"
          >
            <MediaTile
              mediaId={m.id ?? null}
              proxiedUrl={thumb}
              fallbackUrl={rawThumb ?? ""}
              eager={isEager}
              alt=""
              className={cn(
                "w-full max-h-48 object-cover rounded-md border border-black/10",
                blurCls,
              )}
            />
          </a>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="aspect-video rounded-md border border-border bg-bg-elev-1 hover:bg-bg-elev-2 text-xs text-fg-dim flex items-center justify-center gap-1"
        >
          +{hiddenCount} more
        </button>
      )}
      {expanded && items.length > cap && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="col-span-2 mt-0.5 rounded-md border border-border bg-bg-elev-1 hover:bg-bg-elev-2 text-[11px] text-fg-dim py-1"
        >
          show less
        </button>
      )}
    </div>
  );
}

function QuoteCard({
  replyTo, side, ownerUserId, onClick,
}: {
  replyTo: NonNullable<OFMessage["replyToMessage"]>;
  side: "left" | "right";
  ownerUserId: number | null;
  onClick: () => void;
}) {
  // Decide who originated the quoted message — same direction test the
  // host bubble uses. Label "You" vs the author name so the chatter can
  // tell at a glance whether they're replying to their own send or the fan.
  const fromOwner =
    ownerUserId != null && replyTo.fromUser?.id === ownerUserId;
  const author =
    fromOwner
      ? "You"
      : replyTo.fromUser?.name || replyTo.fromUser?.username || "fan";
  const preview = replyTo.text
    ? stripHtml(replyTo.text)
    : replyTo.mediaCount
    ? `(${replyTo.mediaCount} media)`
    : "(message)";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full text-left mb-1.5 rounded-md border-l-2 pl-2 py-1 pr-2 text-[11px] leading-tight",
        side === "right"
          ? "bg-white/10 border-white/60 hover:bg-white/15"
          : "bg-black/10 border-fg/40 hover:bg-black/15",
      )}
      title="Jump to quoted message"
    >
      <div className={side === "right" ? "font-semibold text-white" : "font-semibold text-fg"}>
        {author}
      </div>
      <div className={cn("truncate", side === "right" ? "text-white/85" : "text-fg-dim")}>
        {preview || "(empty)"}
      </div>
    </button>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** OF returns message bodies as HTML — strip tags AND decode the most
 *  common entities so bubbles render as plain text without leaking
 *  `<br>` / `&amp;` artifacts. We avoid `dangerouslySetInnerHTML` so
 *  malformed input from OF can never inject markup into our chat. */
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Live countdown that re-renders every 20s. Short enough to feel
 *  responsive ("Sending in 1 min" → fires shortly after); long enough
 *  to not be wasteful across many pending bubbles in one chat. */
function ScheduledStatus({ fireAt }: { fireAt: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, []);
  const ms = new Date(fireAt).getTime() - Date.now();
  if (ms <= 0) return <span className="text-accent">⏱ sending now…</span>;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return (
    <span className="text-accent">
      ⏱ sending in {mins} min · local
    </span>
  );
}
