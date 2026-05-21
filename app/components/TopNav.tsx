"use client";

/**
 * TopNav — thin nav strip. Pinned at the top of every page inside the
 * EmployeePickerGate. Shows the current employee + scope + a few links
 * to the surfaces that actually exist (home + setup). Adds more entries
 * as Phase B/C ship Inbox / Vault / etc.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useEmployee } from "@/contexts/EmployeeContext";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import ScopeSwitcher from "@/components/ScopeSwitcher";
import { NotificationBell } from "@/components/NotificationBell";
import { ErrorBadge } from "@/components/ErrorBadge";
import { PostComposer } from "@/components/compose/PostComposer";
import { MassMessageComposer } from "@/components/compose/MassMessageComposer";

const LINKS: Array<{ href: string; label: string }> = [
  { href: "/",          label: "Home"     },
  { href: "/inbox",     label: "Inbox"    },
  { href: "/setup",     label: "Setup"    },
  { href: "/settings",  label: "Settings" },
];

export default function TopNav() {
  const { current, clear } = useEmployee();
  const pathname = usePathname();
  const { theme, toggle } = useTheme();

  const [composeOpen, setComposeOpen] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [massOpen, setMassOpen] = useState(false);
  const composeRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown when clicking outside or pressing Esc.
  useEffect(() => {
    if (!composeOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!composeRef.current?.contains(e.target as Node)) setComposeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setComposeOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [composeOpen]);

  return (
    <header className="border-b border-border bg-panel/80 backdrop-blur sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center gap-6">
        <Link href="/" className="font-semibold text-fg tracking-tight">
          Chatterly
        </Link>

        <nav className="flex items-center gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm transition-colors",
                pathname === l.href
                  ? "bg-bg-elev-1 text-fg"
                  : "text-fg-dim hover:text-fg hover:bg-bg-elev-1/50",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* Compose dropdown — opens either New post or New mass message. */}
          <div className="relative" ref={composeRef}>
            <button
              type="button"
              onClick={() => setComposeOpen((v) => !v)}
              className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-hover font-medium"
              title="Compose"
            >
              + New ▾
            </button>
            {composeOpen && (
              <div className="absolute right-0 mt-1 w-56 bg-panel border border-border rounded-lg shadow-xl py-1 z-40">
                <button
                  type="button"
                  onClick={() => { setComposeOpen(false); setPostOpen(true); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-bg-elev-1 flex items-center gap-2"
                >
                  <span>📝</span>
                  <span>
                    <div className="font-medium">New post</div>
                    <div className="text-[10px] text-fg-dim">Public feed post</div>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setComposeOpen(false); setMassOpen(true); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-bg-elev-1 flex items-center gap-2"
                >
                  <span>📣</span>
                  <span>
                    <div className="font-medium">Mass message</div>
                    <div className="text-[10px] text-fg-dim">Broadcast to fans</div>
                  </span>
                </button>
              </div>
            )}
          </div>
          <ScopeSwitcher />
          <NotificationBell />
          <ErrorBadge />
          <button
            type="button"
            onClick={toggle}
            className="w-8 h-8 grid place-items-center rounded-lg text-sm bg-bg-elev-1 hover:bg-bg-elev-2 border border-border"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            type="button"
            onClick={clear}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-bg-elev-1 hover:bg-bg-elev-2 border border-border"
            title="Switch employee"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: current?.color || "#888" }}
            />
            {current?.display_name || "—"}
          </button>
        </div>
      </div>

      <PostComposer open={postOpen} onClose={() => setPostOpen(false)} />
      <MassMessageComposer open={massOpen} onClose={() => setMassOpen(false)} />
    </header>
  );
}
