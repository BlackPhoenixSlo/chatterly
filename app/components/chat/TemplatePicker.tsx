"use client";

/**
 * TemplatePicker — popover for picking a saved reply or the welcome
 * message template, then inserting it into the composer.
 *
 * Two sources merged into one list:
 *   • OF welcome message (badge: 👋) — only one per account.
 *   • Local saved replies — Chatterly-side, since OF rejects template
 *     creates for everything else.
 *
 * Pick a row → its text fills the textarea + its media attaches to the
 * outgoing message.
 */

import { useEffect, useRef, useState } from "react";

import { useSavedReplies } from "@/hooks/useSavedReplies";
import { useTemplates } from "@/hooks/useTemplates";
import { cn } from "@/lib/utils";
import type { OFMessageTemplate, SavedReply, VaultMedia } from "@/lib/relay";

/** Unified shape so Composer doesn't care where the row came from. */
export interface PickedTemplate {
  source: "of" | "local";
  text: string;       // plain text the textarea wants
  displayText: string; // possibly HTML for the picker preview
  mediaCount: number;
  price: number;
  lockedText: boolean;
  isWelcome: boolean;
  media: VaultMedia[];
  title?: string;
}

function fromOF(t: OFMessageTemplate): PickedTemplate {
  return {
    source: "of",
    text: stripHtml(t.displayText || t.text),
    displayText: t.displayText || t.text,
    mediaCount: t.mediaCount ?? (t.media?.length ?? 0),
    price: t.price ?? 0,
    lockedText: !!t.lockedText,
    isWelcome: t.template === "reply_on_subscribe",
    media: (t.media ?? []).map((m) => ({
      id: m.id,
      type: (m.type as VaultMedia["type"]) || "photo",
      files: m.files ?? null,
    })),
  };
}

function fromLocal(r: SavedReply): PickedTemplate {
  return {
    source: "local",
    text: r.text,
    displayText: r.text,
    mediaCount: r.media?.length ?? 0,
    price: r.price ?? 0,
    lockedText: !!r.locked_text,
    isWelcome: false,
    title: r.title ?? undefined,
    media: (r.media ?? []).map((m) => ({
      id: m.id,
      type: (m.type as VaultMedia["type"]) || "photo",
      files: m.files ?? null,
    })),
  };
}

export interface TemplatePickerProps {
  accountId: string | null;
  onPick: (t: PickedTemplate) => void;
}

export function TemplatePicker({ accountId, onPick }: TemplatePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tplQ = useTemplates(open ? accountId : null);
  const replyQ = useSavedReplies(open ? accountId : null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Welcome first (it's most-often used as the high-leverage reply),
  // then saved replies — newest-edit first as the local API returns.
  const welcome = (tplQ.data ?? []).find((t) => t.template === "reply_on_subscribe");
  const ofRows: PickedTemplate[] = welcome ? [fromOF(welcome)] : [];
  const localRows: PickedTemplate[] = (replyQ.data ?? []).map(fromLocal);
  const items = [...ofRows, ...localRows];

  const loading = tplQ.isFetching || replyQ.isFetching;
  const err = tplQ.error || replyQ.error;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!accountId}
        title="Insert saved template"
        className={cn(
          "w-8 h-8 grid place-items-center rounded-md border text-sm",
          open
            ? "bg-accent/15 text-accent border-accent/40"
            : "bg-transparent text-fg-dim border-border hover:bg-bg-elev-1",
          !accountId && "opacity-40 cursor-not-allowed",
        )}
      >
        ⌘
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 w-80 max-h-96 overflow-y-auto bg-panel border border-border rounded-lg shadow-xl z-50">
          <div className="px-3 py-2 text-[11px] text-fg-dim border-b border-border">
            Saved templates {loading && "· loading…"}
          </div>
          {err && (
            <div className="px-3 py-2 text-xs text-err">
              {(err as Error).message || "failed"}
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="px-3 py-4 text-xs text-fg-dim text-center">
              No templates yet. Create one in Settings → Templates.
            </div>
          )}
          {items.map((t, i) => (
            <button
              key={`${t.source}:${t.title ?? i}:${i}`}
              type="button"
              onClick={() => { onPick(t); setOpen(false); }}
              className="w-full text-left px-3 py-2 border-b border-border/40 hover:bg-bg-elev-1 transition-colors"
            >
              <div className="flex items-center gap-2 mb-0.5">
                {t.isWelcome && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">👋 welcome</span>
                )}
                {t.source === "local" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-elev-1 text-fg-dim">local</span>
                )}
                {t.title && (
                  <span className="text-[10px] font-medium text-fg">{t.title}</span>
                )}
                {t.mediaCount > 0 && (
                  <span className="text-[10px] text-fg-dim">📎 {t.mediaCount}</span>
                )}
                {t.price > 0 && (
                  <span className="text-[10px] text-warn">🔒 ${t.price.toFixed(2)}</span>
                )}
              </div>
              <div className="text-xs text-fg line-clamp-2">{t.text}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Back-compat: composer calls this with the picked item's media. */
export function templateMediaToVault(t: PickedTemplate): VaultMedia[] {
  return t.media;
}

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
    .replace(/&#39;/g, "'")
    .trim();
}
