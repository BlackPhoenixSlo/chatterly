"use client";

/**
 * Composer — message-input + send button + emoji controls + PPV + vault.
 *
 * Send routes through the chat's owning account_id, not the global scope
 * — this is the whole point of Unified Inbox. Parent passes accountId
 * (== chat.__accountId) so this works whether scope is "all" or a single
 * model.
 *
 * Enter sends; Shift+Enter inserts a newline. Disabled while inflight to
 * prevent double-submits; the spinner is purely visual since the
 * optimistic bubble appears instantly anyway.
 *
 * PPV controls: a "$" toggle reveals a price input + lock-text checkbox.
 * On send we pass `price` and `lockedText` to the parent.
 *
 * Vault: 📎 button opens VaultPicker over the chat surface. Selected
 * media show as preview chips above the textarea; click X on a chip to
 * drop it. Their ids ride along on send as `mediaFiles`.
 */

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { proxyImage, type VaultMedia } from "@/lib/relay";
import { useVaultUpload } from "@/hooks/useVaultMedia";
import { readUploadPreset } from "@/hooks/useUploadPreset";
import { resizeImageIfNeeded } from "@/lib/imageResize";

import dynamic from "next/dynamic";

import { EmojiPickerButton, EmojiQuickRow, insertAtCursor } from "./EmojiBar";
import { TemplatePicker, templateMediaToVault, type PickedTemplate } from "./TemplatePicker";

// VaultPicker is heavy (hover-scrub state, fan-vault-history, wall-media,
// per-fan MRU localStorage). The composer mounts on every chat surface,
// but the picker only renders when the chatter clicks 📎. Dynamic +
// render-gate keeps the picker chunk off the inbox boot bundle.
const VaultPicker = dynamic(
  () => import("./VaultPicker").then((m) => m.VaultPicker),
  { ssr: false },
);

export interface SendArgs {
  text: string;
  price?: number;
  lockedText?: boolean;
  /** Vault items the sender attached. The hook extracts ids for the
   *  wire payload AND uses the file URLs to seed the optimistic bubble's
   *  media — without that, attached PPV messages render text-only. */
  attached?: VaultMedia[];
  /** ISO 8601 send-at timestamp. When set, the relay queues via the
   *  /messages/scheduled endpoint instead of sending immediately. */
  scheduledAt?: string;
}

export interface ComposerProps {
  accountId: string | null;
  /** When the composer is bound to a single fan (chat surface), passing
   *  fanId here unlocks the vault picker's per-fan badges + filter. Mass-
   *  send composers leave this null. */
  fanId?: number | null;
  onSend: (args: SendArgs) => void | Promise<void>;
  disabled?: boolean;
  inflight?: number;
  placeholder?: string;
  /** When OF reports the chat as un-sendable (e.g., unsubscribed fan),
   *  pass `canSend=false` + `cannotSendReason` so the composer disables
   *  the controls and surfaces the reason instead of letting the user
   *  burn time on a guaranteed-fail send. */
  canSend?: boolean;
  cannotSendReason?: string | null;
  /** Quoted-reply context. When set, we render a preview chip above the
   *  textarea — the parent is responsible for prepending the quote text
   *  to the actual send body so the wire shape matches OF's expectations. */
  quoted?: { messageId: number; preview: string; authorName: string } | null;
  onClearQuoted?: () => void;
}

