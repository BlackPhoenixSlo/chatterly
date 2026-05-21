/**
 * events.ts — EventSource client + a typed dispatcher.
 *
 * The browser opens one EventSource per session (per scope). The relay's
 * `/events?scope=...` endpoint feeds it. When an event arrives, dispatch
 * fires per-event-type listeners *and* a wildcard catch-all.
 *
 * Reconnect: EventSource auto-reconnects on socket close. We rely on
 * that + the relay's Last-Event-ID replay (phase B) for at-least-once.
 *
 * Concurrency: a single EventSource per scope; multiple components
 * subscribe to the same one via `on(eventType, fn)`. Clean up by calling
 * the returned unsubscriber on unmount.
 */

import { resolveShareToken } from "./relay";

export type Scope = "all" | `model:${string}`;

export interface EventEnvelope {
  __account_id?: string;
  __account_name?: string;
  __account_color?: string;
  [key: string]: unknown;
}

type Listener = (e: EventEnvelope, rawType: string) => void;

class EventBus {
  private es: EventSource | null = null;
  private currentScope: Scope | null = null;
  // Listeners keyed by event_type. The wildcard "*" key catches everything.
  private byType = new Map<string, Set<Listener>>();
  // Reconnect throttle — EventSource handles its own backoff for socket
  // failures, but our explicit `.close()` calls when scope changes need
  // to avoid thrash if the user clicks the model switcher rapidly.
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Switch the live scope. Idempotent — calling with the same scope is a no-op. */
  setScope(scope: Scope) {
    if (this.currentScope === scope) return;
    this.currentScope = scope;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.reconnect(), 50);
  }

  /** Tear down + reopen. Called on scope changes + on share-token rotation. */
  private reconnect() {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    const scope = this.currentScope;
    if (!scope) return;
    const tok = resolveShareToken();
    const qs = new URLSearchParams({ scope });
    if (tok) qs.set("t", tok);
    const url = `/events?${qs.toString()}`;
    const es = new EventSource(url);
    this.es = es;

    // Relay sets the SSE `event:` line to the OF event type. We listen
    // on a wildcard via `onmessage`, and ALSO add specific listeners
    // when callers ask for them — those use addEventListener on the
    // event-type name directly (DOM API, not our dispatcher).
    es.onmessage = (msg) => this.dispatch("message", msg.data);
    es.onerror = (err) => {
      // SSE silently reconnects — we just log a low-level event so
      // listeners can show a "reconnecting…" pill if they care.
      this.dispatch("__error", JSON.stringify({ readyState: this.es?.readyState }));
      void err;
    };

    // Re-register every known type-listener against the new EventSource.
    for (const type of this.byType.keys()) {
      if (type === "*" || type === "__error") continue;
      es.addEventListener(type, (msg) => this.dispatch(type, (msg as MessageEvent).data));
    }
  }

  private dispatch(type: string, raw: string) {
    let parsed: EventEnvelope = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { __raw: raw } as EventEnvelope;
    }
    const exact = this.byType.get(type);
    const wild = this.byType.get("*");
    if (exact) for (const fn of exact) safe(fn, parsed, type);
    if (wild) for (const fn of wild) safe(fn, parsed, type);
  }

  /**
   * Subscribe to an event type. `"*"` catches every event.
   * Returns an unsubscriber the caller MUST call on unmount.
   */
  on(type: string, fn: Listener): () => void {
    if (!this.byType.has(type)) {
      this.byType.set(type, new Set());
      // If we already have a live EventSource, register the named-event
      // listener on it now so new subscribers don't miss types they care
      // about that the wildcard onmessage doesn't see.
      if (this.es && type !== "*" && type !== "__error") {
        this.es.addEventListener(type, (msg) =>
          this.dispatch(type, (msg as MessageEvent).data),
        );
      }
    }
    this.byType.get(type)!.add(fn);
    return () => {
      this.byType.get(type)?.delete(fn);
    };
  }
}

function safe(fn: Listener, e: EventEnvelope, type: string) {
  try {
    fn(e, type);
  } catch (err) {
    console.error("[events] listener error", err);
  }
}

// Module-level singleton — only one EventSource regardless of how many
// components subscribe.
export const eventBus = new EventBus();
