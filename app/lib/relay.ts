/**
 * relay.ts — typed fetch wrapper around the Python relay.
 *
 * Auto-injects:
 *   • `X-Employee-Id` from EmployeeContext (so every mutation gets audited)
 *   • `X-Account-Id` from ScopeContext when scope is a single model
 *   • `?t=<share token>` query param on every URL (relay's share-link gate)
 *
 * Returns parsed JSON for 2xx, throws `RelayError` for 4xx/5xx with the
 * upstream body attached. Callers (and React Query) get clean rejection
 * paths instead of having to inspect `.ok` themselves.
 */

const RELAY_BASE = ""; // Next rewrites front the relay; same-origin.

export class RelayError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `relay ${status}`);
    this.status = status;
    this.body = body;
  }
}

export interface RelayContext {
  shareToken?: string | null;
  employeeId?: number | null;
  accountId?: string | null;
  /** Sent as `X-Priority`. The relay reserves slots in its per-account
   *  upstream concurrency pool for "user" callers — anything tagged
   *  "background" (chat-list enrichment, periodic refresh, prefetch)
   *  may queue behind user-initiated work. Default: "user". */
  priority?: "user" | "background";
}

/**
 * Read the share token from the URL or from a previously-stored localStorage
 * value. Mirrors the existing /ui/'s behavior so a user who pastes
 * `?t=...&...` once doesn't have to repeat it.
 */
export function resolveShareToken(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("t");
  if (fromUrl) {
    try {
      window.localStorage.setItem("chatterly:share_token", fromUrl);
    } catch {
      /* ignore quota / safari private */
    }
    return fromUrl;
  }
  try {
    return window.localStorage.getItem("chatterly:share_token");
  } catch {
    return null;
  }
}

function buildUrl(path: string, ctx?: RelayContext): string {
  const url = new URL(path, RELAY_BASE || window.location.origin);
  const tok = ctx?.shareToken ?? resolveShareToken();
  if (tok && !url.searchParams.has("t")) url.searchParams.set("t", tok);
  return url.pathname + url.search;
}

function buildHeaders(init?: RequestInit, ctx?: RelayContext): HeadersInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (ctx?.employeeId != null) headers.set("X-Employee-Id", String(ctx.employeeId));
  if (ctx?.accountId) headers.set("X-Account-Id", String(ctx.accountId));
  if (ctx?.priority === "background") headers.set("X-Priority", "background");
  // Only set content-type for JSON bodies. For FormData the browser
  // needs to set Content-Type itself so it can include the multipart
  // boundary — overriding here would corrupt the upload.
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

async function parseResponse<T>(r: Response): Promise<T> {
  const text = await r.text();
  let body: unknown = text;
  if (text) {
    try { body = JSON.parse(text); } catch { /* keep as text */ }
  }
  if (!r.ok) {
    const rawDetail =
      (typeof body === "object" && body && "detail" in body && (body as Record<string, unknown>).detail) ||
      text || `HTTP ${r.status}`;
    // FastAPI returns `detail` as an object/array for upstream proxy
    // errors (`{upstream_status, upstream_body}`) and validation errors
    // (list of {loc, msg, type}). `String(obj)` yields "[object Object]"
    // which surfaces as an unreadable error chip — flatten to JSON instead.
    let detail: string;
    if (typeof rawDetail === "string") detail = rawDetail;
    else if (rawDetail && typeof rawDetail === "object") {
      const d = rawDetail as Record<string, unknown>;
      if (typeof d.upstream_status === "number" && typeof d.upstream_body === "string") {
        detail = `upstream ${d.upstream_status}: ${String(d.upstream_body).slice(0, 200)}`;
      } else if (Array.isArray(rawDetail)) {
        detail = rawDetail.map((e) => {
          if (e && typeof e === "object" && "msg" in (e as Record<string, unknown>)) {
            return String((e as Record<string, unknown>).msg);
          }
          return JSON.stringify(e);
        }).join("; ");
      } else {
        try { detail = JSON.stringify(rawDetail); } catch { detail = `HTTP ${r.status}`; }
      }
    } else {
      detail = `HTTP ${r.status}`;
    }
    throw new RelayError(r.status, body, detail);
  }
  return body as T;
}

