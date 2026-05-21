"use client";

/**
 * MassMessageComposer — modal for broadcasting a single message to many
 * fans via POST /api/of/v2/messages/queue. With `scheduled_date` the
 * relay routes to schedule_mass_message; without it, send_mass_message
 * fires immediately.
 *
 * Audience mirrors the desktop app: include vs exclude columns. Include
 * accepts any combination of OF's five system audiences (fans / recent /
 * following / rebill_off / tagged) and any of the model's custom fan
 * lists. Exclude is custom-lists-only (OF doesn't accept system audience
 * names in excludeUserLists).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAccounts } from "@/hooks/useAccounts";
import { relay, type VaultMedia } from "@/lib/relay";
import { VaultPicker } from "@/components/chat/VaultPicker";
import { localDatetimeToIso, recordSchedule } from "@/lib/scheduleHistory";
import { fanOutUpload, type FanOutResult, summarizeFanOut } from "@/lib/fanOut";

import { AccountPicker } from "./AccountPicker";
import { MediaTray } from "./MediaTray";
import { AllModelsMediaTray } from "./AllModelsMediaTray";
import { ScheduleField } from "./ScheduleField";

interface FanList {
  id: number | string;
  name?: string;
  /** OF tags lists as 'custom' or 'build-in' (sic) — case-spelling varies. */
  type?: string;
  usersCount?: number;
}
/** OF returns either `{list:[…]}` or a bare array depending on params. */
type ListsResp = { list?: FanList[]; hasMore?: boolean } | FanList[];

/** OF-recognised virtual audience IDs. The /lists endpoint does NOT
 *  return these — they're hardcoded server-side names that `userLists`
 *  accepts. We expose the three OF guarantees on every account: All
 *  fans / Following / Online. The desktop app advertises five (adding
 *  `recent` and `tagged`) but those depend on per-account state and
 *  silently no-op when empty, so we hide them to keep the UI honest. */
const SYSTEM_AUDIENCES: Array<{ id: string; label: string }> = [
  { id: "fans",      label: "All fans"  },
  { id: "following", label: "Following" },
  { id: "online",    label: "Online"    },
];

/** Names that should float to the top of the custom-list columns, in
 *  this priority order. Exact lowercase match only — a list named
 *  "fans" sorts first, but variations like "allFans" / "All fans"
 *  stay in alphabetical so they don't crowd the top. */
const TOP_LIST_NAMES: string[] = [
  "fans",
  "following",
  "online",
];

function topRank(name: string): number {
  const i = TOP_LIST_NAMES.indexOf(name.toLowerCase());
  return i === -1 ? TOP_LIST_NAMES.length : i;
}

