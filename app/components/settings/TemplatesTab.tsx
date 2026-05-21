"use client";

/**
 * TemplatesTab — manage saved replies + the welcome message.
 *
 * Two different backends behind one editor:
 *   • Welcome message → OF (slot `reply_on_subscribe`). Only one per
 *     account. OF lets us create/edit/delete this exact slot.
 *   • Saved replies → local SQLite (/admin/saved-replies/*). OF's
 *     /messages/templates rejects creates for everything else, so we
 *     persist regular replies in our own DB. They never round-trip
 *     through OF — Composer will read them locally too.
 *
 * The editor itself is identical for both kinds; `draft.kind` switches
 * which mutation we fire on Save.
 */

import { useEffect, useState } from "react";

import { VaultPicker } from "@/components/chat/VaultPicker";
import { Button, Card, Input, Textarea } from "@/components/ui/primitives";
import { useActiveAccounts } from "@/hooks/useAccounts";
import {
  useSavedReplies,
  useCreateSavedReply,
  useDeleteSavedReply,
  useUpdateSavedReply,
} from "@/hooks/useSavedReplies";
import {
  useCreateTemplate,
  useDeleteTemplate,
  useTemplates,
  useUpdateTemplate,
} from "@/hooks/useTemplates";
import { proxyImage, RelayError, type OFMessageTemplate, type SavedReply, type VaultMedia } from "@/lib/relay";
import { cn } from "@/lib/utils";

/** Pull OF's `error.message` out of the relay's wrapped 4xx/5xx body so
 *  the editor can show a human reason instead of just "HTTP 400". */
function extractError(err: unknown): string {
  if (err instanceof RelayError) {
    const body = err.body as { detail?: { upstream_body?: string } } | undefined;
    const raw = body?.detail?.upstream_body;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } };
        if (parsed?.error?.message) return parsed.error.message;
      } catch { /* fall through */ }
    }
    return `HTTP ${err.status} — ${err.message}`;
  }
  return (err as Error)?.message || "unknown error";
}

type DraftKind = "welcome" | "reply";

interface DraftState {
  kind: DraftKind;
  /** Welcome IDs are OF strings; reply IDs are local-DB numeric. */
  id: string | number | null;
  title: string;
  text: string;
  price: string;
  lockedText: boolean;
  attached: VaultMedia[];
}

const EMPTY_REPLY: DraftState = {
  kind: "reply",
  id: null,
  title: "",
  text: "",
  price: "",
  lockedText: false,
  attached: [],
};

const EMPTY_WELCOME: DraftState = { ...EMPTY_REPLY, kind: "welcome" };

function ofMediaToVault(t: OFMessageTemplate): VaultMedia[] {
  return (t.media ?? []).map((m) => ({
    id: m.id,
    type: (m.type as VaultMedia["type"]) || "photo",
    files: m.files ?? null,
  }));
}

function localMediaToVault(r: SavedReply): VaultMedia[] {
  return (r.media ?? []).map((m) => ({
    id: m.id,
    type: (m.type as VaultMedia["type"]) || "photo",
    files: m.files ?? null,
  }));
}