/**
 * Core fetch wrapper. Most callers use the verb helpers (get/post/patch/delete)
 * but `request()` is here for the long tail of mixed verbs / streaming bodies.
 */
export async function request<T = unknown>(
  path: string,
  init?: RequestInit,
  ctx?: RelayContext,
): Promise<T> {
  const url = buildUrl(path, ctx);
  const headers = buildHeaders(init, ctx);
  const r = await fetch(url, { ...init, headers, credentials: "same-origin" });
  return parseResponse<T>(r);
}

/**
 * Wrap an OF CDN URL so it loads through the relay's `/img` proxy. We have
 * to do this because OF signs CDN URLs with `AWS:SourceIp=<egress IP>/32` —
 * the browser's IP doesn't match the account's proxy egress, so the image
 * 403s. `/img` tunnels the fetch via the right account's HTTP client.
 *
 * Returns the original URL if either `url` or `accountId` is missing.
 */
export function proxyImage(url: string | null | undefined, accountId: string | null | undefined): string {
  if (!url) return "";
  // Browser-local URLs (blob:/data:) aren't fetchable through the relay
  // — they're already in the browser, just pass them through.
  if (url.startsWith("blob:") || url.startsWith("data:")) return url;
  if (!accountId) return url;
  const tok = resolveShareToken();
  const params = new URLSearchParams();
  params.set("u", url);
  params.set("account_id", accountId);
  if (tok) params.set("t", tok);
  return `/img?${params.toString()}`;
}

/**
 * Build a URL for the i-th scrub frame (0..11) of a video. The relay
 * lazily extracts a 12-frame storyboard for each video on first hit;
 * subsequent fetches serve cached JPGs straight from disk. Returns ""
 * if we don't have everything we need to build the URL.
 *
 * Passing `duration` (seconds, from VaultMedia.duration which OF already
 * tells us in the vault listing) lets the relay skip its own ffprobe
 * step and start the extraction immediately.
 */
export function proxyScrubFrame(
  url: string | null | undefined,
  accountId: string | null | undefined,
  frameIdx: number,
  duration?: number | null,
  /** Per-hover session id. The cancel POST that fires on hover-end
   *  carries the SAME id so the server can scope the abort to this
   *  exact hover session — a delayed cancel from a previous hover of
   *  the same video can't abort a freshly-started build. */
  sessionId?: string | null,
): string {
  if (!url || !accountId) return "";
  if (url.startsWith("blob:") || url.startsWith("data:")) return "";
  const tok = resolveShareToken();
  const params = new URLSearchParams();
  params.set("u", url);
  params.set("account_id", accountId);
  params.set("i", String(frameIdx));
  if (typeof duration === "number" && duration > 0) {
    params.set("dur", String(duration));
  }
  if (sessionId) params.set("sid", sessionId);
  if (tok) params.set("t", tok);
  return `/img/scrub?${params.toString()}`;
}