export function Composer({
  accountId, fanId = null, onSend, disabled, inflight = 0, placeholder,
  canSend: chatCanSend = true, cannotSendReason,
  quoted, onClearQuoted,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [priceOpen, setPriceOpen] = useState(false);
  const [price, setPrice] = useState<string>("");
  const [lockText, setLockText] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attached, setAttached] = useState<VaultMedia[]>([]);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>("");
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const quickMenuRef = useRef<HTMLDivElement | null>(null);
  /** Transient confirmation after a quick-send / scheduler fires. Lets the
   *  user know the message is queued locally — the textarea clears, so
   *  without this the action looks like nothing happened. */
  const [sendToast, setSendToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const upload = useVaultUpload(accountId);

  const numericPrice = parsePrice(price);
  const hasAttachments = attached.length > 0;
  // Block send while any optimistic placeholder is still uploading.
  // Without this the user can press Send before mutateAsync resolves,
  // and the request body ships with a phantom negative id OF rejects.
  const anyUploading = attached.some((a) => a._uploading);
  const canSend =
    !disabled &&
    chatCanSend &&
    !anyUploading &&
    (text.trim().length > 0 || hasAttachments) &&
    (!priceOpen || numericPrice == null || numericPrice >= 0);
  // Surface OF's block reason at the top of the composer when sending is
  // disallowed. Saves the user from typing a message that will 400.
  const blocked = !chatCanSend;

  function showToast(msg: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setSendToast(msg);
    toastTimerRef.current = setTimeout(() => setSendToast(null), 6000);
  }

  async function submit(opts?: { delayMinutes?: number }) {
    const body = text.trim();
    if (!body && !hasAttachments) return;
    const args: SendArgs = { text: body };
    if (priceOpen && numericPrice != null && numericPrice > 0) {
      args.price = numericPrice;
      args.lockedText = lockText;
    }
    if (hasAttachments) args.attached = attached;
    // Quick-send delay (1/3/5/15) takes priority over the explicit
    // scheduler row — they're alternate UIs for the same idea.
    if (opts?.delayMinutes && opts.delayMinutes > 0) {
      args.scheduledAt = new Date(Date.now() + opts.delayMinutes * 60_000).toISOString();
    } else if (scheduleOpen && scheduleAt) {
      // datetime-local has no tz suffix. Treat the value as local-time and
      // let the Date constructor attach the user's tz when serializing.
      const d = new Date(scheduleAt);
      if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) {
        args.scheduledAt = d.toISOString();
      }
    }
    // Decide which kind of "queued" toast to show. setSendToast also
    // happens for immediate sends so it's a quiet "sent" confirmation —
    // but only when scheduled, where the textarea clears with no bubble
    // to indicate progress (local-wait shows no optimistic until fire).
    if (args.scheduledAt) {
      const fireAt = new Date(args.scheduledAt).getTime();
      const minsFromNow = Math.max(1, Math.round((fireAt - Date.now()) / 60_000));
      if (fireAt - Date.now() < 10 * 60 * 1000) {
        showToast(`⏱ Sending in ${minsFromNow} min · stored locally (reload cancels it)`);
      } else {
        showToast(`⏱ Queued on OF for ${new Date(args.scheduledAt).toLocaleString()}`);
      }
    }
    setText("");
    setPrice("");
    setPriceOpen(false);
    setAttached([]);
    setUploadErr(null);
    setScheduleOpen(false);
    setScheduleAt("");
    setQuickMenuOpen(false);
    await onSend(args);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  // Close the quick-send dropdown on outside click — same pattern as the
  // per-chat scheduled popover. Without this it sits there after picking.
  useEffect(() => {
    if (!quickMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setQuickMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [quickMenuOpen]);

  // Autofocus the textarea on mount. The Composer remounts whenever the
  // user picks a different chat (ChatSurface passes a `key` upstream),
  // so this gives them a typing cursor the same frame the chat opens —
  // no extra click needed.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) submit();
    }
  }

  function onEmoji(em: string) {
    const ta = textareaRef.current;
    if (!ta) {
      setText((t) => t + em);
      return;
    }
    insertAtCursor(ta, text, em, setText);
  }

  function onPicked(picked: VaultMedia[]) {
    // Replace selection wholesale — the picker pre-selects from
    // `attached` so any removals/adds done inside it stick on confirm.
    setAttached(picked);
  }

  function removeAttachment(id: number) {
    setAttached((prev) => prev.filter((m) => m.id !== id));
  }

  function onPickTemplate(t: PickedTemplate) {
    // Replace current text + add template's media. Setting price from
    // template would be surprising — leave the PPV toggle alone.
    setText(t.text);
    const tplMedia = templateMediaToVault(t);
    if (tplMedia.length > 0) {
      setAttached((prev) => {
        const have = new Set(prev.map((m) => m.id));
        return [...prev, ...tplMedia.filter((m) => !have.has(m.id))];
      });
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function onPickLocalFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (e.target) e.target.value = ""; // allow re-attaching same file
    if (files.length === 0) return;
    setUploadErr(null);
    // Upload sequentially — OF's signed-upload + S3 PUT + claim isn't
    // happy with parallel hammering, and we want a clean error per file.
    // We add a placeholder chip BEFORE the upload starts so the user
    // sees an instant thumbnail (blob URL) with a spinner overlay; the
    // chip is swapped for the real VaultMedia once the upload resolves.
    const preset = readUploadPreset();
    for (const rawFile of files) {
      const file = await resizeImageIfNeeded(rawFile, preset);
      const previewUrl = URL.createObjectURL(file);
      const placeholderId = -(Date.now() + Math.floor(Math.random() * 10_000));
      const placeholder: VaultMedia = {
        id: placeholderId,
        type: file.type.startsWith("video") ? "video" : "photo",
        files: null,
        _localPreview: previewUrl,
        _uploading: true,
      };
      setAttached((prev) => [...prev, placeholder]);
      try {
        const resp = await upload.mutateAsync(file);
        if (!resp.ready) {
          setUploadErr(resp.note || "Upload incomplete.");
          setAttached((prev) => prev.filter((p) => p.id !== placeholderId));
          URL.revokeObjectURL(previewUrl);
          continue;
        }
        // OF accepts EITHER numeric vault ids OR fresh-claim dicts in
        // media_files. The /ui/ legacy flow proved this works end-to-end,
        // so we push each `send_with` entry verbatim.
        const newAttachments: VaultMedia[] = (resp.send_with ?? []).map((entry, i) => {
          if (typeof entry === "number") {
            return {
              id: entry,
              type: (resp.existing?.type as VaultMedia["type"]) ||
                    (file.type.startsWith("video") ? "video" : "photo"),
              files: resp.existing?.files || null,
              _localPreview: previewUrl,
            };
          }
          // Fresh-claim dict — synthesize a negative id so React keys stay
          // stable; the wire body uses `_claim`, not `id`.
          return {
            id: -(Date.now() + i),
            type: file.type.startsWith("video") ? "video" : "photo",
            files: null,
            _claim: entry,
            _localPreview: previewUrl,
          };
        });
        setAttached((prev) => {
          const without = prev.filter((p) => p.id !== placeholderId);
          const have = new Set(without.map((p) => p.id));
          return [...without, ...newAttachments.filter((m) => !have.has(m.id))];
        });
      } catch (err) {
        setAttached((prev) => prev.filter((p) => p.id !== placeholderId));
        URL.revokeObjectURL(previewUrl);
        setUploadErr(`Upload failed: ${(err as Error).message || "unknown"}`);
      }
    }
  }

  return (
    <>
      <div
        data-composer-area
        className="border-t border-border p-3 space-y-2 bg-panel"
      >
        {blocked && (
          <div className="text-[11px] px-2.5 py-1.5 rounded-md border bg-err/10 border-err/30 text-err">
            ⚠ Sending disabled
            {cannotSendReason ? ` — ${cannotSendReason}` : " — OF blocked this chat."}
          </div>
        )}
        {quoted && (
          <div className="flex items-start gap-2 text-[11px] px-2.5 py-1.5 rounded-md border border-accent/30 bg-accent/10">
            <div className="border-l-2 border-accent/60 pl-2 flex-1 min-w-0">
              <div className="text-accent font-medium">Replying to {quoted.authorName}</div>
              <div className="text-fg-dim truncate">{quoted.preview}</div>
            </div>
            <button
              type="button"
              onClick={() => onClearQuoted?.()}
              className="text-fg-dim hover:text-fg"
              title="Cancel reply"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center justify-between">
          <EmojiQuickRow onInsert={onEmoji} disabled={disabled || blocked} />
          <span className="text-[10px] text-fg-dim">
            {inflight > 0 ? `${inflight} sending…` : "Enter to send · Shift+Enter for newline"}
          </span>
        </div>

        {scheduleOpen && (
          <div className="flex items-center gap-2 bg-bg/60 border border-border rounded-lg px-2.5 py-1.5 flex-wrap">
            <span className="text-xs text-fg-dim">Send at</span>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              min={localNowForInput()}
              className="bg-transparent border-0 px-1 py-0.5 text-sm focus:outline-none"
            />
            <div className="flex items-center gap-1">
              {[5, 10, 15, 30, 60].map((mins) => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => setScheduleAt(localFutureForInput(mins))}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border text-fg-dim hover:text-fg hover:bg-bg-elev-1"
                  title={`Send in ${mins} minutes`}
                >
                  +{mins}m
                </button>
              ))}
              {scheduleAt && (
                <button
                  type="button"
                  onClick={() => setScheduleAt("")}
                  className="text-[10px] px-1.5 py-0.5 rounded text-fg-dim hover:text-fg"
                  title="Clear"
                >
                  ✕
                </button>
              )}
            </div>
            <span className="ml-auto text-[10px] text-fg-dim">
              {scheduleAt
                ? new Date(scheduleAt) > new Date()
                  ? `${describeSchedule(scheduleAt)}`
                  : "Pick a future time"
                : "Pick a date/time or use a preset"}
            </span>
          </div>
        )}

        {priceOpen && (
          <div className="flex items-center gap-2 bg-bg/60 border border-border rounded-lg px-2.5 py-1.5">
            <span className="text-xs text-fg-dim">PPV</span>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-fg-dim">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                className="w-20 bg-transparent border-0 px-1 py-0.5 text-sm focus:outline-none placeholder:text-muted"
              />
            </div>
            <label className="text-xs text-fg-dim flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={lockText}
                onChange={(e) => setLockText(e.target.checked)}
                className="accent-accent"
              />
              lock text
            </label>
            <span className="ml-auto text-[10px] text-fg-dim">
              {numericPrice != null && numericPrice > 0
                ? `Fan pays $${numericPrice.toFixed(2)} to read`
                : "Set a price > 0 to enable"}
            </span>
          </div>
        )}

        {(upload.isPending || uploadErr) && (
          <div className={cn(
            "text-[11px] px-2.5 py-1.5 rounded-md border",
            upload.isPending
              ? "bg-bg/60 border-border text-fg-dim"
              : "bg-err/10 border-err/30 text-err",
          )}>
            {upload.isPending ? "Uploading…" : uploadErr}
          </div>
        )}

        {sendToast && (
          <div className="text-[11px] px-2.5 py-1.5 rounded-md border bg-accent/10 border-accent/30 text-accent flex items-center gap-2">
            <span className="flex-1">{sendToast}</span>
            <button
              type="button"
              onClick={() => setSendToast(null)}
              className="text-fg-dim hover:text-fg"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {hasAttachments && (
          <div className="flex items-center gap-1.5 flex-wrap bg-bg/60 border border-border rounded-lg px-2 py-2">
            {attached.map((m) => {
              // Local previews (just-uploaded files) skip the relay's /img
              // proxy — they're blob: URLs already, no IP-policy issue.
              const rawThumb =
                m.files?.thumb?.url ||
                m.files?.squarePreview?.url ||
                m.files?.preview?.url ||
                null;
              const thumb = m._localPreview || proxyImage(rawThumb, accountId);
              return (
                <div
                  key={m.id}
                  className="relative w-14 h-14 rounded-md overflow-hidden border border-border bg-bg-elev-1 group"
                >
                  {thumb ? (
                    <img src={thumb} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-[10px] text-fg-dim">
                      {m.type}
                    </div>
                  )}
                  {m._uploading && (
                    <div className="absolute inset-0 grid place-items-center bg-black/45">
                      <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(m.id)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white grid place-items-center text-[10px] opacity-80 hover:opacity-100"
                    aria-label="Remove attachment"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={disabled || !accountId}
              className="w-14 h-14 rounded-md border border-dashed border-border bg-transparent hover:bg-bg-elev-1 text-fg-dim hover:text-fg grid place-items-center text-lg"
              title="Add more"
            >
              +
            </button>
          </div>
        )}

        {/* Toolbar — every icon button lives in this single row above the
         *  textarea so the composer reads top-to-bottom: alerts, controls,
         *  type-and-send. User can drag the order later; for now this is
         *  the same set of buttons that used to be stacked vertically. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          className="hidden"
          onChange={onPickLocalFile}
        />
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || !accountId || upload.isPending}
            title="Upload from device — appears in chat, stored in vault on send"
            className={cn(
              "w-8 h-8 grid place-items-center rounded-md border text-sm",
              "bg-transparent text-fg-dim border-border hover:bg-bg-elev-1",
              (disabled || !accountId || upload.isPending) && "opacity-40 cursor-not-allowed",
            )}
          >
            ⬆
          </button>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={disabled || !accountId}
            title="Pick from vault"
            className={cn(
              "w-8 h-8 grid place-items-center rounded-md border text-sm",
              hasAttachments
                ? "bg-accent/15 text-accent border-accent/40"
                : "bg-transparent text-fg-dim border-border hover:bg-bg-elev-1",
              (disabled || !accountId) && "opacity-40 cursor-not-allowed",
            )}
          >
            📎
          </button>
          <button
            type="button"
            onClick={() => setPriceOpen((v) => !v)}
            disabled={disabled}
            title="PPV: lock this message behind a price"
            className={cn(
              "w-8 h-8 grid place-items-center rounded-md border text-sm font-semibold",
              priceOpen
                ? "bg-accent/15 text-accent border-accent/40"
                : "bg-transparent text-fg-dim border-border hover:bg-bg-elev-1",
              disabled && "opacity-40 cursor-not-allowed",
            )}
          >
            $
          </button>
          <button
            type="button"
            onClick={() => setScheduleOpen((v) => !v)}
            disabled={disabled}
            title="Schedule send for later"
            className={cn(
              "w-8 h-8 grid place-items-center rounded-md border text-sm",
              scheduleOpen
                ? "bg-accent/15 text-accent border-accent/40"
                : "bg-transparent text-fg-dim border-border hover:bg-bg-elev-1",
              disabled && "opacity-40 cursor-not-allowed",
            )}
          >
            🕐
          </button>
          <EmojiPickerButton onInsert={onEmoji} disabled={disabled} />
          <TemplatePicker accountId={accountId} onPick={onPickTemplate} />
        </div>

        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            disabled={disabled}
            placeholder={placeholder ?? "Type a message…"}
            className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:border-accent resize-y min-h-[44px] max-h-48"
          />
          <div className="flex flex-col gap-1.5">
            <div className="relative flex items-stretch" ref={quickMenuRef}>
              <Button
                size="sm"
                onClick={() => submit()}
                disabled={!canSend}
                className="rounded-r-none"
              >
                {scheduleOpen && scheduleAt && new Date(scheduleAt) > new Date()
                  ? "Schedule"
                  : "Send"}
              </Button>
              <button
                type="button"
                onClick={() => setQuickMenuOpen((v) => !v)}
                disabled={!canSend}
                title="Send in N minutes"
                className={cn(
                  "px-1.5 rounded-r-md border-l border-accent/30 bg-accent text-bg text-xs",
                  "hover:opacity-90",
                  !canSend && "opacity-40 cursor-not-allowed",
                )}
              >
                ▾
              </button>
              {quickMenuOpen && (
                <div className="absolute right-0 bottom-full mb-1 w-44 bg-panel border border-border rounded-md shadow-lg z-20 overflow-hidden">
                  <div className="px-2 py-1.5 text-[10px] text-fg-dim border-b border-border">
                    Send in (local wait)
                  </div>
                  {[1, 3, 5, 15].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => submit({ delayMinutes: m })}
                      disabled={!canSend}
                      className="w-full text-left text-xs px-2.5 py-1.5 hover:bg-bg-elev-1 flex items-center justify-between"
                    >
                      <span>+{m} min</span>
                      <span className="text-[10px] text-fg-dim">
                        {new Date(Date.now() + m * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Render-gated dynamic import: the picker chunk only fetches when
       *  the user actually opens it. Composer mounts on every chat
       *  surface so this matters for cold-inbox latency. */}
      {pickerOpen && (
        <VaultPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          accountId={accountId}
          fanId={fanId}
          initialSelectedIds={attached.map((m) => m.id)}
          onConfirm={onPicked}
        />
      )}
    </>
  );
}

/** datetime-local needs `YYYY-MM-DDTHH:MM` in local time (no Z). Build
 *  the current local-time as that shape so we can use it as the `min`
 *  attr — keeps the picker from offering past times. */
function localNowForInput(): string {
  return toLocalInput(new Date());
}

/** Same shape, offset N minutes into the future. Used by the quick-preset
 *  buttons (+5m, +10m, …) so picking a preset feels like a normal input
 *  fill — the input itself shows the resolved time. */
function localFutureForInput(minutes: number): string {
  return toLocalInput(new Date(Date.now() + minutes * 60_000));
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Describe the schedule in plain English. Short delays (< 10 min) get
 *  "Sending in N min (local wait)" so the user knows the tab needs to
 *  stay open; longer ones use OF's queue and survive close. */
function describeSchedule(value: string): string {
  const d = new Date(value);
  const deltaMs = d.getTime() - Date.now();
  if (deltaMs < 10 * 60 * 1000) {
    const mins = Math.max(1, Math.round(deltaMs / 60_000));
    return `Sending in ${mins} min (local wait — keep tab open)`;
  }
  return `Queued for ${d.toLocaleString()}`;
}


/** Accept "5", "5.00", "5,50". Returns null on garbage so submit stays
 *  free of guard-clauses on every read. */
function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}
