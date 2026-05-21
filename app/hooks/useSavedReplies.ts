"use client";

/**
 * useSavedReplies — CRUD for local-DB saved replies.
 *
 * OF's /messages/templates rejects creates for everything except the
 * welcome slot, so saved replies live in our SQLite (via relay's
 * /admin/saved-replies/* routes). The welcome message stays on OF —
 * see useTemplates for that path.
 *
 * Per-account list. UI merges these with the OF welcome at render time.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relay, type SavedReply } from "@/lib/relay";

const KEY = "saved-replies";

interface ListResp {
  list: SavedReply[];
}

export function useSavedReplies(accountId: string | null) {
  return useQuery<SavedReply[]>({
    queryKey: [KEY, accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const resp = await relay.get<ListResp>(
        `/admin/saved-replies?account_id=${encodeURIComponent(accountId!)}`,
      );
      return resp.list ?? [];
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export interface SavedReplyDraft {
  title?: string | null;
  text: string;
  price?: number;
  lockedText?: boolean;
  media?: SavedReply["media"];
}

function toWire(d: SavedReplyDraft) {
  return {
    title: d.title ?? null,
    text: d.text,
    price: d.price ?? 0,
    locked_text: d.lockedText ?? false,
    media: d.media ?? [],
  };
}

export function useCreateSavedReply(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation<SavedReply, Error, SavedReplyDraft>({
    mutationFn: (draft) =>
      relay.post<SavedReply>(
        `/admin/saved-replies?account_id=${encodeURIComponent(accountId ?? "")}`,
        toWire(draft),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, accountId] }),
  });
}

export function useUpdateSavedReply(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation<SavedReply, Error, { id: number } & SavedReplyDraft>({
    mutationFn: ({ id, ...draft }) =>
      relay.put<SavedReply>(`/admin/saved-replies/${id}`, toWire(draft)),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, accountId] }),
  });
}

export function useDeleteSavedReply(accountId: string | null) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, number>({
    mutationFn: (id) => relay.delete(`/admin/saved-replies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, accountId] }),
  });
}
