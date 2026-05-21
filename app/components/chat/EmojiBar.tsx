"use client";

/**
 * EmojiBar — quick-row + picker popover with search + recents.
 *
 * Insertion preserves the textarea's cursor so the user can type, drop
 * an emoji, keep typing. The full emoji set lives in EMOJI_CATEGORIES;
 * the picker shows them tabbed by category with a search box that
 * matches by keyword.
 *
 * Recents persist in localStorage so the picker remembers what you used
 * across reloads.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export const QUICK_EMOJIS = ["❤️", "😍", "🔥", "👍", "😂", "💀", "✨", "🎉"] as const;

const LS_RECENTS_KEY = "chatterly:emoji_recents";
const MAX_RECENTS = 24;

/**
 * Each entry: [emoji, keywords]. Keywords drive search and let one emoji
 * surface under multiple terms (e.g. 🍆 matches "eggplant" AND "cock").
 */
type EmojiEntry = readonly [string, readonly string[]];

const FLIRTY: readonly EmojiEntry[] = [
  ["❤️", ["heart", "love", "red"]],
  ["💕", ["hearts", "love", "pink"]],
  ["💖", ["sparkling", "heart", "pink"]],
  ["💗", ["growing", "heart"]],
  ["💓", ["beating", "heart"]],
  ["💘", ["arrow", "heart", "cupid"]],
  ["💝", ["gift", "heart"]],
  ["💞", ["revolving", "hearts"]],
  ["💜", ["purple", "heart"]],
  ["🖤", ["black", "heart"]],
  ["🤍", ["white", "heart"]],
  ["🧡", ["orange", "heart"]],
  ["💛", ["yellow", "heart"]],
  ["💚", ["green", "heart"]],
  ["💙", ["blue", "heart"]],
  ["😍", ["love", "eyes", "heart"]],
  ["🥰", ["smile", "hearts", "love"]],
  ["😘", ["kiss", "blow"]],
  ["😚", ["kiss", "closed"]],
  ["😙", ["kiss", "smile"]],
  ["😗", ["kiss"]],
  ["💋", ["kiss", "lips", "mark"]],
  ["👄", ["mouth", "lips"]],
  ["🫦", ["bite", "lip"]],
  ["👅", ["tongue"]],
  ["🥵", ["hot", "sweat", "horny"]],
  ["🤤", ["drool", "wet"]],
  ["😏", ["smirk", "tease"]],
  ["😈", ["devil", "naughty", "horny"]],
  ["👿", ["angry", "devil"]],
  ["💦", ["drop", "wet", "splash", "cum"]],
  ["🔥", ["fire", "hot", "lit"]],
  ["💯", ["100", "hundred"]],
  ["✨", ["sparkle", "shine"]],
  ["🌹", ["rose", "flower"]],
  ["🌶️", ["spicy", "pepper", "hot"]],
  ["🍑", ["peach", "butt", "ass"]],
  ["🍆", ["eggplant", "cock", "dick"]],
  ["🍒", ["cherry", "boob"]],
  ["🍌", ["banana", "cock"]],
  ["🥒", ["cucumber"]],
  ["🌽", ["corn"]],
  ["🍯", ["honey"]],
  ["🍭", ["lollipop", "lick"]],
  ["🍦", ["icecream", "soft"]],
  ["🍓", ["strawberry"]],
];