export default function TemplatesTab() {
  const accounts = useActiveAccounts();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accountId, accounts]);

  // OF welcome (single slot).
  const tplQ = useTemplates(accountId);
  const createTplM = useCreateTemplate(accountId);
  const updateTplM = useUpdateTemplate(accountId);
  const deleteTplM = useDeleteTemplate(accountId);
  const welcome = (tplQ.data ?? []).find((t) => t.template === "reply_on_subscribe");

  // Local saved replies.
  const replyQ = useSavedReplies(accountId);
  const createReplyM = useCreateSavedReply(accountId);
  const updateReplyM = useUpdateSavedReply(accountId);
  const deleteReplyM = useDeleteSavedReply(accountId);
  const replies = replyQ.data ?? [];

  function startNewReply() {
    setDraft({ ...EMPTY_REPLY });
    setSaveErr(null);
  }

  function startNewWelcome() {
    setDraft({ ...EMPTY_WELCOME });
    setSaveErr(null);
  }

  function startEditWelcome(t: OFMessageTemplate) {
    setDraft({
      kind: "welcome",
      id: t.id,
      title: "",
      text: stripHtml(t.text),
      price: t.price ? String(t.price) : "",
      lockedText: !!t.lockedText,
      attached: ofMediaToVault(t),
    });
    setSaveErr(null);
  }

  function startEditReply(r: SavedReply) {
    setDraft({
      kind: "reply",
      id: r.id,
      title: r.title ?? "",
      text: r.text,
      price: r.price ? String(r.price) : "",
      lockedText: !!r.locked_text,
      attached: localMediaToVault(r),
    });
    setSaveErr(null);
  }

  async function save() {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;
    const price = Number(draft.price) || 0;
    setSaveErr(null);
    try {
      if (draft.kind === "welcome") {
        const body = {
          text,
          price,
          lockedText: price > 0 ? draft.lockedText : false,
          mediaFiles: draft.attached.map((m) => m.id),
          template: "reply_on_subscribe",
        };
        if (typeof draft.id === "string") {
          await updateTplM.mutateAsync({ id: draft.id, ...body });
        } else {
          await createTplM.mutateAsync(body);
        }
      } else {
        const body = {
          title: draft.title.trim() || null,
          text,
          price,
          lockedText: price > 0 ? draft.lockedText : false,
          media: draft.attached.map((m) => ({
            id: m.id,
            type: m.type,
            files: m.files ?? null,
          })),
        };
        if (typeof draft.id === "number") {
          await updateReplyM.mutateAsync({ id: draft.id, ...body });
        } else {
          await createReplyM.mutateAsync(body);
        }
      }
      setDraft(null);
    } catch (err) {
      const msg = extractError(err);
      console.warn("[templates] save failed", err);
      setSaveErr(msg);
    }
  }

  async function removeWelcome(id: string) {
    if (!confirm("Delete the welcome message?")) return;
    try { await deleteTplM.mutateAsync(id); }
    catch (err) { console.warn("[templates] delete welcome failed", err); }
  }

  async function removeReply(id: number) {
    if (!confirm("Delete this saved reply?")) return;
    try { await deleteReplyM.mutateAsync(id); }
    catch (err) { console.warn("[templates] delete reply failed", err); }
  }

  const saving =
    createTplM.isPending || updateTplM.isPending ||
    createReplyM.isPending || updateReplyM.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 className="text-base font-semibold">Templates</h2>
          <div className="flex items-center gap-2 text-xs">
            <label className="text-fg-dim">Account</label>
            <select
              value={accountId ?? ""}
              onChange={(e) => { setAccountId(e.target.value); setDraft(null); }}
              className="bg-bg border border-border rounded-md px-2 py-1 text-xs focus:outline-none"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nickname || a.id}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { tplQ.refetch(); replyQ.refetch(); }}
              disabled={tplQ.isFetching || replyQ.isFetching}
            >
              {tplQ.isFetching || replyQ.isFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>

        {(tplQ.error || replyQ.error) && (
          <div className="text-sm text-err mb-3">
            Failed to load: {(tplQ.error || replyQ.error as Error)?.message || "unknown"}
          </div>
        )}

        {draft && (
          <div className="border border-accent/40 rounded-lg p-3 mb-4 space-y-3 bg-bg/40">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                {draft.id != null
                  ? (draft.kind === "welcome" ? "Edit welcome message" : "Edit saved reply")
                  : (draft.kind === "welcome" ? "New welcome message" : "New saved reply")}
                {draft.kind === "welcome" && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">👋 welcome (OF)</span>
                )}
                {draft.kind === "reply" && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-bg-elev-1 text-fg-dim">local</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="text-xs text-fg-dim hover:text-fg"
              >
                Cancel
              </button>
            </div>

            {draft.kind === "reply" && (
              <Input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft((d) => d && { ...d, title: e.target.value })}
                placeholder="Title (optional — shows in picker)"
                className="text-sm"
              />
            )}

            <Textarea
              value={draft.text}
              onChange={(e) => setDraft((d) => d && { ...d, text: e.target.value })}
              placeholder="Template text"
              className="min-h-24 text-sm font-sans"
            />

            <div className="flex items-center gap-2 flex-wrap">
              {draft.attached.map((m) => {
                const rawThumb =
                  m.files?.thumb?.url ||
                  m.files?.squarePreview?.url ||
                  m.files?.preview?.url ||
                  null;
                const thumb = proxyImage(rawThumb, accountId);
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
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => d && { ...d, attached: d.attached.filter((x) => x.id !== m.id) })
                      }
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
                disabled={!accountId}
                className="w-14 h-14 rounded-md border border-dashed border-border bg-transparent hover:bg-bg-elev-1 text-fg-dim hover:text-fg grid place-items-center text-xs"
                title="Attach media from vault"
              >
                📎+
              </button>
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              <label className="text-xs text-fg-dim flex items-center gap-2">
                Price $
                <Input
                  type="text"
                  inputMode="decimal"
                  value={draft.price}
                  onChange={(e) => setDraft((d) => d && { ...d, price: e.target.value })}
                  className="w-24 py-1 text-sm"
                  placeholder="0.00"
                />
              </label>
              <label className="text-xs text-fg-dim flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={draft.lockedText}
                  disabled={!(Number(draft.price) > 0)}
                  onChange={(e) => setDraft((d) => d && { ...d, lockedText: e.target.checked })}
                  className="accent-accent"
                />
                Lock text behind price
              </label>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={save}
                  disabled={!draft.text.trim() || saving}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>

            {saveErr && (
              <div className="text-[11px] px-2.5 py-1.5 rounded-md border bg-err/10 border-err/30 text-err">
                ⚠ Save failed: {saveErr}
              </div>
            )}
          </div>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-fg-dim uppercase tracking-wide">Welcome message</h3>
            {!welcome && draft?.kind !== "welcome" && (
              <Button size="sm" variant="ghost" onClick={startNewWelcome}>+ Set welcome</Button>
            )}
          </div>
          {welcome ? (
            <WelcomeRow
              t={welcome}
              accountId={accountId}
              onEdit={startEditWelcome}
              onDelete={() => removeWelcome(welcome.id)}
              busy={deleteTplM.isPending}
            />
          ) : (
            <div className="text-xs text-fg-dim italic">No welcome message set — new subscribers won't get an auto-reply.</div>
          )}
        </section>

        <section className="space-y-2 mt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-fg-dim uppercase tracking-wide">
              Saved replies <span className="text-fg-dim normal-case font-normal">(local)</span>
            </h3>
            <Button size="sm" variant="ghost" onClick={startNewReply}>+ Add</Button>
          </div>
          {replyQ.isLoading && replies.length === 0 && (
            <div className="text-sm text-fg-dim">Loading…</div>
          )}
          {!replyQ.isLoading && replies.length === 0 && (
            <div className="text-xs text-fg-dim italic">No saved replies yet. They live in Chatterly only — OF won't see them.</div>
          )}
          {replies.map((r) => (
            <ReplyRow
              key={r.id}
              r={r}
              accountId={accountId}
              onEdit={startEditReply}
              onDelete={() => removeReply(r.id)}
              busy={deleteReplyM.isPending && deleteReplyM.variables === r.id}
            />
          ))}
        </section>
      </Card>

      <VaultPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        accountId={accountId}
        initialSelectedIds={draft?.attached.map((m) => m.id) ?? []}
        onConfirm={(picked) => {
          // Fresh-claim dicts (negative ids) are ephemeral and useless for
          // persistence — drop them. The numeric vault ids work for both
          // OF welcome msg and local saved replies.
          const vaultOnly = picked.filter((m) => m.id > 0);
          setDraft((d) => d && { ...d, attached: vaultOnly });
        }}
      />
    </div>
  );
}

function WelcomeRow({
  t, accountId, onEdit, onDelete, busy,
}: {
  t: OFMessageTemplate;
  accountId: string | null;
  onEdit: (t: OFMessageTemplate) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const media = t.media ?? [];
  return (
    <div className={cn(
      "border border-border rounded-md px-3 py-2.5 flex items-start gap-3",
      busy && "opacity-60",
    )}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">👋 welcome</span>
          {(t.mediaCount ?? 0) > 0 && (
            <span className="text-[10px] text-fg-dim">📎 {t.mediaCount}</span>
          )}
          {t.price && t.price > 0 && (
            <span className="text-[10px] text-warn">🔒 ${t.price.toFixed(2)}</span>
          )}
        </div>
        <div className="text-sm whitespace-pre-wrap break-words line-clamp-4">
          {stripHtml(t.displayText || t.text)}
        </div>
        {media.length > 0 && <MediaStrip media={media} accountId={accountId} />}
      </div>
      <div className="flex flex-col gap-1 shrink-0">
        <Button size="sm" variant="secondary" onClick={() => onEdit(t)}>Edit</Button>
        <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>Delete</Button>
      </div>
    </div>
  );
}

function ReplyRow({
  r, accountId, onEdit, onDelete, busy,
}: {
  r: SavedReply;
  accountId: string | null;
  onEdit: (r: SavedReply) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const media = r.media ?? [];
  return (
    <div className={cn(
      "border border-border rounded-md px-3 py-2.5 flex items-start gap-3",
      busy && "opacity-60",
    )}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          {r.title && (
            <span className="text-[11px] font-medium text-fg">{r.title}</span>
          )}
          {media.length > 0 && (
            <span className="text-[10px] text-fg-dim">📎 {media.length}</span>
          )}
          {r.price > 0 && (
            <span className="text-[10px] text-warn">🔒 ${r.price.toFixed(2)}</span>
          )}
        </div>
        <div className="text-sm whitespace-pre-wrap break-words line-clamp-4">
          {r.text}
        </div>
        {media.length > 0 && <MediaStrip media={media} accountId={accountId} />}
      </div>
      <div className="flex flex-col gap-1 shrink-0">
        <Button size="sm" variant="secondary" onClick={() => onEdit(r)}>Edit</Button>
        <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>Delete</Button>
      </div>
    </div>
  );
}

function MediaStrip({
  media, accountId,
}: {
  media: Array<{ id: number; type?: string; files?: SavedReply["media"][number]["files"] }>;
  accountId: string | null;
}) {
  return (
    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
      {media.slice(0, 6).map((m) => {
        const rawThumb =
          m.files?.thumb?.url ||
          m.files?.squarePreview?.url ||
          m.files?.preview?.url ||
          null;
        const thumb = proxyImage(rawThumb, accountId);
        return (
          <div key={m.id} className="w-10 h-10 rounded border border-border overflow-hidden bg-bg-elev-1">
            {thumb ? (
              <img src={thumb} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full grid place-items-center text-[9px] text-fg-dim">
                {m.type ?? "?"}
              </div>
            )}
          </div>
        );
      })}
      {media.length > 6 && (
        <span className="text-[10px] text-fg-dim">+{media.length - 6}</span>
      )}
    </div>
  );
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
