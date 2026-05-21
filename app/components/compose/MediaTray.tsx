"use client";

/**
 * MediaTray — shared attachment strip for the New-post + Mass-message
 * modals. Renders the thumbnails for already-attached vault media, an
 * "upload from computer" button (⬆), and an "add from vault" button (📎).
 *
 * Upload flow reuses useVaultUpload — same 3-step hash → signed/create
 * → S3 PUT path the chat Composer uses, so success here yields the same
 * `send_with` shape (numeric vault id OR fresh-claim dict). The caller's
 * `onChange` receives the merged VaultMedia[].
 */

import { useRef, useState } from "react";

import { useVaultUpload } from "@/hooks/useVaultMedia";
import { useUploadPreset } from "@/hooks/useUploadPreset";
import { resizeImageIfNeeded } from "@/lib/imageResize";
import { proxyImage, type VaultMedia } from "@/lib/relay";
import { UploadPresetChip } from "./UploadPresetChip";

export function MediaTray({
  accountId, attached, onChange, onOpenVaultPicker,
}: {
  accountId: string | null;
  attached: VaultMedia[];
  onChange: (next: VaultMedia[]) => void;
  onOpenVaultPicker: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const upload = useVaultUpload(accountId);
  const [preset, setPreset] = useUploadPreset();
  const [err, setErr] = useState<string | null>(null);

  async function onPickLocalFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (e.target) e.target.value = "";
    if (files.length === 0) return;
    setErr(null);
    // Sequential upload — OF's signed-upload + S3 + claim chain dislikes
    // parallel hammering, and we want one clear error per file.
    for (const rawFile of files) {
      const file = await resizeImageIfNeeded(rawFile, preset);
      const previewUrl = URL.createObjectURL(file);
      try {
        const resp = await upload.mutateAsync(file);
        if (!resp.ready) {
          setErr(resp.note || "Upload incomplete.");
          URL.revokeObjectURL(previewUrl);
          continue;
        }
        const fresh: VaultMedia[] = (resp.send_with ?? []).map((entry, i) => {
          if (typeof entry === "number") {
            return {
              id: entry,
              type: (resp.existing?.type as VaultMedia["type"]) ||
                    (file.type.startsWith("video") ? "video" : "photo"),
              files: resp.existing?.files || null,
              _localPreview: previewUrl,
            };
          }
          return {
            id: -(Date.now() + i),
            type: file.type.startsWith("video") ? "video" : "photo",
            files: null,
            _claim: entry,
            _localPreview: previewUrl,
          };
        });
        onChange([
          ...attached,
          ...fresh.filter((m) => !attached.some((a) => a.id === m.id)),
        ]);
      } catch (e2) {
        URL.revokeObjectURL(previewUrl);
        setErr(`Upload failed: ${(e2 as Error).message || "unknown"}`);
      }
    }
  }

  function remove(id: number) {
    onChange(attached.filter((m) => m.id !== id));
  }

  return (
    <div className="space-y-1.5">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={onPickLocalFile}
      />
      {attached.length > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap bg-bg/60 border border-border rounded-lg px-2 py-2">
          {attached.map((m) => {
            const rawThumb =
              m.files?.thumb?.url ||
              m.files?.squarePreview?.url ||
              m.files?.preview?.url ||
              null;
            const thumb = m._localPreview || proxyImage(rawThumb, accountId);
            return (
              <div
                key={m.id}
                className="relative w-16 h-16 rounded-md overflow-hidden border border-border bg-bg-elev-1"
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
                  onClick={() => remove(m.id)}
                  className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white grid place-items-center text-[10px] opacity-90"
                  aria-label="Remove"
                >×</button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onOpenVaultPicker}
            disabled={!accountId}
            className="w-16 h-16 rounded-md border border-dashed border-border hover:bg-bg-elev-1 text-fg-dim hover:text-fg grid place-items-center text-lg disabled:opacity-50"
            title="Pick from vault"
          >📎</button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!accountId || upload.isPending}
            className="w-16 h-16 rounded-md border border-dashed border-border hover:bg-bg-elev-1 text-fg-dim hover:text-fg grid place-items-center text-lg disabled:opacity-50"
            title="Upload from computer"
          >{upload.isPending ? "⏳" : "⬆"}</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!accountId || upload.isPending}
            className="text-xs text-fg-dim hover:text-fg border border-dashed border-border rounded-md py-3 hover:bg-bg-elev-1 disabled:opacity-50"
          >
            {upload.isPending ? "Uploading…" : "⬆ Upload from computer"}
          </button>
          <button
            type="button"
            onClick={onOpenVaultPicker}
            disabled={!accountId}
            className="text-xs text-fg-dim hover:text-fg border border-dashed border-border rounded-md py-3 hover:bg-bg-elev-1 disabled:opacity-50"
          >
            📎 Add from vault
          </button>
        </div>
      )}
      <UploadPresetChip preset={preset} onChange={setPreset} />
      {err && <div className="text-[11px] text-err">{err}</div>}
    </div>
  );
}