const FACES: readonly EmojiEntry[] = [
  ["😊", ["smile", "blush"]],
  ["😀", ["smile", "happy"]],
  ["😁", ["grin"]],
  ["😂", ["laugh", "tears", "lol"]],
  ["🤣", ["rofl", "laugh"]],
  ["😅", ["sweat", "smile"]],
  ["😆", ["laugh"]],
  ["😉", ["wink"]],
  ["😎", ["cool", "sunglasses"]],
  ["🤩", ["star", "eyes", "excited"]],
  ["🥳", ["party"]],
  ["😋", ["yum", "tasty"]],
  ["😇", ["angel"]],
  ["🙂", ["smile", "slight"]],
  ["🤗", ["hug"]],
  ["🤔", ["think", "thinking"]],
  ["😐", ["neutral"]],
  ["😑", ["expressionless"]],
  ["😶", ["no", "mouth"]],
  ["🙄", ["eyeroll"]],
  ["😴", ["sleep"]],
  ["🤤", ["drool"]],
  ["😪", ["sleepy"]],
  ["😢", ["cry", "sad"]],
  ["😭", ["sob", "crying"]],
  ["🥺", ["pleading", "puppy"]],
  ["😳", ["flushed", "shock"]],
  ["😱", ["scream", "shock"]],
  ["🤯", ["mind", "blown"]],
  ["😡", ["angry", "mad"]],
  ["🤬", ["swear", "cuss"]],
  ["🙈", ["see", "no", "evil", "shy"]],
  ["🙉", ["hear", "no"]],
  ["🙊", ["speak", "no"]],
];

const GESTURES: readonly EmojiEntry[] = [
  ["👍", ["thumbs", "up", "yes"]],
  ["👎", ["thumbs", "down", "no"]],
  ["👏", ["clap"]],
  ["🙌", ["raised", "hands", "praise"]],
  ["🙏", ["pray", "thanks", "please"]],
  ["🤝", ["handshake", "deal"]],
  ["✌️", ["peace"]],
  ["🤞", ["fingers", "crossed", "luck"]],
  ["🤟", ["love", "you", "rock"]],
  ["🤘", ["rock", "horns"]],
  ["👌", ["ok"]],
  ["🤌", ["pinch", "italian"]],
  ["👋", ["wave", "hello", "hi", "bye"]],
  ["👀", ["eyes", "looking"]],
  ["💪", ["muscle", "strong"]],
  ["🫰", ["love", "money"]],
];

const PARTY: readonly EmojiEntry[] = [
  ["🎉", ["party", "celebrate", "tada"]],
  ["🎊", ["confetti"]],
  ["🥂", ["cheers", "toast"]],
  ["🍾", ["champagne"]],
  ["🍷", ["wine"]],
  ["🍸", ["cocktail", "martini"]],
  ["🍹", ["tropical", "drink"]],
  ["🍺", ["beer"]],
  ["🎁", ["gift", "present"]],
  ["🎀", ["ribbon", "bow"]],
  ["💎", ["diamond", "gem"]],
  ["💰", ["money", "bag"]],
  ["💵", ["dollar", "money"]],
  ["💸", ["cash", "flying"]],
  ["🎂", ["cake", "birthday"]],
  ["🍰", ["cake", "slice"]],
  ["⭐", ["star"]],
  ["🌟", ["sparkle", "star"]],
  ["💀", ["skull", "dead", "lol"]],
  ["☠️", ["skull", "crossbones"]],
];

interface Category { id: string; label: string; items: readonly EmojiEntry[] }

const CATEGORIES: Category[] = [
  { id: "flirty",   label: "💋", items: FLIRTY },
  { id: "faces",    label: "😀", items: FACES },
  { id: "gestures", label: "👍", items: GESTURES },
  { id: "party",    label: "🎉", items: PARTY },
];

const ALL_ENTRIES: EmojiEntry[] = CATEGORIES.flatMap((c) => [...c.items]);

/** Backwards-compat: callers that import EMOJI_LIST get the bare strings. */
export const EMOJI_LIST: readonly string[] = ALL_ENTRIES.map(([e]) => e);

/** Insert text at the current cursor of a textarea + restore focus. */
export function insertAtCursor(
  textarea: HTMLTextAreaElement,
  current: string,
  inserted: string,
  setValue: (s: string) => void,
) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = current.slice(0, start) + inserted + current.slice(end);
  setValue(next);
  setTimeout(() => {
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + inserted.length;
  }, 0);
}

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, MAX_RECENTS).filter((s) => typeof s === "string") : [];
  } catch { return []; }
}

