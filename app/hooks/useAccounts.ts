"use client";

/**
 * useAccounts — list of model accounts with sessions.
 *
 * Phase B drives the Unified Inbox fan-out. When ScopeContext is `all`,
 * we fan a chat-list query out across every account here and merge
 * client-side. Per-account scope just filters this list down to one.
 *
 * Source of truth: `GET /admin/accounts` on the relay. We KEEP the
 * `{accounts, active_account_id}` envelope as the cached shape because
 * AccountsTable in /setup uses the same query key — sharing the cache
 * means one fetch powers both screens.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { relay, type AccountMeta } from "@/lib/relay";

export interface AccountsResp {
  accounts: AccountMeta[];
  active_account_id: string | null;
}

export function useAccounts() {
  return useQuery<AccountsResp>({
    queryKey: ["accounts"],
    queryFn: () => relay.get<AccountsResp>("/admin/accounts"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Accounts that currently have a captured session — the only ones the
 *  relay can scope to. Used by the chat-list fan-out (no point querying
 *  /chats for an account with no session — it'll 503).
 *
 *  Memoized on the underlying accounts array so the returned reference is
 *  stable when the data hasn't changed. Without this, consumers using the
 *  result in `useEffect` / `useMemo` deps see a new reference every render
 *  — e.g. the inbox warmer effect was cancelling and restarting on each
 *  parent render, and the spend/activity memos were never hitting. */
export function useActiveAccounts(): AccountMeta[] {
  const q = useAccounts();
  const all = q.data?.accounts;
  return useMemo(
    () => (all ?? []).filter((a) => a.has_session),
    [all],
  );
}