export function MassMessageComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const activeAccounts = useActiveAccounts();
  const [allModels, setAllModels] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [text, setText] = useState("");
  // Single-account: VaultMedia[] (mix of picked vault items + uploads).
  // All-models: File[] — uploads happen per-account at submit time.
  const [attached, setAttached] = useState<VaultMedia[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [price, setPrice] = useState<string>("");
  const [lockedText, setLockedText] = useState(false);
  const [includes, setIncludes] = useState<Set<string>>(new Set());
  const [excludes, setExcludes] = useState<Set<string>>(new Set());
  const [schedule, setSchedule] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<FanOutResult[] | null>(null);

  const listsQ = useQuery<FanList[]>({
    queryKey: ["fan-lists", accountId ?? ""],
    enabled: !!accountId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await relay.get<ListsResp>(
        "/api/of/v2/lists?limit=50",
        { accountId: accountId! },
      );
      return Array.isArray(r) ? r : (r?.list ?? []);
    },
  });

  const customLists = useMemo(() => {
    const filtered = (listsQ.data ?? []).filter(
      (l) => l.type !== "build-in" && l.type !== "built-in",
    );
    // Sort: Fans → Following → Online first (mirrors system-audience
    // order), then alphabetical for everything else. Catches lists the
    // user manually re-created under those names too.
    return filtered.slice().sort((a, b) => {
      const an = (a.name ?? "").toLowerCase();
      const bn = (b.name ?? "").toLowerCase();
      const ra = topRank(an);
      const rb = topRank(bn);
      if (ra !== rb) return ra - rb;
      return an.localeCompare(bn);
    });
  }, [listsQ.data]);

  // A list shouldn't be in include AND exclude simultaneously — toggling
  // one auto-removes the other to keep the UI consistent.
  function toggleInclude(id: string) {
    setIncludes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setExcludes((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }
  function toggleExclude(id: string) {
    setExcludes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setIncludes((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** System-audience chips are tri-state: off → include → exclude → off.
   *  Lets the user say "All fans BUT NOT Following" with one click each
   *  instead of needing two parallel chip strips. */
  function cycleSystem(id: string) {
    if (includes.has(id)) {
      // include → exclude
      setIncludes((prev) => {
        const next = new Set(prev); next.delete(id); return next;
      });
      setExcludes((prev) => new Set(prev).add(id));
    } else if (excludes.has(id)) {
      // exclude → off
      setExcludes((prev) => {
        const next = new Set(prev); next.delete(id); return next;
      });
    } else {
      // off → include
      setIncludes((prev) => new Set(prev).add(id));
    }
  }

  // When the account changes, clear audience selections — the prior set
  // was scoped to a different model's lists.
  useEffect(() => {
    setIncludes(new Set());
    setExcludes(new Set());
  }, [accountId]);

  // All-models mode tosses custom-list selections and any previously
  // picked vault media — they don't translate across accounts.
  useEffect(() => {
    if (allModels) {
      setAccountId(null);
      setAttached([]);
      // Drop any custom-list ids; keep only system audiences (fans/
      // following/online) which are identical across every account.
      setIncludes((prev) => {
        const next = new Set<string>();
        for (const id of prev) if (SYSTEM_AUDIENCES.some((s) => s.id === id)) next.add(id);
        return next;
      });
      setExcludes(new Set());
    } else {
      setAttachedFiles([]);
    }
  }, [allModels]);

  // Shared per-account submit: builds the body, POSTs, optionally records
  // the schedule pick on success.
  async function submitOne(
    forAccountId: string,
    mediaFiles: Array<number | Record<string, unknown>>,
    scheduledIso: string | null,
  ) {
    const priceNum = price ? Number(price) : 0;
    const resp = await relay.post(
      "/api/of/v2/messages/queue",
      {
        text: text.trim(),
        scheduled_date: scheduledIso,
        user_lists: Array.from(includes),
        user_ids: [],
        excluded_users: [],
        excluded_user_lists: Array.from(excludes),
        price: priceNum,
        locked_text: lockedText && priceNum > 0,
        media_files: mediaFiles,
      },
      { accountId: forAccountId },
    );
    if (schedule) recordSchedule(forAccountId, schedule);
    return resp;
  }

  const send = useMutation({
    mutationFn: async () => {
      const trimmed = text.trim();
      if (allModels) {
        if (activeAccounts.length === 0) throw new Error("No active models");
      } else {
        if (!accountId) throw new Error("Pick an account");
      }
      const totalMedia = allModels ? attachedFiles.length : attached.length;
      if (!trimmed && totalMedia === 0) throw new Error("Add text or media");
      if (includes.size === 0) throw new Error("Pick at least one audience list to include");
      const priceNum = price ? Number(price) : 0;
      if (!Number.isFinite(priceNum) || priceNum < 0) throw new Error("Invalid price");
      const scheduledIso = schedule ? localDatetimeToIso(schedule) : null;
      if (schedule && !scheduledIso) throw new Error("Invalid schedule date");

      if (allModels) {
        // Fan-out: upload each file to every account, then submit with
        // that account's claim payload.
        const accountIds = activeAccounts.map((a) => a.id);
        setProgress(`Sending to 0 / ${accountIds.length}…`);
        const fanResults = await fanOutUpload({
          accountIds,
          files: attachedFiles,
          submit: (aid, mediaFiles) => submitOne(aid, mediaFiles, scheduledIso),
          onProgress: (cur, total) => setProgress(`Sending to ${cur} / ${total}…`),
        });
        setResults(fanResults);
        setProgress(null);
        if (fanResults.every((r) => r.ok)) return fanResults;
        throw new Error(summarizeFanOut(fanResults));
      }

      // Single-account path: mixed payload (vault ids + fresh claims).
      const mediaFiles: Array<number | Record<string, unknown>> = attached.map(
        (m) => m._claim ?? m.id,
      );
      return submitOne(accountId!, mediaFiles, scheduledIso);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messages-queue"] });
      reset();
      onClose();
    },
    onError: (err: Error) => {
      setProgress(null);
      setError(err.message);
    },
  });

  function reset() {
    setText("");
    setAttached([]);
    setAttachedFiles([]);
    setPrice("");
    setLockedText(false);
    setIncludes(new Set());
    setExcludes(new Set());
    setSchedule("");
    setError(null);
    setProgress(null);
    setResults(null);
    setAllModels(false);
  }

  if (!open) return null;

  const priceNum = price ? Number(price) : 0;
  const isPPV = priceNum > 0;
  const isScheduled = !!schedule;

  // Reach preview — sum the user-count of the custom lists we're including
  // (system audiences don't expose counts, so we hint them separately).
  const includeReach = Array.from(includes).reduce((sum, id) => {
    const l = customLists.find((x) => String(x.id) === id);
    return sum + (l?.usersCount ?? 0);
  }, 0);
  const hasSystem = Array.from(includes).some((id) => SYSTEM_AUDIENCES.some((b) => b.id === id));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4"
      onClick={() => { if (!send.isPending) { reset(); onClose(); } }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[640px] max-h-[90vh] flex flex-col bg-panel border border-border rounded-xl shadow-2xl"
      >
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">New mass message</h2>
          <button
            type="button"
            onClick={() => { if (!send.isPending) { reset(); onClose(); } }}
            className="text-fg-dim hover:text-fg text-lg leading-none"
            title="Close"
          >×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* All-models switch — pivots the modal between single-account
           *  mode (vault + custom-list audiences) and fan-out mode
           *  (uploads only + system audiences only). */}
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allModels}
              onChange={(e) => setAllModels(e.target.checked)}
            />
            <span className="font-medium">Broadcast from ALL models</span>
            <span className="text-fg-dim">
              ({activeAccounts.length} active session{activeAccounts.length === 1 ? "" : "s"})
            </span>
          </label>

          {allModels ? (
            <div className="text-[11px] text-fg-dim border border-dashed border-border rounded-md py-2 px-3">
              Each account uploads + broadcasts independently. Vault and
              custom-list pickers are hidden because they're per-account.
            </div>
          ) : (
            <AccountPicker value={accountId} onChange={setAccountId} />
          )}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What's the broadcast?"
            rows={4}
            className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:border-accent resize-y"
          />

          {allModels ? (
            <AllModelsMediaTray files={attachedFiles} onChange={setAttachedFiles} />
          ) : (
            <MediaTray
              accountId={accountId}
              attached={attached}
              onChange={setAttached}
              onOpenVaultPicker={() => setPickerOpen(true)}
            />
          )}

          <div className="flex items-center gap-2">
            <label className="text-xs text-fg-dim shrink-0">Price (USD):</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0 (free)"
              className="flex-1 bg-bg border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
            />
            <span className={isPPV ? "text-warn text-[11px]" : "text-fg-dim text-[11px]"}>
              {isPPV ? `🔒 PPV $${priceNum.toFixed(2)}` : "free"}
            </span>
          </div>
          {isPPV && (
            <label className="flex items-center gap-2 text-xs text-fg-dim cursor-pointer">
              <input
                type="checkbox"
                checked={lockedText}
                onChange={(e) => setLockedText(e.target.checked)}
              />
              Lock the text too (fan must pay to read)
            </label>
          )}

          <ScheduleField
            scope={allModels ? "all-models" : accountId}
            value={schedule}
            onChange={setSchedule}
          />

          {/* Audience picker. In all-models mode we only show system
           *  audiences — custom lists are per-account so there's no
           *  list-id that means the same thing across every model. */}
          <div className="border border-border rounded-md p-3 space-y-3">
            <div className="text-[11px] uppercase tracking-wide text-fg-dim">
              Audience <span className="text-err">*</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {SYSTEM_AUDIENCES.map((b) => {
                  const state = includes.has(b.id)
                    ? "in"
                    : excludes.has(b.id) ? "ex" : "off";
                  return (
                    <SysChip
                      key={b.id}
                      state={state}
                      onClick={() => cycleSystem(b.id)}
                      label={b.label}
                    />
                  );
                })}
              </div>
              <div className="text-[10px] text-fg-dim">
                Click to cycle: off → +include → −exclude → off
              </div>
            </div>
            {!allModels && (
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/60">
                <div>
                  <div className="text-[11px] text-fg-dim mb-1.5">Custom lists — include</div>
                  <ListColumn
                    lists={customLists}
                    loading={listsQ.isLoading}
                    selected={includes}
                    onToggle={toggleInclude}
                    emptyLabel="No custom lists."
                  />
                </div>
                <div>
                  <div className="text-[11px] text-fg-dim mb-1.5">Custom lists — exclude</div>
                  <ListColumn
                    lists={customLists}
                    loading={listsQ.isLoading}
                    selected={excludes}
                    onToggle={toggleExclude}
                    emptyLabel="—"
                  />
                </div>
              </div>
            )}
            {!allModels && (includes.size > 0 || excludes.size > 0) && (
              <div className="text-[11px] text-fg-dim border-t border-border/60 pt-2">
                Reach: {includeReach} fan{includeReach === 1 ? "" : "s"} from custom
                {hasSystem ? " + system audience" : ""}
                {excludes.size > 0 && ` — minus ${excludes.size} list${excludes.size === 1 ? "" : "s"}`}
              </div>
            )}
          </div>

          {/* Per-account fan-out summary, shown after a partial-success run. */}
          {results && (
            <div className="border border-border rounded-md p-3 space-y-1 text-[11px]">
              <div className="font-medium">Fan-out results — {summarizeFanOut(results)}</div>
              {results.map((r) => (
                <div key={r.accountId} className={r.ok ? "text-ok" : "text-err"}>
                  {r.ok ? "✓" : "✗"} {r.accountId}
                  {r.error ? ` — ${r.error}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          {progress && <span className="text-fg-dim text-[11px] mr-auto">{progress}</span>}
          {error && !progress && <span className="text-err text-[11px] mr-auto">{error}</span>}
          <button
            type="button"
            onClick={() => { reset(); onClose(); }}
            disabled={send.isPending}
            className="text-xs px-3 py-1.5 rounded border border-border hover:border-border-light text-fg-dim hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setResults(null);
              const action = isScheduled ? "Schedule" : "Broadcast";
              const target = allModels
                ? `${activeAccounts.length} model${activeAccounts.length === 1 ? "" : "s"}`
                : `${includes.size} audience group${includes.size === 1 ? "" : "s"}`;
              if (!confirm(`${action} from ${target}?`)) return;
              send.mutate();
            }}
            disabled={
              send.isPending ||
              includes.size === 0 ||
              (allModels ? activeAccounts.length === 0 : !accountId)
            }
            className="text-xs px-4 py-1.5 rounded bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {send.isPending
              ? (isScheduled ? "Scheduling…" : "Broadcasting…")
              : (isScheduled ? "Schedule" : "Broadcast")}
          </button>
        </footer>
      </div>

      <VaultPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        accountId={accountId}
        fanId={null}
        initialSelectedIds={attached.map((m) => m.id)}
        onConfirm={(p) => {
          setAttached(p);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

function ListColumn({
  lists, loading, selected, onToggle, emptyLabel,
}: {
  lists: FanList[];
  loading: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  emptyLabel: string;
}) {
  if (loading) return <div className="text-[11px] text-fg-dim">Loading…</div>;
  if (lists.length === 0) {
    return <div className="text-[11px] text-fg-dim italic">{emptyLabel}</div>;
  }
  return (
    <div className="flex flex-col gap-1 max-h-32 overflow-y-auto pr-1">
      {lists.map((l) => {
        const id = String(l.id);
        const checked = selected.has(id);
        return (
          <label
            key={id}
            className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-bg-elev-1/40 rounded px-1 py-0.5"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(id)}
            />
            <span className="flex-1 truncate">{l.name || `List #${id}`}</span>
            <span className="text-[10px] text-fg-dim shrink-0">({l.usersCount ?? 0})</span>
          </label>
        );
      })}
    </div>
  );
}

/** Tri-state chip for system audiences: off / include (+) / exclude (−). */
function SysChip({
  state, onClick, label,
}: {
  state: "off" | "in" | "ex";
  onClick: () => void;
  label: string;
}) {
  const stateStyles = {
    off: "bg-transparent text-fg-dim border-border hover:border-border-light",
    in:  "bg-accent/15 text-accent border-accent/30",
    ex:  "bg-err/15 text-err border-err/30 line-through",
  };
  const prefix = state === "in" ? "+ " : state === "ex" ? "− " : "";
  const hint = state === "off"
    ? "OF built-in"
    : state === "in"
      ? "included"
      : "excluded";
  return (
    <button
      type="button"
      onClick={onClick}
      title="Click to cycle: off → include → exclude → off"
      className={
        "px-2 py-1 rounded-full border text-[11px] flex items-center gap-1.5 transition-colors " +
        stateStyles[state]
      }
    >
      <span>{prefix}{label}</span>
      <span className="opacity-60 no-underline">· {hint}</span>
    </button>
  );
}
