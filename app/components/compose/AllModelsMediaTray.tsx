"use client";

/**
 * AllModelsMediaTray — the attachment strip for the "send to ALL models"
 * variant of the post / mass-message composers. Tracks raw `File[]`
 * (computer-uploads only) because:
 *   • Each model has its own vault, so the per-account vault picker
 *     is meaningless when the same payload has to fan out to N models.
 *   • Each model has its own list of vault media ids — there's no
 *     single id we can put in `mediaFiles` that works for everyone.
 *
 * On submit, the parent re-uploads every File against every active
 * account's `/api/of/v2/upload` endpoint and uses each account's
 * returned `send_with` claims in that account's POST. We deliberately
 * don't pre-upload here: an upload that never gets sent leaves orphan
 * vault items behind, and pre-uploading per-account before submit ties
 * the modal to a long-lived background mutation that's a pain to cancel.
 */

import { useRef } from "react";

import { useUploadPreset } from "@/hooks/useUploadPreset";
import { resizeImageIfNeeded } from "@/lib/imageResize";

import { UploadPresetChip } from "./UploadPresetChip";

export function AllModelsMediaTray({
  files, onChange,
}: { files: File[]; onChange: (next: File[]) => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preset, setPreset] = useUploadPreset();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (e.target) e.target.value = "";
    if (picked.length === 0) return;
    // Resize once here so the same downscaled File is reused across
    // every per-account upload in fanOutUpload — saves N-1 redo passes.
    const resized = await Promise.all(picked.map((f) => resizeImageIfNeeded(f, preset)));
    onChange([...files, ...resized]);
  }

  function remove(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-1.5">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={onPick}
      />
      {files.length > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap bg-bg/60 border border-border rounded-lg px-2 py-2">
          {files.map((f, i) => {
            const isImage = f.type.startsWith("image/");
            const isVideo = f.type.startsWith("video/");
            const blob = isImage || isVideo ? URL.createObjectURL(f) : null;
            return (
              <div
                key={`${f.name}-${i}`}
                className="relative w-16 h-16 rounded-md overflow-hidden border border-border bg-bg-elev-1"
                title={f.name}
              >
                {isImage && blob ? (
                  <img
                    src={blob}
                    alt={f.name}
                    decoding="async"
                    className="w-full h-full object-cover"
                    onLoad={() => {
                      // Defer revoke off the decode callback so we don't
                      // pay sync GC inside the paint frame. The browser
                      // still has the blob bound to this <img>'s active
                      // src; revoking after a microtask is safe.
                      queueMicrotask(() => URL.revokeObjectURL(blob));
                    }}
                  />
                ) : (
                  <div className="w-full h-full grid place-items-center text-[10px] text-fg-dim text-center px-1">
                    {isVideo ? "▶ video" : f.name.slice(0, 10)}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white grid place-items-center text-[10px] opacity-90"
                  aria-label="Remove"
                >×</button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-16 h-16 rounded-md border border-dashed border-border hover:bg-bg-elev-1 text-fg-dim hover:text-fg grid place-items-center text-lg"
            title="Upload more"
          >⬆</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full text-xs text-fg-dim hover:text-fg border border-dashed border-border rounded-md py-3 hover:bg-bg-elev-1"
        >
          ⬆ Upload from computer
        </button>
      )}
      <UploadPresetChip preset={preset} onChange={setPreset} />
      <div className="text-[10px] text-fg-dim italic">
        Files upload once per account on submit, then attach to that
        account&apos;s send. No vault picker in all-models mode — vaults
        are per-account.
      </div>
    </div>
  );
}
