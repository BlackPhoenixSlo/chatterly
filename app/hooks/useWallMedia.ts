"use client";

/**
 * useWallMedia — set of vault media ids that appear in the model's wall
 * posts. Drives the blue "posted on wall" ring in the VaultPicker.
 *
 * The backend walks OF's /users/{my_id}/posts paged feed up to 5 pages
 * (~250 posts) by default. Cached locally for an hour and persisted via
 * the PersistQueryClient layer so popout windows + repeat opens are
 * instant. We expose the result as a Set for O(1) lookup per tile.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { relay } from "@/lib/relay";

interface WallMediaResp {
  media_ids: number[];
  scanned_posts: number;
  has_more: boolean;
}

export function useWallMedia(accountId: string | null, enabled = true) {
  const q = useQuery<WallMediaResp>({
    queryKey: ["wall-media", accountId],
    enabled: enabled && !!accountId,
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams({ account_id: accountId! });
      // Forward AbortSignal so qc.cancelQueries during folder switches
      // tears down the in-flight 15s post-walk and frees the per-account
      // proxy slot for the new vault-media call.
      return relay.get<WallMediaResp>(
        `/admin/vault/wall-media?${qs.toString()}`,
        undefined,
        signal,
      );
    },
    // 1h is plenty — wall content doesn't churn minute-by-minute and the
    // user can force a fresh scan via the picker's refresh button.
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // O(1) membership lookup. Memoize so the Set identity is stable across
  // re-renders that don't change the underlying array.
  const set = useMemo(
    () => new Set<number>(q.data?.media_ids ?? []),
    [q.data?.media_ids],
  );

  return {
    set,
    scanned: q.data?.scanned_posts ?? 0,
    hasMore: !!q.data?.has_more,
    isLoading: q.isLoading,
    refresh: () => q.refetch(),
  };
}
