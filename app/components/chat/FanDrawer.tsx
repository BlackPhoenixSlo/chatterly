"use client";

/**
 * FanDrawer — slide-over panel on the right edge of the chat surface.
 *
 * Opens when the user clicks the chat header. Renders the fan's identity
 * (display name, username, avatar) on top, then editable fields:
 *   • Custom nickname  — what our team calls them ("the German guy")
 *   • Notes            — free-form per-team memory
 *   • Tags             — comma-separated chips
 *
 * Lifetime spend + activity timestamps sit at the bottom (read-only;
 * computed from transactions/messages tables).
 *
 * Save: every field saves on blur (notes/nickname) or chip-edit (tags).
 * The mutation patches the cache directly so the panel feels instant.
 */

import { useEffect, useMemo, useState } from "react";

import { useFan } from "@/hooks/useFan";
import { useOFUser } from "@/hooks/useOFUser";
import { useFanActivity } from "@/hooks/useLastPurchases";
import type { OFChatItem } from "@/lib/relay";
import { cn, fmtRelTime, interpretSubStatus } from "@/lib/utils";

export function FanDrawer({
  open, onClose, accountId, fanId, chat, pinned = false, alwaysOn = false,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  fanId: number;
  chat: OFChatItem;
  /** When true, render as an in-flow side column (no backdrop, no
   *  click-out close). Used when the "keep drawer open" flag is on
   *  so the inbox becomes a 3-column layout. */
  pinned?: boolean;
  /** When true (only meaningful in pinned mode), hide the close X
   *  entirely. The popout window uses this so the fan info is always
   *  visible — closing it would defeat the point of the popout. */
  alwaysOn?: boolean;
}) {
  const { data: fan, isLoading, update } = useFan(accountId, fanId);
  const ofUserQ = useOFUser(accountId, fanId);
  // Wrapped in a stable single-element array so the underlying useQueries
  // sees the same identity unless accountId actually changes.
  const lastPurchaseAccountIds = useMemo(() => [accountId], [accountId]);
  const activity = useFanActivity(lastPurchaseAccountIds);
  const lastPurchase = activity.lastPurchase.get(`${accountId}:${fanId}`) ?? null;
  const recentSpend = activity.recentSpend.get(`${accountId}:${fanId}`) ?? 0;

  // Local form mirrors so blur-save doesn't fight the cache when the user
  // is mid-edit. Reset whenever the underlying fan row changes.
  const [nickname, setNickname] = useState("");
  const [notes, setNotes] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  useEffect(() => {
    if (!fan) return;
    setNickname(fan.custom_nickname ?? "");
    setNotes(fan.notes ?? "");
    setTagsInput((fan.tags ?? []).join(", "));
  }, [fan]);

  // Esc closes the OVERLAY drawer only; in pinned mode it's a real
  // sibling column, so Esc shouldn't kill it.
  useEffect(() => {
    if (!open || pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, pinned]);

  if (!open) return null;

  const displayName =
    fan?.custom_nickname ||
    chat.withUser.name ||
    fan?.of_display_name ||
    chat.withUser.username ||
    `fan ${fanId}`;

  const avatar = chat.withUser.avatar || fan?.avatar_url || null;

  // Shared panel body. In overlay mode we wrap it in an absolute-positioned
  // backdrop layer; in pinned mode the parent inbox layout slots it next to
  // the chat column as a normal sibling.
  const panel = (
    <aside
      className={
        pinned
          ? "w-[360px] shrink-0 bg-panel border-l border-border flex flex-col h-full"
          : "w-[360px] bg-panel border-l border-border shadow-2xl pointer-events-auto flex flex-col"
      }
    >
        <header className="border-b border-border p-4 flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-bg-elev-1 overflow-hidden shrink-0 grid place-items-center">
            {avatar ? (
              <img
                src={avatar}
                alt=""
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-base">
                {displayName.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate">{displayName}</div>
            <div className="text-[11px] text-fg-dim truncate">
              @{chat.withUser.username || fan?.of_username || fanId}
            </div>
            <div className="text-[10px] text-fg-dim mt-0.5">
              acct {accountId} · id {fanId}
            </div>
          </div>
          {!alwaysOn && (
            <button
              type="button"
              onClick={onClose}
              className="text-fg-dim hover:text-fg text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          )}
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {isLoading && (
            <div className="text-xs text-fg-dim">Loading fan profile…</div>
          )}

          {fan && (
            <>
              <Field label="Custom nickname" hint="What our team calls them. Overrides OF's display name everywhere.">
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  onBlur={() => {
                    if (nickname.trim() === (fan.custom_nickname ?? "")) return;
                    update.mutate({ custom_nickname: nickname.trim() || null });
                  }}
                  placeholder={fan.of_display_name ?? ""}
                  className="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
                />
              </Field>

              <Field label="Notes" hint="Free-form. Anything Grok should know later goes here.">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => {
                    if (notes === (fan.notes ?? "")) return;
                    update.mutate({ notes: notes || null });
                  }}
                  rows={4}
                  placeholder="loves bondage, German, paid $500 last week…"
                  className="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent resize-y"
                />
              </Field>

              <Field label="Tags" hint="Comma-separated. Saves on blur.">
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  onBlur={() => {
                    const next = tagsInput
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean);
                    const prev = fan.tags ?? [];
                    if (sameList(next, prev)) return;
                    update.mutate({ tags: next });
                  }}
                  placeholder="whale, EU, kink:feet"
                  className="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
                />
                {fan.tags?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {fan.tags.map((t) => (
                      <span key={t} className="text-[10px] bg-bg-elev-1 border border-border rounded-full px-2 py-0.5">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </Field>

              {/* Live numbers pulled from OF's /users/{id}.subscribedOnData,
               *  same path the desktop app uses. Falls back to our DB copy
               *  while the OF call is in flight or errors. */}
              {(() => {
                const sub = ofUserQ.data?.subscribedOnData;
                const liveSpend = typeof sub?.totalSumm === "number"
                  ? Math.round(sub.totalSumm * 100)
                  : null;
                // Prefer OF's authoritative totalSumm, fall back to the
                // transactions-derived windowed sum if it briefly reports 0
                // while our DB copy is also empty.
                const spendCents = Math.max(
                  liveSpend ?? 0,
                  recentSpend,
                  fan.lifetime_spend_cents || 0,
                );
                const status = interpretSubStatus(
                  sub?.status ?? fan.subscription_status,
                  sub?.expiredAt ?? null,
                );
                return (
                  <div className="border-t border-border pt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                    <Stat label="Lifetime spend" value={fmtUsd(spendCents)} />
                    <Stat label="Sub status" value={status.short} tone={status.tone} />
                    <Stat
                      label="Sub price"
                      value={typeof sub?.price === "number" ? `$${sub.price.toFixed(2)}` : "—"}
                    />
                    <Stat
                      label="Subscribed at"
                      value={fmtRelTime(sub?.subscribeAt ?? fan.subscribed_at)}
                    />
                    <Stat label="Renewed at" value={fmtRelTime(sub?.renewedAt ?? null)} />
                    <Stat
                      label={status.expired ? "Expired" : "Expires"}
                      value={fmtRelTime(sub?.expiredAt ?? null)}
                    />
                    <Stat
                      label="Tips"
                      value={typeof sub?.tipsSumm === "number" ? `$${sub.tipsSumm.toFixed(0)}` : "—"}
                    />
                    <Stat
                      label="Messages"
                      value={typeof sub?.messagesSumm === "number" ? `$${sub.messagesSumm.toFixed(0)}` : "—"}
                    />
                    <Stat
                      label="Posts"
                      value={typeof sub?.postsSumm === "number" ? `$${sub.postsSumm.toFixed(0)}` : "—"}
                    />
                    <Stat
                      label="Streams"
                      value={typeof sub?.streamsSumm === "number" ? `$${sub.streamsSumm.toFixed(0)}` : "—"}
                    />
                    <Stat label="Last purchase" value={fmtRelTime(lastPurchase)} />
                    <Stat label="Last message in" value={fmtRelTime(fan.last_message_received_at)} />
                    <Stat label="Last seen" value={fmtRelTime(ofUserQ.data?.lastSeen as string | null)} />
                  </div>
                );
              })()}

              {update.error && (
                <div className="text-err text-xs">
                  {(update.error as Error).message || "save failed"}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
  );

  if (pinned) return panel;
  return (
    <div className="absolute inset-0 z-30 flex pointer-events-none">
      <div className="flex-1 bg-black/40 pointer-events-auto" onClick={onClose} />
      {panel}
    </div>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label className="text-[11px] font-medium text-fg-dim uppercase tracking-wide">{label}</label>
      </div>
      {children}
      {hint && <div className="text-[10px] text-fg-dim">{hint}</div>}
    </div>
  );
}

function Stat({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "err" | "fg-dim";
}) {
  const toneClass =
    tone === "ok" ? "text-ok"
    : tone === "warn" ? "text-warn"
    : tone === "err" ? "text-err"
    : tone === "fg-dim" ? "text-fg-dim"
    : "text-fg";
  return (
    <div>
      <div className="text-fg-dim">{label}</div>
      <div className={`${toneClass} font-medium`}>{value}</div>
    </div>
  );
}

function fmtUsd(cents: number | null | undefined): string {
  if (!cents) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const A = a.slice().sort();
  const B = b.slice().sort();
  return A.every((v, i) => v === B[i]);
}

const _cn = cn; void _cn; // ensure module is type-checked if we add cn later