export const relay = {
  get<T = unknown>(path: string, ctx?: RelayContext, signal?: AbortSignal): Promise<T> {
    return request<T>(path, { method: "GET", signal }, ctx);
  },
  /** Multipart POST — caller hands us the File; we wrap it in FormData
   *  and skip the default JSON Content-Type so the browser can set the
   *  multipart boundary. */
  uploadFile<T = unknown>(path: string, file: File, fieldName = "file", ctx?: RelayContext): Promise<T> {
    const form = new FormData();
    form.append(fieldName, file, file.name);
    return request<T>(path, { method: "POST", body: form }, ctx);
  },
  post<T = unknown>(path: string, body?: unknown, ctx?: RelayContext): Promise<T> {
    return request<T>(path, {
      method: "POST",
      body: body == null ? undefined : JSON.stringify(body),
    }, ctx);
  },
  patch<T = unknown>(path: string, body?: unknown, ctx?: RelayContext): Promise<T> {
    return request<T>(path, {
      method: "PATCH",
      body: body == null ? undefined : JSON.stringify(body),
    }, ctx);
  },
  put<T = unknown>(path: string, body?: unknown, ctx?: RelayContext): Promise<T> {
    return request<T>(path, {
      method: "PUT",
      body: body == null ? undefined : JSON.stringify(body),
    }, ctx);
  },
  delete<T = unknown>(path: string, ctx?: RelayContext): Promise<T> {
    return request<T>(path, { method: "DELETE" }, ctx);
  },
};

// ── Typed payload helpers ───────────────────────────────────────────
// These mirror the existing relay endpoints we'll consume in Phase A.8.
// Add new helpers when a screen needs them; resist building speculative
// surface area.

export interface Employee {
  id: number;
  display_name: string;
  color: string | null;
  is_active: boolean;
  created_at?: string | null;
}

export interface AccountMeta {
  id: string;
  nickname?: string | null;
  color?: string | null;
  incogniton_profile_id?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  has_session?: boolean;
}

export interface ProxyMeta {
  label: string;
  scheme: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  notes?: string;
  verified_ip?: string | null;
  verified_at?: string | null;
  assigned_account_id?: string | null;
  assigned_account?: { id: string; nickname?: string | null } | null;
}

export interface DriftReport {
  live_rev: string | null;
  live_known: boolean;
  live_fetched_at?: number | null;
  live_error?: string | null;
  any_drift: boolean;
  accounts: Array<{
    account_id: string;
    nickname?: string | null;
    has_session: boolean;
    session_rev: string | null;
    live_rev?: string | null;
    live_known?: boolean;
    drift: boolean;
    stale: boolean;
    captured_at?: string | null;
    reason?: string;
  }>;
}

export interface BootstrapResponse {
  ok: true;
  session_file: string;
  account_id: string;
  user_id: string;
  x_of_rev: string;
}

// ── OF chat / message shapes ────────────────────────────────────────
// These mirror what OF returns through the relay. Optional fields stay
// optional because OF's payloads vary by chat state. Keep field names
// in OF's camelCase (we don't re-shape on the relay).

export interface OFMediaFiles {
  thumb?: { url: string } | null;
  source?: { url: string } | null;
}
export interface OFMedia {
  id: number;
  type?: string;
  url?: string | null;
  files?: OFMediaFiles | null;
  hasError?: boolean;
}

export interface OFUserMini {
  id: number;
  name?: string;
  username?: string;
  avatar?: string | null;
  /** Team-set nickname from our SQLite, stitched onto /users/list by the
   *  relay. Overrides OF's display name in chat-list / pane / popout UIs
   *  so chatters see the label they chose everywhere. */
  customNickname?: string | null;
}

export interface OFMessage {
  id: number | string;       // negative for optimistic
  text: string;
  fromUser: OFUserMini;
  toUser?: OFUserMini;
  createdAt: string;
  changedAt?: string;
  isFree?: boolean;
  isOpened?: boolean;
  /** OF echoes a heart-react on chat messages via `isLiked`. We toggle
   *  it locally for optimistic feedback; the next message-list refetch
   *  reconciles with truth. */
  isLiked?: boolean;
  /** Pin state — flipped optimistically by useTogglePinMessage and
   *  reconciled by the next /messages refetch. OF returns it on every
   *  message in /chats/{id}/messages. */
  isPinned?: boolean;
  /** OF native quote-reply. Outgoing sends carry this through to OF's
   *  send body; incoming messages receive the field populated when the
   *  fan tapped "Reply" on one of our bubbles. */
  replyToMessageId?: number;
  /** Embedded snapshot of the quoted message (text/from/createdAt). OF
   *  sometimes populates this on read, sometimes only the id — when only
   *  the id is present we look up the original from the local cache. */
  replyToMessage?: {
    id: number;
    text?: string;
    fromUser?: OFUserMini;
    createdAt?: string;
    mediaCount?: number;
  } | null;
  price?: number;            // dollars
  isTip?: boolean;
  media: OFMedia[];
  mediaCount?: number;
  // Optimistic fields
  _pending?: boolean;
  _failed?: boolean;
  _failedReason?: string;    // human-readable upstream reason (OF error)
  _tempId?: number;
  /** Set on pseudo-rows synthesized from a local-wait scheduled send.
   *  `_fireAt` is the ISO timestamp the timer will deliver at. The
   *  MessageList renders these distinctly + offers a cancel button. */
  _isFutureScheduled?: boolean;
  _fireAt?: string;
}

