"use client";

/**
 * /settings — team management.
 *
 * Tabs:
 *   • Employees — CRUD the picker roster
 *   • Audit log — read-only view of every audited mutation
 *
 * Future tabs (Phase D): Grok prompts, Vault presets, retention policy.
 */

import { useState } from "react";

import EmployeesTab from "@/components/settings/EmployeesTab";
import AuditTab from "@/components/settings/AuditTab";
import TemplatesTab from "@/components/settings/TemplatesTab";
import ScheduledTab from "@/components/settings/ScheduledTab";
import { cn } from "@/lib/utils";

type Tab = "employees" | "templates" | "scheduled" | "audit";

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("employees");

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-5">
      <header>
        <h1 className="text-2xl font-semibold mb-1">Settings</h1>
        <p className="text-sm text-fg-dim">Team roster + audit history.</p>
      </header>

      <nav className="flex items-center gap-1 border-b border-border">
        <TabBtn active={tab === "employees"} onClick={() => setTab("employees")}>
          Employees
        </TabBtn>
        <TabBtn active={tab === "templates"} onClick={() => setTab("templates")}>
          Templates
        </TabBtn>
        <TabBtn active={tab === "scheduled"} onClick={() => setTab("scheduled")}>
          Scheduled
        </TabBtn>
        <TabBtn active={tab === "audit"} onClick={() => setTab("audit")}>
          Audit log
        </TabBtn>
      </nav>

      {tab === "employees" && <EmployeesTab />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "scheduled" && <ScheduledTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

function TabBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-4 py-2 text-sm border-b-2 -mb-px transition-colors",
        active
          ? "border-accent text-fg"
          : "border-transparent text-fg-dim hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
