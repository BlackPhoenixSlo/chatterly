/**
 * db.ts — Dexie schema (tier-2b cache, "cold storage").
 *
 * Backs the chat list, vault grid, fan profiles, and message history with
 * an IndexedDB store the browser can read in <50ms on cold reload. The
 * tier-1 React Query cache fills first (5-min TTL); on misses we hit
 * Dexie; on Dexie misses we go to the relay (tier 3, SQLite).
 *
 * Schema mirrors the relay's SQL where shape overlaps:
 *   • `chats`      keyed by (accountId, fanId)
 *   • `messages`   keyed by (accountId, fanId, messageId)
 *   • `vaultItems` keyed by (accountId, mediaId)
 *   • `fans`       keyed by (accountId, fanId)
 *
 * Compound primary keys are written as `"[accountId+fanId]"` Dexie syntax.
 * Indexes match the access patterns: "all chats sorted by last_message_at",
 * "all messages in one thread sorted by created_at", etc.
 *
 * We DO NOT replicate the whole server DB here. Just the slices that the
 * UI actually shows. Cold-loading "the last 200 chats + 50 most recent
 * messages each" is the sweet spot — bigger than localStorage handles,
 * smaller than swamping IndexedDB.
 */

import Dexie, { type Table } from "dexie";

export interface ChatRow {
  accountId: string;
  fanId: number;
  lastMessageId?: number | null;
  lastMessageAt?: string | null; // ISO; sortable as string
  lastMessagePreview?: string | null;
  unreadCount: number;
  isPinned?: boolean;
  isPriority?: boolean;
  hiddenLocally?: boolean;
}

export interface MessageRow {
  accountId: string;
  fanId: number;
  messageId: number;
  direction: "in" | "out" | "system";
  senderName?: string;
  body?: string;
  mediaIds?: number[];
  mediaCount?: number;
  priceCents?: number;
  isPaid?: boolean | null;
  isTip?: boolean;
  createdAt: string; // ISO
  tempId?: string | null;
  failed?: boolean;
}

export interface VaultItemRow {
  accountId: string;
  mediaId: number;
  kind: string;
  thumbUrl?: string | null;
  fullUrl?: string | null;
  description?: string | null;
  suggestedPriceCents?: number | null;
  defaultPriceCents?: number | null;
  tags?: string[];
  sendCount?: number;
  createdAt?: string;
}

export interface FanRow {
  accountId: string;
  fanId: number;
  ofUsername?: string | null;
  ofDisplayName?: string | null;
  customNickname?: string | null;
  avatarUrl?: string | null;
  lifetimeSpendCents?: number;
  lastMessageReceivedAt?: string | null;
  source?: string;
}

class ChatterlyDB extends Dexie {
  chats!: Table<ChatRow, [string, number]>;
  messages!: Table<MessageRow, [string, number, number]>;
  vaultItems!: Table<VaultItemRow, [string, number]>;
  fans!: Table<FanRow, [string, number]>;

  constructor() {
    super("chatterly");

    // Bump the version number every time the schema changes; Dexie runs
    // the upgrade callback to migrate existing IndexedDB data.
    this.version(1).stores({
      chats:      "[accountId+fanId], accountId, lastMessageAt",
      messages:   "[accountId+fanId+messageId], [accountId+fanId], [accountId+fanId+createdAt], tempId",
      vaultItems: "[accountId+mediaId], accountId, [accountId+createdAt], [accountId+sendCount]",
      fans:       "[accountId+fanId], accountId, lifetimeSpendCents, lastMessageReceivedAt",
    });
  }
}

// Lazy singleton — only created in the browser. Some Next.js layouts
// import this file from server components; we guard SSR with a typeof
// check so the build doesn't try to open IndexedDB on Node.
let _db: ChatterlyDB | null = null;
export function db(): ChatterlyDB {
  if (typeof window === "undefined") {
    // Returning a fake during SSR keeps callers from having to null-check
    // everywhere. Any actual `.table.put(...)` from a server context will
    // throw — that's intentional; client-only code lives in `"use client"`
    // components.
    throw new Error("Dexie is browser-only; wrap callers in 'use client'");
  }
  if (!_db) _db = new ChatterlyDB();
  return _db;
}

// ── Common helpers ──────────────────────────────────────────────────

/** Get all chats sorted newest-first. Scope filtering applied client-side
 *  because IndexedDB doesn't support multi-column ORDER BY natively. */
export async function getAllChatsSortedByRecent(): Promise<ChatRow[]> {
  const rows = await db().chats.orderBy("lastMessageAt").reverse().toArray();
  return rows;
}

/** Get one chat's messages, newest-first, capped. */
export async function getMessagesForChat(
  accountId: string,
  fanId: number,
  limit = 50,
): Promise<MessageRow[]> {
  return db().messages
    .where("[accountId+fanId+createdAt]")
    .between([accountId, fanId, Dexie.minKey], [accountId, fanId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray();
}

/** Wipe everything — used by Settings → "Forget local cache" debug button. */
export async function clearLocalCache(): Promise<void> {
  if (typeof window === "undefined") return;
  await db().delete();
  _db = null;
}