export interface OFChatItem {
  id?: number;
  withUser: OFUserMini & { id: number };
  lastMessage?: {
    id: number;
    text?: string;
    fromUser?: OFUserMini;
    createdAt?: string;
    mediaCount?: number;
    isFree?: boolean;
    isTip?: boolean;
    lockedText?: boolean;
    isOpened?: boolean;
  };
  hasUnread?: boolean;
  /** OF's source-of-truth field. We mirror it to `hasUnread` in the
   *  chat-list normalizer so downstream code can keep using the boolean,
   *  but the count is handy when we want a "5" badge instead of a dot. */
  unreadMessagesCount?: number;
  lastReadMessageId?: number;
  isOnline?: boolean;
  /** OF gates outgoing sends per-chat (e.g., unsubscribed fans). When
   *  `canSendMessage` is false, sending the standard message endpoint
   *  returns 400 — `canNotSendReason` is OF's human-readable reason. */
  canSendMessage?: boolean;
  canNotSendReason?: string | null;
  isMutedNotifications?: boolean;
  // We attach this client-side after a fan-out so each row knows
  // which model account it came from (drives the colored dot).
  __accountId?: string;
}

export interface OFChatsResp {
  list?: OFChatItem[];
  chats?: OFChatItem[]; // some OF shapes return `list`, others `chats`
  hasMore: boolean;
}

export interface OFMessagesResp {
  list: OFMessage[];
  hasMore: boolean;
}

export interface AuditAction {
  id: number;
  employee_id: number | null;
  account_id: string | null;
  action: string;          // "POST /admin/accounts/..."
  target_type: string | null;
  target_id: string | null;
  payload: unknown;
  at: string | null;
}

