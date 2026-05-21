/**
 * imageResize — canvas-based downscaler for vault/post uploads.
 *
 * OF accepts originals up to ~10MB but every upload burns bandwidth and
 * extends the hash→signed→S3→claim chain. A 1080w preset is the OF web
 * default and good enough for almost every use case; we let the user
 * keep "original" for cases where the source is already small.
 *
 * Videos and audio pass through untouched — there's no in-browser
 * transcode path that doesn't quadruple the upload time and we'd rather
 * the user pre-compress.
 */
export type UploadPreset = "original" | "1080w";

const TARGET_WIDTHS: Record<Exclude<UploadPreset, "original">, number> = {
  "1080w": 1080,
};

/** Best-effort: returns the resized File on success, original on any
 *  failure (decode error, unsupported MIME, smaller-than-target source). */
export async function resizeImageIfNeeded(file: File, preset: UploadPreset): Promise<File> {
  if (preset === "original") return file;
  if (!file.type.startsWith("image/")) return file;
  // SVG and GIF intentionally skipped — canvas would rasterize SVG and
  // flatten GIF animations, which is worse than uploading the source.
  if (file.type === "image/svg+xml" || file.type === "image/gif") return file;

  const target = TARGET_WIDTHS[preset];
  try {
    const bitmap = await createImageBitmap(file).catch(async () => {
      // Safari ≤16 lacks createImageBitmap for some formats; fall back to <img>.
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        return img;
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    const srcW = "width" in bitmap ? bitmap.width : (bitmap as HTMLImageElement).naturalWidth;
    const srcH = "height" in bitmap ? bitmap.height : (bitmap as HTMLImageElement).naturalHeight;
    if (!srcW || !srcH || srcW <= target) return file;

    const ratio = target / srcW;
    const dstW = target;
    const dstH = Math.round(srcH * ratio);

    const canvas = document.createElement("canvas");
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, dstW, dstH);

    const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const quality = outType === "image/jpeg" ? 0.85 : undefined;
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, outType, quality),
    );
    if (!blob) return file;
    // Skip if the "resized" output is somehow larger (rare; happens for
    // already-compressed JPEGs we re-encode less efficiently).
    if (blob.size >= file.size) return file;

    const baseName = file.name.replace(/\.[^.]+$/, "");
    const ext = outType === "image/png" ? "png" : "jpg";
    return new File([blob], `${baseName}.${ext}`, { type: outType, lastModified: Date.now() });
  } catch {
    return file;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = url;
  });
}
