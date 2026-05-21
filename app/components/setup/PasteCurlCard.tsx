"use client";

/**
 * PasteCurlCard — the primary bootstrap path.
 *
 * User installs the Chatterly Login (or No-Teleport Login) browser extension,
 * signs in to OF, clicks "Copy curl," and pastes the result here. We POST it
 * to /admin/session/bootstrap with `mode: 'paste-curl'`. The relay parses
 * cookies + signed headers + the `x-relay-static-param` extension header to
 * derive signing rules for the current OF revision.
 *
 * Optional fields:
 *   • Proxy to attach — drop-down of registered proxies; we surface a
 *     teleport-warning confirm since cookies are minted on the user's home
 *     IP and outbound traffic now routes through the proxy. (Plan §13.3.)
 *   • Advanced override — manual static_param for a brand-new OF rev we
 *     haven't seen, fallback if the extension didn't capture it. Hidden
 *     by default under a <details>.
 *
 * Result panel shows the parsed response so you can see the new account_id
 * + which session file was written.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { relay, type BootstrapResponse, type ProxyMeta, RelayError } from "@/lib/relay";
import { Badge, Button, Card, Input, Textarea } from "@/components/ui/primitives";

interface ProxiesResp {
  proxies: ProxyMeta[];
}

interface BootstrapBody {
  mode: "paste-curl";
  curl: string;
  nickname?: string;
  make_active?: boolean;
  static_param_override?: string;
}

export default function PasteCurlCard() {
  const qc = useQueryClient();
  const [curl, setCurl] = useState("");
  const [nickname, setNickname] = useState("");
  const [makeActive, setMakeActive] = useState(true);
  const [proxyLabel, setProxyLabel] = useState("");
  const [staticOverride, setStaticOverride] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const proxiesQ = useQuery<ProxiesResp>({
    queryKey: ["proxies", "list"],
    queryFn: () => relay.get<ProxiesResp>("/admin/proxies"),
    staleTime: 60_000,
  });

  const bootstrapM = useMutation<BootstrapResponse, RelayError, BootstrapBody>({
    mutationFn: (body) => relay.post<BootstrapResponse>("/admin/session/bootstrap", body),
  });

  const attachProxyM = useMutation({
    mutationFn: ({ label, account_id }: { label: string; account_id: string }) =>
      relay.post<unknown>("/admin/proxies/assign", { label, account_id }),
  });

  const reloadM = useMutation({
    mutationFn: (account_id: string) =>
      relay.post<unknown>(`/admin/reload-session?account_id=${encodeURIComponent(account_id)}`),
  });

  async function submit() {
    setResult(null);
    if (!curl.trim().startsWith("curl")) {
      setResult({ ok: false, text: "Must start with `curl ...`" });
      return;
    }
    if (proxyLabel) {
      const confirmed = window.confirm(
        `Attach proxy "${proxyLabel}" to this account?\n\n` +
        `OnlyFans will see every signed call egress from the proxy IP. The ` +
        `cookies you're pasting were minted from your own browsing IP, so ` +
        `OF effectively sees the account "teleport" to the proxy. Only safe ` +
        `when the proxy IP is geographically/ASN-close to where you logged in.\n\n` +
        `OK to attach. Cancel to bootstrap with no proxy.`,
      );
      if (!confirmed) return;
    }

    const body: BootstrapBody = {
      mode: "paste-curl",
      curl,
      make_active: makeActive,
    };
    if (nickname.trim()) body.nickname = nickname.trim();
    if (staticOverride.trim()) body.static_param_override = staticOverride.trim();

    try {
      const data = await bootstrapM.mutateAsync(body);
      // If a proxy was chosen, attach + reload after success.
      if (proxyLabel && data.account_id) {
        try {
          await attachProxyM.mutateAsync({ label: proxyLabel, account_id: data.account_id });
          await reloadM.mutateAsync(data.account_id);
        } catch (err) {
          setResult({
            ok: true,
            text:
              `Session captured (account ${data.account_id}), but proxy attach failed:\n` +
              `${(err as Error).message}\n\nAttach manually under Setup → Proxies.`,
          });
          return;
        }
      }
      setResult({
        ok: true,
        text:
          `✓ Bootstrapped account ${data.account_id} (user_id ${data.user_id})\n` +
          `Session file: ${data.session_file}\n` +
          `x-of-rev: ${data.x_of_rev}`,
      });
      setCurl("");
      // Invalidate every caches that depends on accounts/proxies.
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["proxies"] });
      qc.invalidateQueries({ queryKey: ["drift"] });
      qc.invalidateQueries({ queryKey: ["health-all"] });
    } catch (err) {
      const e = err as RelayError;
      setResult({
        ok: false,
        text:
          `${e.status} FAILED\n\n` +
          (typeof e.body === "string" ? e.body : JSON.stringify(e.body, null, 2)),
      });
    }
  }

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-base font-semibold mb-1">Paste cURL</h2>
        <p className="text-sm text-fg-dim leading-relaxed">
          Install the <strong>Chatterly Login</strong> extension (in
          {" "}<code>loginExtension/</code>), sign in to OnlyFans, click
          {" "}<strong>Copy cURL</strong>, and paste here. The extension injects
          {" "}<code>x-relay-static-param</code> so this works on any new OF
          revision without re-running an Incogniton bootstrap.
        </p>
      </div>

      <Textarea
        rows={6}
        placeholder="curl 'https://onlyfans.com/api2/v2/...' -H 'sign: …' -H 'time: …' -H 'user-id: …' -H 'x-bc: …' -H 'x-of-rev: …' -H 'x-relay-static-param: …' -b 'auth_id=…; sess=…; …'"
        value={curl}
        onChange={(e) => setCurl(e.target.value)}
      />

      {/* Optional fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-fg-dim mb-1">Nickname (optional)</label>
          <Input
            placeholder="e.g. Bella, Mia, Test-burner"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-fg-dim mb-1">Attach proxy (optional)</label>
          <select
            value={proxyLabel}
            onChange={(e) => setProxyLabel(e.target.value)}
            className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent"
          >
            <option value="">— none (relay egresses on server WAN IP) —</option>
            {(proxiesQ.data?.proxies || []).map((p) => (
              <option key={p.label} value={p.label}>
                {p.label} · {p.host}:{p.port}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-fg-dim">
        <input
          type="checkbox"
          checked={makeActive}
          onChange={(e) => setMakeActive(e.target.checked)}
          className="accent-accent"
        />
        Flip this account to the relay&apos;s default after bootstrap
      </label>

      {proxyLabel && (
        <div className="text-[11px] text-warn bg-warn/10 border border-warn/30 rounded-lg p-3 leading-relaxed">
          ⚠ <strong>Teleport warning:</strong> the curl&apos;s cookies were minted
          from <em>your</em> browsing IP. Attaching this proxy makes every signed
          call afterwards egress from the proxy IP — OF sees the account hop
          continents. Only safe when the proxy IP is geographically close to
          your sign-in IP.
        </div>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-fg-dim hover:text-fg">
          advanced: override <code>static_param</code> (only if you&apos;re on an
          OF revision we haven&apos;t seen and the extension didn&apos;t inject one)
        </summary>
        <Input
          placeholder="static_param (32 chars; usually leave blank)"
          value={staticOverride}
          onChange={(e) => setStaticOverride(e.target.value)}
          className="mt-2 font-mono"
        />
      </details>

      <Button
        type="button"
        onClick={submit}
        disabled={!curl.trim() || bootstrapM.isPending}
      >
        {bootstrapM.isPending ? "Bootstrapping…" : "Bootstrap from cURL"}
      </Button>

      {/* Result panel */}
      {result && (
        <pre
          className={
            "bg-bg-elev-1 border border-border rounded-lg p-3 text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-60 " +
            (result.ok ? "text-ok" : "text-err")
          }
        >
          {result.text}
        </pre>
      )}
    </Card>
  );
}
