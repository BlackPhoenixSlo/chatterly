import type { Metadata } from "next";
import { Sora } from "next/font/google";

import Providers from "@/components/providers";
import EmployeePickerGate from "@/components/employees/EmployeePickerGate";
import TopNav from "@/components/TopNav";
import { NotificationToaster } from "@/components/NotificationToaster";

import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sora",
});

export const metadata: Metadata = {
  title: "Chatterly",
  description: "OnlyFans agency dashboard — unified inbox + automations.",
  // Prevent the desktop OS app store from grabbing the title bar.
  icons: { icon: "/favicon.ico" },
};

// Inline script that runs BEFORE React hydrates so the persisted theme
// is on <html> by the time the first paint happens. Without this you'd
// see a flash of dark mode before the client-side useTheme hook caught
// up. Tiny + safe; the worst-case (localStorage unavailable) falls back
// to the default dark theme defined in globals.css.
const THEME_BOOT_SCRIPT = `
try {
  var t = localStorage.getItem('chatterly:theme');
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
} catch (_e) {}
`;

// Stale-chunk recovery. Must be an inline script (not a React component)
// because the chunk that most often goes stale after a Turbopack restart
// is the layout chunk itself — if the React tree can't boot, a component-
// based handler never registers its listener and the tab just sits blank
// until the user manually reloads. This script runs while HTML parses,
// before any chunk is requested, so it survives a missing layout chunk.
//
// Same guard semantics as before: ≤3 reloads per session, 60s cooldown,
// bail if sessionStorage is blocked (better a blank tab than a 1000 req/s
// reload loop).
const CHUNK_ERROR_BOOT_SCRIPT = `
(function(){
  var GUARD='chatterly:chunk-reload-attempted',COUNT='chatterly:chunk-reload-count',MAX=3,COOL=60000;
  function stale(e){if(!e)return false;if(e.name==='ChunkLoadError')return true;var m=e.message||'';
    return m.indexOf('Loading chunk')>=0||m.indexOf('Failed to fetch dynamically imported module')>=0||m.indexOf('error loading dynamically imported module')>=0;}
  function reload(){try{var s=sessionStorage.getItem(GUARD);if(s&&Date.now()-Number(s)<COOL)return;
    var c=Number(sessionStorage.getItem(COUNT)||'0');if(c>=MAX){console.warn('[chunk-reloader] reload cap reached');return;}
    sessionStorage.setItem(GUARD,String(Date.now()));sessionStorage.setItem(COUNT,String(c+1));}catch(_){return;}
    location.reload();}
  addEventListener('error',function(ev){if(stale(ev.error)||stale({message:ev.message}))reload();});
  addEventListener('unhandledrejection',function(ev){if(stale(ev.reason))reload();});
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The font variable lets us reference --font-sora from Tailwind's
  // `font-sans` token (configured in globals.css @theme).
  return (
    <html lang="en" className={sora.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-fg antialiased" suppressHydrationWarning>
        {/* This inline script runs synchronously before React hydrates, so
         *  the persisted theme is on <html data-theme=…> by the first paint.
         *  Lives in <body> rather than <head> because Next App Router's
         *  <head> rendering is opinionated and inline scripts there can
         *  end up unreachable in dev mode. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: CHUNK_ERROR_BOOT_SCRIPT }} />
        <Providers>
          <EmployeePickerGate>
            <TopNav />
            {children}
            <NotificationToaster />
          </EmployeePickerGate>
        </Providers>
      </body>
    </html>
  );
}
