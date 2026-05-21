"use client";

/**
 * Home — Phase A.8 ships this as a thin "you're in!" landing page that
 * proves the full chain (employee picker → providers → relay → DB).
 *
 * Renders the current employee + a live status pill that reads /health.
 * Phase B replaces this with the Dashboard component (ported from the
 * desktop-app's Dashboard.tsx) once the data layer is fully wired.
 */

import { useQuery } from "@tanstack/react-query";

import { useEmployee } from "@/contexts/EmployeeContext";
import { useScope } from "@/contexts/ScopeContext";
import { relay } from "@/lib/relay";

interface HealthResp { ok?: boolean; name?: string; user_id?: number | string; error?: string }

export default function HomePage() {
  const { current, clear } = useEmployee();
  const { scope } = useScope();

  // Hit /health through the rewrite — confirms the relay is reachable
  // and the share-token gate is satisfied.
  const health = useQuery<HealthResp>({
    queryKey: ["health"],
    queryFn: () => relay.get<HealthResp>("/health"),
    refetchInterval: 30_000,
    staleTime: 0,
  });

  return (
    <div className="min-h-screen p-8 max-w-3xl mx-auto">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full"
            style={{ background: current?.color || "#888" }}
          />
          <span className="text-sm">
            Chatting as <strong>{current?.display_name}</strong>
          </span>
          <button
            type="button"
            onClick={clear}
            className="text-xs text-fg-dim hover:text-fg underline underline-offset-2"
          >
            switch
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-dim">scope:</span>
          <code className="text-xs bg-bg-elev-1 border border-border rounded px-2 py-0.5">
            {scope.kind === "all" ? "all" : scope.accountId}
          </code>
        </div>
      </div>

      {/* Welcome card */}
      <div className="bg-panel border border-border rounded-2xl p-8 mb-6">
        <h1 className="text-2xl font-semibold mb-2">Chatterly is live</h1>
        <p className="text-fg-dim mb-6">
          Phase A complete: DB foundation, SSE pipeline, employee picker, audit log.
          The Next.js shell is up and talking to the Python relay through rewrites.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Pill
            label="Relay /health"
            value={
              health.isLoading ? "…" :
              health.error ? "down" :
              health.data?.ok ? `ok · ${health.data?.name ?? "no model"}` : "no session"
            }
            ok={!!health.data?.ok}
            err={!!health.error}
          />
          <Pill
            label="DB"
            value="SQLite · 35 tables"
            ok
          />
        </div>
      </div>

      {/* Coming next */}
      <div className="text-sm text-fg-dim space-y-1">
        <p>Next ports (Phase A.8 continued):</p>
        <ul className="list-disc list-inside pl-2">
          <li>Setup screen — paste cURL, accounts, proxies, drift banner</li>
          <li>Settings → Employees + Audit log</li>
        </ul>
      </div>
    </div>
  );
}

function Pill({ label, value, ok, err }: {
  label: string; value: string; ok?: boolean; err?: boolean;
}) {
  return (
    <div className="bg-bg-elev-1 border border-border rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-muted mb-1">{label}</div>
      <div className={
        err ? "text-err text-sm" :
        ok ? "text-ok text-sm font-medium" :
        "text-warn text-sm"
      }>
        {value}
      </div>
    </div>
  );
}
