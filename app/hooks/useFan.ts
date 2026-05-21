"use client";

/**
 * useFan — fan profile row from our SQLite (NOT OF).
 *
 * The OF chat-list already gives us display_name + avatar; we use this
 * hook for the chatter-owned overlay: custom_nickname, notes, tags,
 * lifetime_spend, plus future Grok-filled facts (real_name, country, …).
 *
 * `GET /admin/fans/{account_id}/{fan_id}` auto-creates a stub row on
 * first access — no 404 dance.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relay, type FanRecord, type FanUpdate, type OFUserMini } from "@/lib/relay";

export function useFan(accountId: string | null, fanId: number | null) {
  const qc = useQueryClient();
  const queryKey = ["fan", accountId, fanId] as const;

  const q = useQuery<FanRecord>({
    queryKey,
    enabled: !!accountId && fanId != null,
    queryFn: () =>
      relay.get<FanRecord>(`/admin/fans/${accountId}/${fanId}`),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const update = useMutation({
    mutationFn: (patch: FanUpdate) =>
      relay.patch<FanRecord>(`/admin/fans/${accountId}/${fanId}`, patch),
    onSuccess: (next) => {
      qc.setQueryData(queryKey, next);
      // Also push the new nickname into the per-fan profile cache that
      // ChatList rows + group panes observe. Without this, editing the
      // nickname only updates the surface header (which reads `fan`
      // directly) — the rail label keeps the old value until the next
      // /users/list refetch restitches it from SQLite.
      if (accountId && fanId != null) {
        qc.setQueryData<OFUserMini>(
          ["of-user", accountId, fanId],
          (prev) => ({
            ...(prev ?? { id: fanId }),
            customNickname: next.custom_nickname ?? null,
          }),
        );
      }
    },
  });

  return { ...q, update };
}
