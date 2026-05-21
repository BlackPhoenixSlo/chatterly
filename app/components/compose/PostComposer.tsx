"use client";

/**
 * PostComposer — modal for creating a public feed post via
 * POST /api/of/v2/posts. Mirrors OF's own "Create post" surface in the
 * minimum-viable shape:
 *   • text body
 *   • media from vault (reuses the chat VaultPicker — same picker, no
 *     fan-scope so the per-fan badges/MRU just stay neutral)
 *   • price (0 = free; >0 = PPV)
 *
 * Deliberately deferred to v2:
 *   • Polls — no captured curl yet; would be guesswork.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useActiveAccounts } from "@/hooks/useAccounts";
import { relay, type VaultMedia } from "@/lib/relay";
import { VaultPicker } from "@/components/chat/VaultPicker";
import { localDatetimeToIso, recordSchedule } from "@/lib/scheduleHistory";
import { fanOutUpload, type FanOutResult, summarizeFanOut } from "@/lib/fanOut";

import { AccountPicker } from "./AccountPicker";
import { MediaTray } from "./MediaTray";
import { AllModelsMediaTray } from "./AllModelsMediaTray";
import { ScheduleField } from "./ScheduleField";

interface CreatePostResp {
  id?: number;
  // OF returns the full post shape; we only need a success signal so the
  // rest stays loose.
  [k: string]: unknown;
}

export function PostComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const activeAccounts = useActiveAccounts();
  const [allModels, setAllModels] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<VaultMedia[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [price, setPrice] = useState<string>("");
  const [schedule, setSchedule] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<FanOutResult[] | null>(null);

  // Pivot between single-account vault path and per-account upload-only
  // fan-out path. Drop vault attachments when entering all-models (no
  // single id works across accounts).
  useEffect(() => {
    if (allModels) {
      setAccountId(null);
      setAttached([]);
    } else {
      setAttachedFiles([]);
    }
  }, [allModels]);

  async function postOne(
    forAccountId: string,
    mediaFiles: Array<number | Record<string, unknown>>,
    scheduledIso: string | null,
  ) {
    const priceNum = price ? Number(price) : 0;
    const resp = await relay.post<CreatePostResp>(
      "/api/of/v2/posts",
      {
        text: text.trim(),
        media_files: mediaFiles,
        price: priceNum,
        posted_at: scheduledIso,
      },
      { accountId: forAccountId },
    );
    if (schedule) recordSchedule(forAccountId, schedule);
    return resp;
  }

  const create = useMutation({
    mutationFn: async () => {
      const trimmed = text.trim();
      if (allModels) {
        if (activeAccounts.length === 0) throw new Error("No active models");
      } else {
        if (!accountId) throw new Error("Pick an account");
      }
      const totalMedia = allModels ? attachedFiles.length : attached.length;
      if (!trimmed && totalMedia === 0) throw new Error("Add text or media");
      const priceNum = price ? Number(price) : 0;
      if (!Number.isFinite(priceNum) || priceNum < 0) throw new Error("Invalid price");
      const scheduledIso = schedule ? localDatetimeToIso(schedule) : null;
      if (schedule && !scheduledIso) throw new Error("Invalid schedule date");

      if (allModels) {
        const accountIds = activeAccounts.map((a) => a.id);
        setProgress(`Posting to 0 / ${accountIds.length}…`);
        const fanResults = await fanOutUpload({
          accountIds,
          files: attachedFiles,
          submit: (aid, mediaFiles) => postOne(aid, mediaFiles, scheduledIso),
          onProgress: (cur, total) => setProgress(`Posting to ${cur} / ${total}…`),
        });
        setResults(fanResults);
        setProgress(null);
        if (fanResults.every((r) => r.ok)) return fanResults;
        throw new Error(summarizeFanOut(fanResults));
      }

      const mediaFiles: Array<number | Record<string, unknown>> = attached.map(
        (m) => m._claim ?? m.id,
      );
      return postOne(accountId!, mediaFiles, scheduledIso);
    },
    onSuccess: () => {
      // The wall-media query backs the vault picker's blue ring; nuking
      // it ensures the freshly-posted media flips state on next open.
      qc.invalidateQueries({ queryKey: ["wall-media"] });
      reset();
      onClose();
    },
    onError: (err: Error) => {
      setProgress(null);
      setError(err.message);
    },
  });

  function reset() {
    setText("");
    setAttached([]);
    setAttachedFiles([]);
    setPrice("");
    setSchedule("");
    setError(null);
    setProgress(null);
    setResults(null);
    setAllModels(false);
  }

  if (!open) return null;

  const priceNum = price ? Number(price) : 0;
  const isPPV = priceNum > 0;
  const isScheduled = !!schedule;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4"
      onClick={() => { if (!create.isPending) { reset(); onClose(); } }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] max-h-[90vh] flex flex-col bg-panel border border-border rounded-xl shadow-2xl"
      >
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">New post</h2>
          <button
            type="button"
            onClick={() => { if (!create.isPending) { reset(); onClose(); } }}
            className="text-fg-dim hover:text-fg text-lg leading-none"
            title="Close"
          >×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allModels}
              onChange={(e) => setAllModels(e.target.checked)}
            />
            <span className="font-medium">Post from ALL models</span>
            <span className="text-fg-dim">
              ({activeAccounts.length} active session{activeAccounts.length === 1 ? "" : "s"})
            </span>
          </label>

          {allModels ? (
            <div className="text-[11px] text-fg-dim border border-dashed border-border rounded-md py-2 px-3">
              Each account uploads + posts independently. Vault picker is
              hidden because vaults are per-account.
            </div>
          ) : (
            <AccountPicker value={accountId} onChange={setAccountId} />
          )}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What's on your feed today?"
            rows={5}
            className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:border-accent resize-y"
          />

          {allModels ? (
            <AllModelsMediaTray files={attachedFiles} onChange={setAttachedFiles} />
          ) : (
            <MediaTray
              accountId={accountId}
              attached={attached}
              onChange={setAttached}
              onOpenVaultPicker={() => setPickerOpen(true)}
            />
          )}

          <div className="flex items-center gap-2">
            <label className="text-xs text-fg-dim shrink-0">Price (USD):</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0 (free)"
              className="flex-1 bg-bg border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
            />
            <span className={isPPV ? "text-warn text-[11px]" : "text-fg-dim text-[11px]"}>
              {isPPV ? `🔒 PPV $${priceNum.toFixed(2)}` : "free"}
            </span>
          </div>

          <ScheduleField
            scope={allModels ? "all-models" : accountId}
            value={schedule}
            onChange={setSchedule}
          />

          {results && (
            <div className="border border-border rounded-md p-3 space-y-1 text-[11px]">
              <div className="font-medium">Fan-out results — {summarizeFanOut(results)}</div>
              {results.map((r) => (
                <div key={r.accountId} className={r.ok ? "text-ok" : "text-err"}>
                  {r.ok ? "✓" : "✗"} {r.accountId}
                  {r.error ? ` — ${r.error}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          {progress && <span className="text-fg-dim text-[11px] mr-auto">{progress}</span>}
          {error && !progress && <span className="text-err text-[11px] mr-auto">{error}</span>}
          <button
            type="button"
            onClick={() => { reset(); onClose(); }}
            disabled={create.isPending}
            className="text-xs px-3 py-1.5 rounded border border-border hover:border-border-light text-fg-dim hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setResults(null);
              if (allModels && !confirm(
                `Post from ${activeAccounts.length} model${activeAccounts.length === 1 ? "" : "s"}?`,
              )) return;
              create.mutate();
            }}
            disabled={
              create.isPending ||
              (allModels ? activeAccounts.length === 0 : !accountId)
            }
            className="text-xs px-4 py-1.5 rounded bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {create.isPending
              ? (isScheduled ? "Scheduling…" : "Posting…")
              : (isScheduled ? "Schedule post" : "Post")}
          </button>
        </footer>
      </div>

      <VaultPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        accountId={accountId}
        fanId={null}
        initialSelectedIds={attached.map((m) => m.id)}
        onConfirm={(picked) => {
          setAttached(picked);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