function pushRecent(emoji: string) {
  if (typeof window === "undefined") return;
  try {
    const cur = loadRecents();
    const next = [emoji, ...cur.filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
    window.localStorage.setItem(LS_RECENTS_KEY, JSON.stringify(next));
  } catch { /* ignore quota */ }
}

export function EmojiQuickRow({
  onInsert, disabled,
}: { onInsert: (e: string) => void; disabled?: boolean }) {
  return (
    <div className="flex gap-1">
      {QUICK_EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          disabled={disabled}
          onClick={() => { pushRecent(e); onInsert(e); }}
          className="w-7 h-7 grid place-items-center rounded-md hover:bg-bg-elev-1 disabled:opacity-40 text-base"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

export function EmojiPickerButton({
  onInsert, disabled, align = "right",
}: { onInsert: (e: string) => void; disabled?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>(CATEGORIES[0].id);
  const [search, setSearch] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Re-load recents whenever the picker opens so we pick up clicks from
  // other components (quick-row) that also write to the store.
  useEffect(() => {
    if (open) {
      setRecents(loadRecents());
      setSearch("");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const filtered = useMemo<string[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return ALL_ENTRIES
      .filter(([e, kws]) => e.includes(q) || kws.some((k) => k.toLowerCase().includes(q)))
      .map(([e]) => e);
  }, [search]);

  function pick(e: string) {
    pushRecent(e);
    onInsert(e);
    setOpen(false);
  }

  const activeCategory = CATEGORIES.find((c) => c.id === tab) ?? CATEGORIES[0];

  return (
    <div ref={popoverRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 grid place-items-center rounded-md hover:bg-bg-elev-1 disabled:opacity-40"
        aria-label="Emoji picker"
      >
        😊
      </button>
      {open && (
        <div
          className={cn(
            "absolute bottom-full mb-2 z-20",
            align === "right" ? "right-0" : "left-0",
            "bg-panel border border-border rounded-xl shadow-lg",
            "w-80",
          )}
        >
          <div className="p-2 border-b border-border">
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search emoji…"
              className="w-full bg-bg border border-border rounded-md px-2 py-1 text-xs placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>

          {search.trim() ? (
            <div className="p-2 max-h-64 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="text-xs text-fg-dim text-center py-6">
                  No emoji match &ldquo;{search}&rdquo;.
                </div>
              ) : (
                <div className="grid grid-cols-8 gap-1">
                  {filtered.map((e) => (
                    <EmojiBtn key={e} emoji={e} onClick={pick} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 px-2 pt-2">
                {recents.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTab("recents")}
                    className={cn(
                      "px-2 py-1 rounded-md text-base",
                      tab === "recents" ? "bg-bg-elev-1" : "hover:bg-bg-elev-1/50",
                    )}
                    title="Recent"
                  >
                    🕘
                  </button>
                )}
                {CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setTab(c.id)}
                    className={cn(
                      "px-2 py-1 rounded-md text-base",
                      tab === c.id ? "bg-bg-elev-1" : "hover:bg-bg-elev-1/50",
                    )}
                    title={c.id}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="p-2 max-h-64 overflow-y-auto">
                {tab === "recents" && recents.length > 0 ? (
                  <div className="grid grid-cols-8 gap-1">
                    {recents.map((e, i) => (
                      <EmojiBtn key={`${e}-${i}`} emoji={e} onClick={pick} />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-8 gap-1">
                    {activeCategory.items.map(([e]) => (
                      <EmojiBtn key={e} emoji={e} onClick={pick} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EmojiBtn({ emoji, onClick }: { emoji: string; onClick: (e: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onClick(emoji)}
      className="w-7 h-7 grid place-items-center rounded-md hover:bg-bg-elev-1 text-base"
    >
      {emoji}
    </button>
  );
}
