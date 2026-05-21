"use client";

/**
 * AccountPicker — a small dropdown the New-post / New-mass-message
 * modals use to choose which model account to send AS. Defers to the
 * current ScopeContext when scope is a single account; otherwise lets
 * the user pick from the active-sessions list.
 *
 * Lives under /compose/ rather than the chat sidebar because both
 * composers reuse it and neither is "chat" exactly.
 */

import { useEffect } from "react";

import { useActiveAccounts } from "@/hooks/useAccounts";
import { useScope } from "@/contexts/ScopeContext";

export function AccountPicker({
  value, onChange,
}: { value: string | null; onChange: (id: string) => void }) {
  const accounts = useActiveAccounts();
  const { scope } = useScope();

  // Auto-seed the first time. In single-account scope this just sticks
  // to that account; in unified scope we pick the first session-bearing
  // model so the modal isn't blocked by an empty selection.
  useEffect(() => {
    if (value) return;
    const seed = scope.kind === "model" ? scope.accountId : accounts[0]?.id;
    if (seed) onChange(seed);
  }, [value, scope, accounts, onChange]);

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-fg-dim">Post as:</label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-bg border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
      >
        {accounts.length === 0 && <option value="">(no active sessions)</option>}
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.nickname || a.id}
          </option>
        ))}
      </select>
    </div>
  );
}
