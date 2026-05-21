"use client";

/**
 * UploadPresetChip — tiny segmented control next to upload buttons that
 * flips the global resize preset between "original" and "1080w". The
 * choice is persisted via useUploadPreset, so it sticks across the whole
 * app (chat, post, mass-msg) once the user picks one.
 */

import type { UploadPreset } from "@/lib/imageResize";

export function UploadPresetChip({
  preset, onChange,
}: { preset: UploadPreset; onChange: (next: UploadPreset) => void }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-fg-dim">
      <span>Resize images:</span>
      <div className="inline-flex border border-border rounded-md overflow-hidden">
        {(["original", "1080w"] as UploadPreset[]).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={
              "px-2 py-0.5 transition-colors " +
              (preset === opt
                ? "bg-bg-elev-1 text-fg"
                : "text-fg-dim hover:text-fg hover:bg-bg-elev-1/50")
            }
          >
            {opt === "original" ? "Original" : "1080w"}
          </button>
        ))}
      </div>
    </div>
  );
}
