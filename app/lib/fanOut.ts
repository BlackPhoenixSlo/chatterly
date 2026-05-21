/**
 * fanOut — shared helpers for the "send to all models" path used by
 * PostComposer + MassMessageComposer.
 *
 * The unit of work is one account: upload N files to that account's
 * vault (via /api/of/v2/upload), collect each upload's `send_with`
 * claims, then run a per-account submit callback with those claims as
 * the `media_files` argument.
 *
 * We deliberately serialize across accounts (one at a time): OF's
 * upload chain (hash → signed/create → S3 PUT → claim) hates parallel
 * hammering, and a 3-account fan-out finishes in seconds either way.
 * Files within an account also go sequentially — same reason.
 *
 * Errors are per-account: we collect them and let the caller render a
 * summary. One model failing doesn't roll back the others.
 */

import { relay } from "./relay";
import type { VaultUploadResp } from "./relay";

export interface FanOutResult {
  accountId: string;
  ok: boolean;
  error?: string;
}

/** Run `submit` for every active account, after uploading every File to
 *  that account's vault first. `submit` receives the media_files payload
 *  (mixed numeric ids + claim dicts) and the account id. */
export async function fanOutUpload(args: {
  accountIds: string[];
  files: File[];
  submit: (
    accountId: string,
    mediaFiles: Array<number | Record<string, unknown>>,
  ) => Promise<unknown>;
  /** Optional progress callback — called with (currentIndex, total) after
   *  each account finishes (success OR failure). */
  onProgress?: (current: number, total: number) => void;
}): Promise<FanOutResult[]> {
  const { accountIds, files, submit, onProgress } = args;
  const results: FanOutResult[] = [];

  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    try {
      const claims: Array<number | Record<string, unknown>> = [];
      for (const file of files) {
        const resp = await relay.uploadFile<VaultUploadResp>(
          "/api/of/v2/upload", file, "file", { accountId },
        );
        if (!resp.ready) {
          throw new Error(resp.note || `Upload incomplete for ${file.name}`);
        }
        for (const entry of resp.send_with ?? []) claims.push(entry);
      }
      await submit(accountId, claims);
      results.push({ accountId, ok: true });
    } catch (err) {
      results.push({
        accountId,
        ok: false,
        error: (err as Error).message || "unknown error",
      });
    }
    onProgress?.(i + 1, accountIds.length);
  }
  return results;
}

/** One-line user-facing summary: "2 ok · 1 failed". */
export function summarizeFanOut(results: FanOutResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const bad = results.length - ok;
  if (bad === 0) return `All ${ok} accounts succeeded`;
  if (ok === 0) return `All ${bad} accounts failed`;
  return `${ok} ok · ${bad} failed`;
}
