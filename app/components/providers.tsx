"use client";

/**
 * Top-level client providers. Mounted once in layout.tsx, wraps the
 * entire tree. Order matters:
 *
 *   QueryClientProvider — must be outermost so every fetch flows through
 *                         the same cache. Children include the popout
 *                         tab too, which inherits via the localStorage
 *                         persister wired below.
 *   IsRestoringProvider — flips queries into "restoring" mode so they
 *                         read from cache but don't fire network until
 *                         the localStorage hydrate finishes.
 *   EmployeeProvider    — drives the picker modal + X-Employee-Id header.
 *   ScopeProvider       — passive holder for active scope.
 *
 * QueryClient is created once per browser session via useState's lazy
 * init — Next 16's React 19 strict mode would otherwise re-create it
 * on every render and lose all in-flight cache.
 *
 * **Persistence**: we wire `persistQueryClient` once on mount, which
 * mirrors selected query keys to localStorage so popout windows + repeat
 * tab-opens hydrate from disk. We pair it with `IsRestoringProvider` so
 * useQuery hooks DON'T fire network requests during the first render —
 * otherwise they'd race the async restore and the popout tab would
 * re-fetch data that's already sitting in localStorage. We tracked down
 * this race after pop-out kept reloading vault + messages even though
 * the inbox had already loaded them.
 */

import {
  QueryClient,
  QueryClientProvider,
  IsRestoringProvider,
} from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { persistQueryClient } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { useEffect, useState } from "react";

import { EmployeeProvider } from "@/contexts/EmployeeContext";
import { ScopeProvider } from "@/contexts/ScopeContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { installGlobalErrorHandlers } from "@/lib/errorReporter";
import { registerImageSW } from "@/lib/registerImageSW";

// Bump when the persisted cache shape changes (added/removed fields on
// OFChatItem, etc.) so old localStorage entries get nuked on read instead
// of silently rendering as garbage.
const CACHE_BUSTER = "v3";
// 24h is generous — popout windows usually open within minutes, but the
// snapshot is fine to keep around in case a chatter restarts their tab.
const PERSIST_MAX_AGE = 24 * 60 * 60 * 1000;

// Keys we want shared across tabs. Anything not on this list stays
// in-memory only.
const PERSIST_PREFIXES = new Set([
  "chats",          // inbox sidebar — biggest popout win
  "chat-folders",   // pinned-folder chip strip — avoids 1s lag on tab switch
  "messages",       // per-chat thread; popout reuses the inbox's loaded pages
  "of-me",          // model account profile — small, reused everywhere
  "of-user",        // single-fan profile lookup (popout header)
  "vault-lists",    // folders for the Add-to-lists picker (kills 2s lag)
  "vault-media",    // vault-picker grid
  "vault-history",  // per-fan sent/purchased history for picker badges
  "wall-media",     // ids posted on the wall — blue ring in vault picker
  "templates",      // composer's quick-reply picker
  "saved-replies",  // composer's saved replies
  "fan",            // local fan-row drawer data
  "last-purchases", // payouts transactions feed — staleTime Infinity
  "employees",      // employee picker
  "accounts",       // active-models sidebar
]);

function shouldPersistKey(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  return typeof head === "string" && PERSIST_PREFIXES.has(head);
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // Mirror the desktop-app's 5-min TTL. Per-query overrides happen
        // at the useQuery call site when a domain needs different (chat
        // list 30s, vault metadata 1h, online presence 30s, etc.)
        staleTime: 5 * 60 * 1000,
        gcTime:    30 * 60 * 1000,
        // Don't refetch on window focus — feels noisy with SSE already
        // keeping things live. Re-enable per-query if a screen needs it.
        refetchOnWindowFocus: false,
        retry: 1,
      },
      mutations: {
        retry: 0,
      },
    },
  }));

  // Starts true so first-render useQuery hooks don't fire network requests
  // before localStorage hydration completes — that race is what made the
  // popout tab re-load vault + messages despite them being in localStorage.
  const [isRestoring, setIsRestoring] = useState(true);

  // Wire the global error reporter once per page load. This catches
  // window-level uncaught exceptions and unhandled promise rejections
  // and POSTs them to /admin/errors. Idempotent — safe under StrictMode
  // double-invoke.
  useEffect(() => {
    installGlobalErrorHandlers();
    // SW for image caching — no-op in dev, lazy register in prod. See
    // IMAGE_LOAD_PLAN.txt phase C.
    registerImageSW();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      setIsRestoring(false);
      return;
    }
    const persister = createSyncStoragePersister({
      storage: window.localStorage,
      key: "chatterly-rq-cache",
      // 250ms is short enough that hitting "↗ pop out" right after a
      // fetch lands still flushes the new data to localStorage before
      // the new tab reads it. 1000ms (the previous value) was long
      // enough to miss freshly-loaded queries.
      throttleTime: 250,
    });
    const [unsubscribe, restorePromise] = persistQueryClient({
      queryClient,
      persister,
      maxAge: PERSIST_MAX_AGE,
      buster: CACHE_BUSTER,
      dehydrateOptions: {
        shouldDehydrateQuery: (q) => {
          // Only persist successful queries on the allowlist. Errored
          // ones aren't worth carrying over — they'll just re-trigger.
          if (q.state.status !== "success") return false;
          return shouldPersistKey(q.queryKey);
        },
      },
    });
    restorePromise.finally(() => setIsRestoring(false));
    return () => unsubscribe();
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <IsRestoringProvider value={isRestoring}>
        <EmployeeProvider>
          <ScopeProvider>
            <ErrorBoundary scope="root">{children}</ErrorBoundary>
          </ScopeProvider>
        </EmployeeProvider>
      </IsRestoringProvider>
      {/* Devtools only render in development; safe to leave mounted. */}
      {/* bottom-left so the floating button doesn't overlap the Composer's
       *  Send / Send-in-N controls in the chat surface. */}
      <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
    </QueryClientProvider>
  );
}
