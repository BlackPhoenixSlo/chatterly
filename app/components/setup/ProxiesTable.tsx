"use client";

/**
 * ProxiesTable — every proxy in the registry, with assignment + test.
 *
 * Powered by:
 *   GET  /admin/proxies          list + assignments enriched with account meta
 *   POST /admin/proxies/assign   bind a proxy to an account_id (or null to unassign)
 *   POST /admin/proxies/{label}/test   egress-IP check
 *
 * Phase A keeps the proxy create/edit on the legacy /ui/ page; we add it
 * here in Phase B when we replace the legacy UI entirely.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { relay, type ProxyMeta, type AccountMeta } from "@/lib/relay";
import { Badge, Button, Card } from "@/components/ui/primitives";

interface ProxiesResp {
  proxies: Array<ProxyMeta & { assigned_account?: { id: string; nickname?: string | null } | null }>;
  accounts: AccountMeta[];
}

export default function ProxiesTable() {
  const qc = useQueryClient();

  const proxiesQ = useQuery<ProxiesResp>({
    queryKey: ["proxies"],
    queryFn: () => relay.get<ProxiesResp>("/admin/proxies"),
    staleTime: 60_000,
  });

  const assignM = useMutation({
    mutationFn: ({ label, account_id }: { label: string; account_id: string | null }) =>
      relay.post<unknown>("/admin/proxies/assign", { label, account_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const testM = useMutation({
    mutationFn: (label: string) =>
      relay.post<{ ok: boolean; egress_ip?: string; error?: string }>(
        `/admin/proxies/${encodeURIComponent(label)}/test`,
      ),
  });

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Proxies</h2>
        <Badge color="muted">{proxiesQ.data?.proxies.length ?? "…"} configured</Badge>
      </div>

      {proxiesQ.isLoading && (
        <div className="text-fg-dim text-sm py-6">Loading proxies…</div>
      )}
      {proxiesQ.error && (
        <div className="text-err text-sm py-3">{(proxiesQ.error as Error).message}</div>
      )}

      {proxiesQ.data && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-fg-dim text-xs border-b border-border">
                <th className="px-3 py-2 font-medium">Label</th>
                <th className="px-3 py-2 font-medium">Host</th>
                <th className="px-3 py-2 font-medium">Bound to</th>
                <th className="px-3 py-2 font-medium">Egress / verified</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {proxiesQ.data.proxies.map((p) => (
                <ProxyRow
                  key={p.label}
                  proxy={p}
                  accounts={proxiesQ.data!.accounts}
                  onAssign={(account_id) => assignM.mutate({ label: p.label, account_id })}
                  onTest={() => testM.mutate(p.label)}
                  testResult={testM.variables === p.label ? testM.data : undefined}
                  testing={testM.isPending && testM.variables === p.label}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ProxyRow({
  proxy, accounts, onAssign, onTest, testResult, testing,
}: {
  proxy: ProxiesResp["proxies"][number];
  accounts: AccountMeta[];
  onAssign: (account_id: string | null) => void;
  onTest: () => void;
  testResult?: { ok: boolean; egress_ip?: string; error?: string };
  testing: boolean;
}) {
  const bound = proxy.assigned_account;
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{proxy.label}</span>
          <Badge color="muted">{proxy.scheme}</Badge>
        </div>
      </td>
      <td className="px-3 py-3 font-mono text-xs text-fg-dim">
        {proxy.host}:{proxy.port}
      </td>
      <td className="px-3 py-3">
        <select
          value={bound?.id ?? ""}
          onChange={(e) => onAssign(e.target.value || null)}
          className="bg-bg border border-border rounded-md px-2 py-1 text-xs"
        >
          <option value="">— unassigned —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nickname || a.id}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-3 text-xs">
        {testResult ? (
          testResult.ok ? (
            <Badge color="ok">{testResult.egress_ip}</Badge>
          ) : (
            <Badge color="err">{testResult.error || "failed"}</Badge>
          )
        ) : (
          <span className="font-mono text-fg-dim">
            {proxy.verified_ip || "—"}
          </span>
        )}
      </td>
      <td className="px-3 py-3">
        <Button variant="ghost" size="sm" disabled={testing} onClick={onTest}>
          {testing ? "Testing…" : "Test"}
        </Button>
      </td>
    </tr>
  );
}
