"use client";

/**
 * useUploadPreset — global "resize on upload?" toggle, persisted in
 * localStorage so the user sets it once and the choice sticks.
 *
 * Default is "original" — silent downscaling would be a footgun for a
 * model who's intentionally uploading a 4K stills set.
 */

import { useEffect, useState } from "react";

import type { UploadPreset } from "@/lib/imageResize";

const STORAGE_KEY = "chatterly:upload-preset";
const EVENT = "chatterly-upload-preset-change";

export function readUploadPreset(): UploadPreset {
  if (typeof window === "undefined") return "original";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "1080w" ? "1080w" : "original";
}

export function useUploadPreset(): [UploadPreset, (next: UploadPreset) => void] {
  const [preset, setPreset] = useState<UploadPreset>(() => readUploadPreset());

  useEffect(() => {
    const onChange = () => setPreset(readUploadPreset());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  function update(next: UploadPreset) {
    setPreset(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new Event(EVENT));
    } catch { /* quota — silent */ }
  }

  return [preset, update];
}