export interface FanRecord {
  account_id: string;
  fan_id: number;
  of_username: string | null;
  of_display_name: string | null;
  avatar_url: string | null;
  custom_nickname: string | null;
  generated_nickname: string | null;
  real_name: string | null;
  his_age: string | null;
  home_country: string | null;
  home_city: string | null;
  hobbies: string | null;
  fetishes: string | null;
  self_description: string | null;
  description: string | null;
  notes: string | null;
  tags: string[];
  lifetime_spend_cents: number;
  bought_amount: number;
  subscription_status: string | null;
  subscribed_at: string | null;
  last_message_received_at: string | null;
  source: string;
  is_followed: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface FanUpdate {
  custom_nickname?: string | null;
  notes?: string | null;
  tags?: string[];
  real_name?: string | null;
  home_country?: string | null;
  home_city?: string | null;
  his_age?: string | null;
  hobbies?: string | null;
  fetishes?: string | null;
}

export interface SendMessageBody {
  text: string;
  locked_text?: boolean;
  price?: number;
  media_files?: Array<number | Record<string, unknown>>;
  is_couple_people_media?: boolean;
  is_forward?: boolean;
  /** OF native quote-reply target id. When set, the receiver renders
   *  the quoted message as a card above this bubble (matches OF web). */
  reply_to_message_id?: number;
}

// ── Vault ───────────────────────────────────────────────────────────

export interface VaultFile { url: string; width?: number; height?: number }
export interface VaultFiles {
  thumb?: VaultFile | null;
  preview?: VaultFile | null;
  squarePreview?: VaultFile | null;
  full?: VaultFile | null;
}
export interface VaultMedia {
  id: number;
  type: "photo" | "video" | "gif" | "audio" | string;
  isReady?: boolean;
  canView?: boolean;
  hasError?: boolean;
  createdAt?: string;
  duration?: number;
  files?: VaultFiles | null;
  videoSources?: { "720"?: string | null; "240"?: string | null } | null;
  /** When this attachment came from a fresh upload that OF hasn't finished
   *  transcoding, `_claim` holds the `{processId,host,name,extra}` dict that
   *  the message-send endpoint accepts in place of a vault id. */
  _claim?: Record<string, unknown>;
  /** Local blob URL for the original file — used by the optimistic
   *  outgoing bubble until reconcile pulls real CDN urls. */
  _localPreview?: string;
  /** True while the upload is still in flight — composer renders a
   *  spinner overlay on the chip so the user knows the file is
   *  attaching, not stuck. Cleared once `mutateAsync` resolves. */
  _uploading?: boolean;
}
export interface VaultMediaResp {
  list: VaultMedia[];
  hasMore: boolean;
}

export interface VaultList {
  id: number;
  type: "custom" | "media_stickers" | string;
  name: string;
  hasMedia: boolean;
  videosCount?: number;
  photosCount?: number;
  gifsCount?: number;
  audiosCount?: number;
}

export interface VaultListsResp {
  list: VaultList[];
  hasMore?: boolean;
}

/** Response from POST /api/of/v2/upload. `send_with` is the only field
 *  callers should write into a message body's `media_files`. */
/** OF's message-template / saved-reply.
 *  `template: "reply_on_subscribe"` is the magical welcome-message slot —
 *  exactly one per account. Everything else is a regular saved reply. */
export interface OFMessageTemplate {
  id: string;
  template?: string | null;
  text: string;
  displayText?: string;
  price?: number;
  lockedText?: boolean;
  mediaCount?: number;
  media?: Array<{
    id: number;
    type?: string;
    files?: VaultFiles | null;
  }>;
}

/** A saved reply stored in our local DB (NOT in OF). Saved replies
 *  share the editor with OF's welcome message, but the welcome is the
 *  only one OF actually accepts via /messages/templates — everything
 *  else is local. The media array is the same VaultMedia shape we
 *  carry through the rest of the app. */
export interface SavedReply {
  id: number;
  account_id: string;
  title?: string | null;
  text: string;
  price: number;          // dollars
  locked_text: boolean;
  media: Array<{
    id: number;
    type?: string;
    files?: VaultFiles | null;
  }>;
  created_at?: string | null;
  updated_at?: string | null;
}

/** A message queued for future delivery via OF's /messages/queue.
 *  Both direct (`userIds: [fanId]`) and mass (`userLists` / `groups`)
 *  sends land in the same queue; we surface both with a recipient hint. */
export interface OFScheduledMessage {
  id: number;
  text?: string;
  scheduledDate?: string;
  price?: number;
  lockedText?: boolean;
  mediaCount?: number;
  media?: Array<{
    id: number;
    type?: string;
    files?: VaultFiles | null;
  }>;
  /** Direct sends populate userIds; mass sends use userLists/groups. */
  userIds?: number[];
  userLists?: string[];
  groups?: string[];
  /** Echoed from relay so the UI can label which account a queued send belongs to. */
  __accountId?: string;
}

export interface VaultUploadResp {
  ready: boolean;
  deduped: boolean;
  vault_id: number | null;
  send_with: Array<number | Record<string, unknown>>;
  size?: number;
  filename?: string;
  note?: string;
  existing?: { id?: number; type?: string; files?: VaultFiles | null };
}
