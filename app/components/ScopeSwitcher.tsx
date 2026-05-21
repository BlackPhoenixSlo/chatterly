"use client";

/**
 * ScopeSwitcher — dropdown for "all models" + one entry per session-bearing
 * account. Drives ScopeContext, which in turn drives the chat-list
 * fan-out, the SSE filter, and the X-Account-Id header.
 *
 * Lives in the TopNav next to the employee chip.
 */

import { useEffect, useRef, useState } from "react";

import { useScope } from "@/contexts/ScopeContext";
import { useActiveAccounts } from "@/hooks/useAccounts";
import { cn } from "@/lib/utils";

export default function ScopeSwitcher() {
  const { scope, setScope } = useScope();
  const accounts = useActiveAccounts();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const currentLabel =
    scope.kind === "all"
      ? "all models"
      : accounts.find((a) => a.id === scope.accountId)?.nickname || scope.accountId;
  const currentColor =
    scope.kind === "all"
      ? "#a78bfa"
      : accounts.find((a) => a.id === scope.accountId)?.color || "#666";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-bg-elev-1 hover:bg-bg-elev-2 border border-border"
      >
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: currentColor }}
        />
        <span className="text-xs">{currentLabel}</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 w-56 bg-panel border border-border rounded-lg shadow-lg overflow-hidden z-40">
          <ScopeOption
            label="All models"
            color="#a78bfa"
            active={scope.kind === "all"}
            onClick={() => { setScope({ kind: "all" }); setOpen(false); }}
          />
          <div className="h-px bg-border" />
          {accounts.map((a) => (
            <ScopeOption
              key={a.id}
              label={a.nickname || a.id}
              color={a.color || "#666"}
              active={scope.kind === "model" && scope.accountId === a.id}
              onClick={() => { setScope({ kind: "model", accountId: a.id }); setOpen(false); }}
            />
          ))}
          {accounts.length === 0 && (
            <div className="p-3 text-xs text-fg-dim">
              No accounts with sessions. Bootstrap one in /setup.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScopeOption({
  label, color, active, onClick,
}: { label: string; color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full px-3 py-2 flex items-center gap-2 text-left text-sm hover:bg-bg-elev-1",
        active && "bg-bg-elev-1/60",
      )}
    >
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="truncate flex-1">{label}</span>
      {active && <span className="text-[10px] text-fg-dim">●</span>}
    </button>
  );
}
