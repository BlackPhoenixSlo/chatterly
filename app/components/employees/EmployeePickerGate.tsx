"use client";

/**
 * EmployeePickerGate — full-screen modal shown on first load until the
 * user picks who they are. Once picked, the gate unmounts and the rest
 * of the app renders.
 *
 * Two modes:
 *   • If the roster is empty (fresh install), show a "+ Create first
 *     employee" inline form.
 *   • Otherwise, show colored cards for each active employee. Click =
 *     pick. Pressing the keyboard shortcut (1-9) jumps to the matching
 *     employee — power-user feature for the daily handoff.
 *
 * Wraps {children}: when no employee is picked → gate is visible and
 * children are hidden behind it. When an employee is picked → gate is
 * hidden and children render normally.
 *
 * Server-renders nothing (the entire flow needs localStorage + the
 * roster fetch), so we render a quiet placeholder during hydration.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useEmployee } from "@/contexts/EmployeeContext";
import { relay, type Employee } from "@/lib/relay";
import { cn } from "@/lib/utils";

interface EmployeesResponse { employees: Employee[]; }

export default function EmployeePickerGate({ children }: { children: React.ReactNode }) {
  const { current, roster, setRoster, pick, hydrated, pickedId } = useEmployee();
  const qc = useQueryClient();

  // Fetch the roster. Refetched on window-focus is off globally; we
  // explicitly invalidate after create/disable mutations below.
  const query = useQuery<EmployeesResponse>({
    queryKey: ["employees", "all"],
    queryFn: () => relay.get<EmployeesResponse>("/admin/employees?include_disabled=true"),
    // The picker is the very first thing rendered; we want a fast spinner,
    // not a 5-min stale guarantee. Override the global default here.
    staleTime: 0,
  });

  // Sync the fetched roster into context so other components (top-bar
  // chip, settings page) can read it without re-fetching.
  useEffect(() => {
    if (query.data?.employees) setRoster(query.data.employees);
  }, [query.data, setRoster]);

  // Keyboard shortcut: 1-9 picks the Nth active employee. Off by default
  // while a form is focused so it doesn't fire mid-typing.
  useEffect(() => {
    if (current) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const n = parseInt(e.key, 10);
      if (Number.isNaN(n) || n < 1 || n > 9) return;
      const active = roster.filter((r) => r.is_active);
      if (n <= active.length) pick(active[n - 1].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [current, roster, pick]);

  // SSR / hydration: render nothing until we've checked localStorage.
  // Avoids a flicker of the picker on a page where you're already logged in.
  if (!hydrated) {
    return <div className="min-h-screen flex items-center justify-center text-fg-dim">…</div>;
  }

  // Logged in already → render the app.
  if (current) return <>{children}</>;

  // Persisted pick exists but `current` isn't resolved yet — either
  // the roster query hasn't landed or its sync-into-context effect
  // hasn't run yet. Without this, the gate would render the full
  // picker UI for one frame on every popout open (visible as a "pick
  // creator" flash before the chat appears). Wait quietly. If the
  // roster *does* land and pickedId isn't in it (deleted/disabled
  // employee), `current` will stay null and `roster.length > 0` —
  // then we fall through to the picker so the user can re-pick.
  if (pickedId !== null && !current && (query.isLoading || roster.length === 0)) {
    return <div className="min-h-screen flex items-center justify-center text-fg-dim">…</div>;
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/95 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-panel border border-border rounded-2xl p-6 shadow-2xl">
        <h1 className="text-lg font-semibold mb-1">Who&apos;s chatting?</h1>
        <p className="text-sm text-fg-dim mb-5">
          Click your name. We&apos;ll log every action under you so the team can keep
          an honest history. No password — pick again from the top bar to switch.
        </p>

        {query.isLoading && (
          <div className="text-fg-dim text-sm py-8 text-center">Loading roster…</div>
        )}
        {query.error && (
          <div className="text-err text-sm py-4">
            Couldn&apos;t reach the relay. Make sure it&apos;s running at <code>localhost:8787</code>.
          </div>
        )}

        {query.data && (
          <EmployeeList employees={query.data.employees} onPick={pick} onCreated={() => qc.invalidateQueries({ queryKey: ["employees"] })} />
        )}
      </div>
    </div>
  );
}

function EmployeeList({
  employees,
  onPick,
  onCreated,
}: {
  employees: Employee[];
  onPick: (id: number) => void;
  onCreated: () => void;
}) {
  const active = employees.filter((e) => e.is_active);

  if (active.length === 0) {
    return <CreateFirstEmployee onCreated={onCreated} />;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {active.map((e, idx) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onPick(e.id)}
            className={cn(
              "group flex items-center gap-3 px-4 py-3 rounded-xl",
              "bg-bg-elev-1 hover:bg-bg-elev-2 border border-border hover:border-border-light",
              "transition-colors text-left",
            )}
          >
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ background: e.color || "#888" }}
              aria-hidden
            />
            <span className="flex-1 truncate">{e.display_name}</span>
            {idx < 9 && (
              <kbd className="text-[10px] text-muted bg-bg border border-border rounded px-1.5 py-0.5">
                {idx + 1}
              </kbd>
            )}
          </button>
        ))}
      </div>
      <details className="mt-6 group">
        <summary className="cursor-pointer text-xs text-fg-dim hover:text-fg">
          + Add a new employee
        </summary>
        <CreateFirstEmployee onCreated={onCreated} compact />
      </details>
    </>
  );
}

function CreateFirstEmployee({ onCreated, compact }: { onCreated: () => void; compact?: boolean }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#8b5cf6");

  const mutation = useMutation({
    mutationFn: (body: { display_name: string; color: string }) =>
      relay.post<Employee>("/admin/employees", body),
    onSuccess: () => {
      setName("");
      onCreated();
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate({ display_name: name.trim(), color });
  };

  return (
    <form onSubmit={onSubmit} className={cn("space-y-3", compact ? "mt-4" : "mt-2")}>
      {!compact && (
        <p className="text-sm text-fg-dim">
          No employees yet — let&apos;s add the first one.
        </p>
      )}
      <div className="flex items-center gap-2">
        <input
          autoFocus={!compact}
          type="text"
          placeholder="Name (e.g. Tim)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent"
        />
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="w-10 h-10 rounded-lg border border-border bg-bg cursor-pointer"
          aria-label="Color"
        />
      </div>
      <button
        type="submit"
        disabled={!name.trim() || mutation.isPending}
        className={cn(
          "w-full py-2 rounded-lg bg-accent hover:bg-accent-hover text-white font-medium text-sm",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        {mutation.isPending ? "Creating…" : "Create"}
      </button>
      {mutation.error && (
        <p className="text-err text-xs">{(mutation.error as Error).message}</p>
      )}
    </form>
  );
}
