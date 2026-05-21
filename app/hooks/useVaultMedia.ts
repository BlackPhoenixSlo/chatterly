"use client";

/**
 * useVaultMedia — paginated reader for the model's vault.
 *
 * Keys on (accountId, type, listId) so switching scope or filter swaps
 * cache cleanly. Pages are appended via loadMore so the user can scroll-
 * fetch in the picker. Returns merged list + hasMore + isLoading + error.
 *
 * No background polling — the vault is owner-managed, refresh is on demand.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relay, type VaultList, type VaultListsResp, type VaultMedia, type VaultMediaResp, type VaultUploadResp } from "@/lib/relay";

const PAGE = 24;

/** Upload a new file to the account's OF vault. After completion we
 *  invalidate every vault-media query for this account so the new item
 *  appears in the grid. Returns the upload response so the caller can
 *  read `vault_id` / `send_with` to auto-select the upload. */
export function useVaultUpload(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation<VaultUploadResp, Error, File>({
    mutationFn: (file: File) => {
      if (!accountId) throw new Error("missing accountId");
      return relay.uploadFile<VaultUploadResp>("/api/of/v2/upload", file, "file", { accountId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vault-media", accountId] });
      qc.invalidateQueries({ queryKey: ["vault-lists", accountId] });
    },
  });
}

/** Vault folders / lists. The model can put items into custom folders;
 *  this drives the picker's folder filter dropdown. OF requires `view=main`. */
export function useVaultLists(accountId: string | null, enabled = true) {
  return useQuery<VaultListsResp>({
    queryKey: ["vault-lists", accountId],
    enabled: enabled && !!accountId,
    queryFn: () =>
      relay.get<VaultListsResp>(
        "/api/of/v2/vault/lists?view=main&limit=50",
        { accountId: accountId ?? undefined },
      ),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    select: (d) => ({
      // Only show custom folders — the built-in pseudo-lists like Posts/Stories
      // are useless for picking media to send. media_stickers (Uploads) is
      // built-in too but we leave it; it's where freshly-uploaded items land.
      list: (d.list ?? []).filter((l: VaultList) => l.type === "custom" && l.hasMedia),
    }),
  });
}

export interface UseVaultMediaOpts {
  accountId: string | null;
  type?: "all" | "photo" | "video" | "gif" | "audio";
  listId?: number | null;
  enabled?: boolean;
}

export function useVaultMedia(opts: UseVaultMediaOpts) {
  const { accountId, type = "all", listId = null, enabled = true } = opts;
  const qc = useQueryClient();

  const q = useInfiniteQuery<VaultMediaResp>({
    queryKey: ["vault-media", accountId, type, listId],
    enabled: enabled && !!accountId,
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.hasMore ? all.length * PAGE : undefined,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE));
      params.set("offset", String(pageParam ?? 0));
      params.set("type", type);
      if (listId != null) params.set("list_id", String(listId));
      // Forward the abort signal so switching folder/type cancels the
      // previous page fetch instead of letting it land into a stale key.
      return relay.get<VaultMediaResp>(
        `/api/of/v2/vault/media?${params.toString()}`,
        { accountId: accountId ?? undefined },
        signal,
      );
    },
    staleTime: 60_000,
  });

  const items: VaultMedia[] = (q.data?.pages ?? []).flatMap((p) => p.list ?? []);
  return {
    items,
    hasMore: !!q.hasNextPage,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    isFetchingNextPage: q.isFetchingNextPage,
    error: q.error,
    loadMore: () => q.fetchNextPage(),
    /** Hard refresh — drops every cached page for this account's vault
     *  (any type/listId combo, the wall-media cache, and the lists cache)
     *  so the next render starts from a blank slate. The plain `q.refetch()`
     *  only refires the queries this hook owns; the picker switches the
     *  `type` chip a lot, so we want every adjacent cache nuked too. */
    refresh: () => {
      qc.removeQueries({ queryKey: ["vault-media", accountId] });
      qc.removeQueries({ queryKey: ["vault-lists", accountId] });
      qc.removeQueries({ queryKey: ["wall-media", accountId] });
      return q.refetch();
    },
  };
}
