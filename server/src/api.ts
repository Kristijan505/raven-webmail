import { Request, RequestHandler, Router } from "express"
import { validate, handler, ApiError, pageHandler, errMsg } from "./util";
import { authenticate, del, get, post, put, url, watch } from "./client";
import { json } from "body-parser";
import { StatusCodes } from "http-status-codes";
import { DISPLAY_ERRORS } from "./env";
import qs from "qs";
import { Config } from "./config";
import * as i18n from "./i18n/i18n";
import { RAVEN_SIGNATURE_META_KEY } from "./metadata";
import { Readable, Transform } from "stream";
import * as dns from "dns/promises";
import * as net from "net";
import * as http from "http";
import * as https from "https";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import ipaddr from "ipaddr.js";
import { accountsOf, establishSession, evictAccountFromOtherSessions, removeAccountFromSession, rotateSession, sessionCookieClearOptions, stubAccountInSession, usableAccount } from "./session";
import type { SessionAccount } from "./client";
import { decodeUnifiedCursor, encodeUnifiedCursor, mergeUnifiedRound, totalOf } from "./unified";
import type { UnifiedCursor, UnifiedCursorEntry, UnifiedRoundInput } from "./unified";
import { logger } from "./logger";

const fromWeb = (Readable as any).fromWeb as ((stream: any) => NodeJS.ReadableStream);

// Returns a Transform that passes bytes through unchanged but destroys the
// pipeline with an error once `maxBytes` have been seen. This enforces a hard
// download cap regardless of whether the upstream server sends Content-Length
// (chunked responses omit it, making a header-only check bypassable).
const byteLimiter = (maxBytes: number): Transform => {
  let seen = 0;
  return new Transform({
    decodeStrings: true,
    readableObjectMode: false,
    writableObjectMode: false,
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new Error(`Response exceeds ${maxBytes} byte limit`));
      } else {
        callback(null, chunk);
      }
    },
  });
};

// Allowed raster image MIME types for the proxy-image route. SVG is intentionally
// excluded: even though SVG is a valid image/* subtype, SVG files can contain
// <script> elements and event handlers that execute when opened directly in a tab
// or used as an <img> without a strict CSP. Raster formats cannot contain
// executable content and are safe to proxy.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/avif", "image/bmp", "image/tiff", "image/x-icon", "image/vnd.microsoft.icon",
]);

// Hard byte cap for proxied images (enforced both via Content-Length check
// and the byteLimiter Transform for chunked responses).
const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MiB

// Hard cap for attachment uploads proxied to WildDuck storage. The browser sends
// Content-Length for a File/Blob body (checked up-front -> 413), and the byteLimiter
// enforces the same ceiling while streaming so a hand-crafted chunked upload with no
// Content-Length can't stream past it.
const STORAGE_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MiB

// Image-proxy fetch budget: follow at most 3 redirect hops (each re-validated
// against private ranges) with an 8s per-hop timeout.
const MAX_IMAGE_REDIRECTS = 3;
const PROXY_FETCH_TIMEOUT_MS = 8000;

// Login throttling window/cap and the default message-list page size.
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX = 10;
const PAGE_SIZE_LIMIT = "50";

// Search query params the webmail actually uses. Forwarding req.query verbatim
// proxies the client-only `now` cache-buster and any undocumented WildDuck search
// param straight upstream; allow-list the ones the UI sends instead (extend this
// list here if the search UI grows filter fields). Mirrors the /messages allow-list.
const SEARCH_ALLOWED = ["query", "next", "limit"] as const;
const searchQueryString = (reqQuery: Request["query"]): string => {
  const out: Record<string, string> = {};
  for (const key of SEARCH_ALLOWED) {
    const v = reqQuery[key];
    if (typeof v === "string" && v) out[key] = v;
  }
  if (!out.limit) out.limit = PAGE_SIZE_LIMIT;
  return qs.stringify(out);
};

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  // "Add account": append to the accounts already in this session instead of
  // replacing them. Ignored when the session has none — that is a fresh login.
  add: z.boolean().optional(),
});
// Signature HTML is stored in WildDuck metadata and rendered in two places:
//   1. SignatureEditor (sandboxed iframe + DOMPurify before innerHTML assignment)
//   2. Compose window (sanitize() helper runs DOMPurify before draft creation)
// Both paths sanitise before display, so the XSS surface is limited to those
// renderers. We still cap length here to prevent trivially large payloads from
// being stored in user metadata (WildDuck has no built-in limit on metaData).
const SIGNATURE_MAX_BYTES = 512 * 1024; // 512 KiB — enough for any realistic signature
const SignatureSchema = z.object({
  html: z.string().max(SIGNATURE_MAX_BYTES, "Signature HTML exceeds maximum allowed size"),
});

// Profile fields the webmail is allowed to update. zod strips every other key,
// so a client cannot mass-assign sensitive WildDuck user fields (quota,
// disabled, spamLevel, ...) by sending them in the PUT /me body.
// The browser rejects passwords shorter than 6 (me/+page.svelte), but that is a UX
// affordance, not a control: a direct API call could set a one-character password.
// Mirror the rule here. The minimum also resolves an ambiguity in the refine below —
// an empty string used to satisfy `!body.password` ("no password change") while
// `update.password != null` further down would still try to apply it; now "" simply
// fails validation. The maximum keeps an unbounded string out of the hashing path.
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 256;

// Exported so the password policy is regression-tested (see security.test.ts).
export const MeSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  existingPassword: z.string().max(PASSWORD_MAX_LENGTH).optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
  // "Sign out this account on other devices." Only meaningful together with a
  // password change; the route defaults it to ON — the reflex after a break-in
  // must work without reading fine print, while routine rotation of a shared
  // mailbox is where a user deliberately unchecks it.
  evictOtherSessions: z.boolean().optional(),
}).refine(
  (body) => !body.password || !!body.existingPassword,
  { message: "existingPassword is required to change the password" }
);

// Rename a mailbox — the only field the UI sends is the new IMAP path.
const MailboxUpdateSchema = z.object({
  path: z.string().min(1),
});

// Bulk message operations: mark seen/unseen, flag/unflag, move to another mailbox.
// `message` is either a single numeric id or a comma-separated list / range that
// WildDuck's bulk-update endpoint accepts (e.g. "1,2,3" or "1:*").
const BulkMessageUpdateSchema = z.object({
  // WildDuck accepts a single numeric id, a comma-separated list ("1,2,3"),
  // a range ("1:5"), or the wildcard sentinel "1:*". Constrain to those
  // characters so arbitrary strings cannot be smuggled into the upstream URL.
  message: z.string().min(1).regex(/^[\d,: *]+$/, "Invalid message range"),
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  moveTo: z.string().min(1).optional(),
});

// Address used in draft creation (To / Cc / Bcc fields).
const AddressSchema = z.object({
  // WildDuck uses name: null when an address has no display name, and the reply
  // flow forwards message.from straight into the draft — so null must validate,
  // not just an omitted name (rejecting it broke replying to no-display-name
  // senders).
  name: z.string().nullable().optional(),
  address: z.string().min(1),
});

// Reference to a message being replied to or forwarded.
const ReferenceSchema = z.object({
  mailbox: z.string().min(1),
  id: z.number().int().positive(),
  action: z.enum(["reply", "replyAll", "forward"]),
  // `attachments` is a creation-time directive (raven sends true/false; WildDuck also
  // accepts an array of attachment ids). WildDuck does NOT round-trip it: a GET on a
  // saved draft returns `reference` as {mailbox,id,action} WITHOUT attachments, and
  // sending re-POSTs that reference — so requiring it here 400'd every reply/forward
  // send. Optional + accept both forms (same class of bug as the name:null fix above).
  attachments: z.union([z.boolean(), z.array(z.string())]).optional(),
});

// Draft creation body — mirrors createMessageBody() in app/src/lib/Compose/compose.ts.
// Zod strips any extra keys the client might inject before we proxy to WildDuck.
// Exported so the round-trip (reply/forward draft) behaviour is regression-tested.
export const CreateMessageSchema = z.object({
  draft: z.boolean().optional(),
  to: z.array(AddressSchema).optional(),
  cc: z.array(AddressSchema).optional(),
  bcc: z.array(AddressSchema).optional(),
  subject: z.string().optional(),
  html: z.string().max(5 * 1024 * 1024).optional(),
  text: z.string().max(5 * 1024 * 1024).optional(),
  files: z.array(z.string()).optional(),
  reference: ReferenceSchema.optional(),
});

// Mailbox ids that arrive in a JSON BODY are a different problem from the ones in the
// path. Path segments are scoped by userId(req) and hardened by seg(), but `moveTo` and
// `reference.mailbox` are forwarded to WildDuck verbatim, so tenancy for them rests
// entirely on WildDuck re-checking ownership against the token's user. It does — but
// that is a single layer between one user and another user's mail, in a product where
// the backend has historically had bugs in exactly this area. Check it here too.
//
// The id set is cached briefly to keep this off the hot path (a reply autosaves every
// ~1.5s and carries `reference` every time). A cache MISS always refetches before
// refusing, so a folder created seconds ago can still be used immediately — the cache
// can only ever save work, never cause a false rejection.
const MAILBOX_IDS_TTL_MS = 30_000;
// A cache miss forces a refetch (so a folder created seconds ago is usable right away),
// which means a caller feeding a stream of DISTINCT bogus ids would turn every request
// into an upstream call. Refresh at most this often, so that degrades to one call per
// window instead of one per request.
const MAILBOX_IDS_REFRESH_MIN_MS = 5_000;
// Entries are small, but a Map that only ever grows is still a leak in a long-lived
// process. Well above any realistic number of concurrently active users.
const MAILBOX_IDS_MAX_ENTRIES = 1_000;

const mailboxIdsCache = new Map<string, { ids: Set<string>; at: number }>();

// Drop a user's cached ids. Called whenever THIS server changes their mailbox list, so
// a folder can be used the instant it is created.
//
// Without it the refresh floor below turns into a false rejection: create a folder and
// move mail into it within five seconds, and both the normal and the forced lookup
// return the pre-creation set, so the BFF answers 403 for a folder the sidebar is
// already showing. The floor exists to stop a stream of invalid ids each costing an
// upstream call; invalidating here keeps that protection while removing the case where
// the cache can be wrong about the user's own action.
// delete-then-set so a refreshed entry moves to the end: a Map preserves insertion
// order and re-setting an existing key does not update it, so without the delete the
// eviction would drop whoever was seen first rather than least recently.
const cacheMailboxIds = (uid: string, ids: Set<string>): void => {
  mailboxIdsCache.delete(uid);
  if (mailboxIdsCache.size >= MAILBOX_IDS_MAX_ENTRIES) {
    const oldest = mailboxIdsCache.keys().next().value;
    if (oldest !== undefined) mailboxIdsCache.delete(oldest);
  }
  mailboxIdsCache.set(uid, { ids, at: Date.now() });
};

// Open /updates responses, so they can be closed when their session is evicted.
// Bounded by the number of connected clients and cleaned up when each disconnects.
//
// PROCESS-LOCAL, and that is a real limit on what sessionsEvicted can promise. Session
// records live in Mongo and are therefore shared, so after an eviction any NEW request
// fails auth on every instance. An already-open stream is different: it holds the
// WildDuck token it captured at open time in memory, and only the instance it is
// connected to can reach it. Run more than one instance and a password change closes
// the streams on the instance handling it while identical streams elsewhere keep
// delivering, with the flag still reporting a complete eviction.
//
// Deploying a single instance per environment is what makes the flag true today, so
// this holds as long as that does. Scaling out needs the eviction broadcast between
// instances (shared pub/sub) — or the flag downgraded to say what it can actually
// vouch for.
type LiveStream = { users: Set<string>; session: string; close: () => void };

// Split an upstream SSE byte stream into whole events (blank-line separated) so
// several upstreams can share one client response. Piping raw chunks would
// interleave PARTIAL frames: a TCP chunk can end mid-line, and two pipes writing
// into the same response corrupt each other's framing. Exported for tests.
export const sseEventSplitter = (onEvent: (event: string) => void) => {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      onEvent(buffer.slice(0, i + 2));
      buffer = buffer.slice(i + 2);
    }
  };
};
const liveStreams = new Set<LiveStream>();

// How long a partially-opened /updates response is served before it is closed so the
// browser reconnects and retries the accounts that failed. Long enough that a flapping
// upstream cannot turn this into a reconnect storm, short enough that a mailbox is
// never silently dead for a whole sitting.
const PARTIAL_STREAM_RETRY_MS = 30_000;

// How long one account's update stream may take to produce HEADERS before this
// connection gives up on it. watch() has no deadline of its own and the merged response
// waits for every account to settle — so a single upstream stalling before it answers
// left EVERY account without live updates for as long as it hung, with the
// partial-stream retry above not even armed yet. Giving up puts that one account in the
// degraded path, which is exactly what that retry is for.
const WATCH_OPEN_TIMEOUT_MS = 10_000;

// The same problem one layer down: resolveMailboxOwner asks each account in turn, and
// client.ts's get() has no deadline either — so an account whose mailbox list stalls
// without ever rejecting held up every mailbox page and action for the OTHER accounts
// indefinitely. Short, because this sits in front of ordinary navigation: a probe that
// slow is already a failure, and failing it just means asking the next account.
const OWNER_PROBE_TIMEOUT_MS = 5_000;

/** Reject with `error` if `work` has not settled in `ms`. The work itself runs on. */
const withDeadline = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ApiError(StatusCodes.GATEWAY_TIMEOUT, "Upstream timeout", "upstream_timeout")),
      ms,
    );
    work.then(
      value => { clearTimeout(timer); resolve(value); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });

const destroyStream = (stream: NodeJS.ReadableStream): void =>
  (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();

const watchWithDeadline = (userId: string, accessToken: string): Promise<NodeJS.ReadableStream> => {
  const ac = new AbortController();
  const opened = watch(userId, accessToken, ac.signal);
  let gaveUp = false;
  // A stream that turns up after the deadline still holds an upstream connection, and
  // there is no longer anyone here to read it.
  opened.then(stream => { if (gaveUp) destroyStream(stream); }).catch(() => {});
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    const timer = setTimeout(() => {
      gaveUp = true;
      // Cancel it. Without this the request stays pending upstream for as long as that
      // server keeps the socket, and the 30-second reconnect adds another every time.
      ac.abort();
      reject(new ApiError(StatusCodes.GATEWAY_TIMEOUT, "Upstream timeout", "upstream_timeout"));
    }, WATCH_OPEN_TIMEOUT_MS);
    opened.then(
      stream => { clearTimeout(timer); if (!gaveUp) resolve(stream); },
      (e: unknown) => { clearTimeout(timer); if (!gaveUp) reject(e); },
    );
  });
};

// The last eviction seen for a user: which session survived it, and a counter that
// only moves forward. A stream opening while an eviction runs would otherwise slip
// through — watch() is awaited before the stream can be registered, so an eviction
// that lands in that window finds nothing to close, reports success, and then the
// pending open registers a stream still holding the old token. Comparing the counter
// captured before the await against this tells that stream it was already evicted.
//
// Only ever needed to catch an open that was ALREADY in flight, which resolves in
// milliseconds — so entries are swept on write rather than kept for the life of the
// process. Without that the map would hold one row, with a user and session id in it,
// for every account that has ever changed a password since boot.
const EVICTION_MEMORY_MS = 10 * 60_000;

let evictionCounter = 0;
const lastEviction = new Map<string, { keep: string; at: number; ts: number }>();

const wasEvictedSince = (user: string, session: string, since: number): boolean => {
  const e = lastEviction.get(user);
  return !!e && e.at > since && e.keep !== session;
};

// Cut off every live update stream for this user except the session doing the change.
// Returns how many were closed.
const closeOtherLiveStreams = (user: string, keepSession: string): number => {
  const now = Date.now();
  for (const [key, entry] of lastEviction) {
    if (now - entry.ts > EVICTION_MEMORY_MS) lastEviction.delete(key);
  }
  lastEviction.set(user, { keep: keepSession, at: ++evictionCounter, ts: now });
  let closed = 0;
  for (const entry of [...liveStreams]) {
    if (!entry.users.has(user) || entry.session === keepSession) continue;
    liveStreams.delete(entry);
    try { entry.close(); closed++; } catch { /* already gone */ }
  }
  return closed;
};

// When a session was last told to drop its live streams, on the same monotonic
// counter so a captured value can be compared without touching clocks.
//
// closeSessionLiveStreams can only close what is already IN liveStreams, and an
// /updates response joins that set only after its watch() calls resolve. A change that
// lands inside that window — an account added or signed out, a password rotated with
// eviction unchecked — is therefore invisible to the close meant for it, and the
// response registers afterwards carrying the account set from before the change: no
// events for an account just added, live events for one just removed. None of those
// paths touch the eviction counter, so wasEvictedSince does not cover them.
let streamCloseCounter = 0;
const lastStreamClose = new Map<string, { at: number; ts: number }>();

const streamsClosedSince = (session: string, since: number): boolean =>
  (lastStreamClose.get(session)?.at ?? 0) > since;

// Close THIS session's own merged stream (per-account logout): the client's
// EventSource reconnects on its own and comes back subscribed only to the
// accounts that remain in the session.
const closeSessionLiveStreams = (session: string): void => {
  // Recorded BEFORE the sweep, so a response still resolving its watch() calls sees it
  // when it re-checks. Swept on write, like lastEviction and for the same reason.
  const now = Date.now();
  for (const [key, entry] of lastStreamClose) {
    if (now - entry.ts > EVICTION_MEMORY_MS) lastStreamClose.delete(key);
  }
  lastStreamClose.set(session, { at: ++streamCloseCounter, ts: now });
  for (const entry of [...liveStreams]) {
    if (entry.session !== session) continue;
    liveStreams.delete(entry);
    try { entry.close(); } catch { /* already gone */ }
  }
};

// Bumped by every invalidation. A refresh captures it before its upstream call and
// only writes the result if it has not moved: otherwise a lookup that started BEFORE a
// folder was created could land after the invalidation and put the pre-creation list
// back, timestamped now — and the refresh floor would then serve that stale set for
// five seconds, which is exactly the false 403 the invalidation exists to prevent.
// Discarding the write is safe: the caller still gets the ids it fetched, and the next
// lookup finds no entry and refetches.
let mailboxIdsGeneration = 0;

const forgetMailboxIds = (req: Request): void => {
  mailboxIdsCache.delete(userId(req));
  mailboxIdsGeneration++;
};

// Seed the cache from a mailbox list we are already returning to the client.
//
// Invalidation alone only covers folders created THROUGH this server. A folder made by
// an IMAP client or another webmail shows up in the sidebar as soon as the app fetches
// the list — and until now the cache could still be missing it, so the very next move
// or reply naming that folder got a 403 it did not deserve. Filling the cache from the
// same response the sidebar is built from keeps the two in step by construction, and
// costs nothing: the request has already happened.
const rememberMailboxIds = (req: Request, boxes: unknown, generation: number): void => {
  const results = (boxes as { results?: Array<{ id: unknown }> })?.results;
  if (!Array.isArray(results)) return;
  if (generation !== mailboxIdsGeneration) return;
  cacheMailboxIds(userId(req), new Set(results.map(b => String(b.id))));
};

// Per-ACCOUNT core, because bindMailboxAccount has to ask this question for every
// account in the session before any single account is "the" account.
const ownedMailboxIdsFor = async (account: SessionAccount & { token: string }, fresh: boolean): Promise<Set<string>> => {
  const hit = mailboxIdsCache.get(account.id);
  const age = hit ? Date.now() - hit.at : Infinity;
  // `fresh` asks to bypass the normal TTL, but not the refresh floor — see
  // forgetMailboxIds above for why that is safe.
  if (hit && age < (fresh ? MAILBOX_IDS_REFRESH_MIN_MS : MAILBOX_IDS_TTL_MS)) return hit.ids;

  const generation = mailboxIdsGeneration;
  const boxes = await get(`/users/${account.id}/mailboxes`, account.token);
  const ids = new Set<string>(((boxes?.results ?? []) as Array<{ id: unknown }>).map(b => String(b.id)));

  if (generation === mailboxIdsGeneration) cacheMailboxIds(account.id, ids);
  return ids;
};

const ownedMailboxIds = (req: Request, fresh: boolean): Promise<Set<string>> =>
  ownedMailboxIdsFor(activeAccount(req), fresh);

// Full mailbox metadata (path, specialUse, counters) per account, for the unified
// views and the layout badges. Separate from the id cache above: that one answers
// "is this id mine" and lives longer; this one carries counters, so it stays
// short. Fetching it also seeds the id cache — same response, free ownership
// refresh, with the usual generation guard.
const MAILBOX_META_TTL_MS = 15_000;
type MailboxMeta = { id: string; path: string; specialUse: string | null; unseen: number; total: number };
const mailboxMetaCache = new Map<string, { boxes: MailboxMeta[]; at: number }>();

/**
 * `fresh` skips the cache. The cache holds COUNTERS — unseen and total — and those
 * move with every arrival, read and delete. Serving them to a layout load is not the
 * same as serving them to an ownership check: the layout SEEDS the client's unified
 * badges, and nothing refetches that seed afterwards. A tab opened within the TTL of
 * some other tab's fetch would take counters that were already wrong and keep them
 * until an event happened to name the same mailbox — which, for a quiet mailbox, is
 * never. Ownership lookups are welcome to the cached copy; badge seeds are not.
 */
const mailboxesFor = async (
  account: SessionAccount & { token: string },
  fresh = false,
): Promise<MailboxMeta[]> => {
  const hit = mailboxMetaCache.get(account.id);
  if (!fresh && hit && Date.now() - hit.at < MAILBOX_META_TTL_MS) return hit.boxes;
  const generation = mailboxIdsGeneration;
  const json = await get(`/users/${account.id}/mailboxes?counters=true`, account.token);
  const boxes: MailboxMeta[] = ((json?.results ?? []) as Array<Record<string, unknown>>).map(b => ({
    id: String(b.id),
    path: String(b.path ?? ""),
    specialUse: (b.specialUse as string | null) ?? null,
    unseen: Number(b.unseen ?? 0),
    total: Number(b.total ?? 0),
  }));
  if (mailboxMetaCache.size >= MAILBOX_IDS_MAX_ENTRIES) {
    const oldest = mailboxMetaCache.keys().next().value;
    if (oldest !== undefined) mailboxMetaCache.delete(oldest);
  }
  mailboxMetaCache.set(account.id, { boxes, at: Date.now() });
  if (generation === mailboxIdsGeneration) cacheMailboxIds(account.id, new Set(boxes.map(b => b.id)));
  return boxes;
};

// The account's own From address, for telling outgoing mail from incoming. Read from
// WildDuck rather than from the session: `authentication.username` is whatever the user
// typed at the login prompt, which WildDuck resolves against usernames AND addresses —
// so it is not reliably the address messages are actually sent from.
//
// Cached because it is needed on every page of a filtered listing and effectively never
// changes. Same shape as the mailbox-id cache above, including the bound on entries.
// ALL of them, not just the primary: mail sent from an alias is still sent mail, and
// judging it by the primary address alone files it as received — in the list filter and
// in the move menu alike, since both answer the same question.
const ADDRESS_TTL_MS = 10 * 60_000;
const addressCache = new Map<string, { addresses: string[]; at: number }>();

export const ownAddresses = async (req: Request): Promise<string[]> => {
  const uid = userId(req);
  const hit = addressCache.get(uid);
  if (hit && Date.now() - hit.at < ADDRESS_TTL_MS) return hit.addresses;

  const list = await get(`/users/${uid}/addresses`, token(req));
  const addresses = ((list as { results?: Array<{ address?: unknown }> })?.results ?? [])
    .map(entry => String(entry?.address ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (!addresses.length) throw new ApiError(StatusCodes.BAD_GATEWAY, "Upstream error", "upstream_error");

  if (addressCache.size >= MAILBOX_IDS_MAX_ENTRIES) {
    const oldest = addressCache.keys().next().value;
    if (oldest !== undefined) addressCache.delete(oldest);
  }
  addressCache.set(uid, { addresses, at: Date.now() });
  return addresses;
};

/**
 * The WildDuck search query for one direction of mail within one mailbox.
 *
 * Built HERE, never accepted from the client. WildDuck's `q` is a full query language —
 * mailbox selectors, negation, boolean groups — and handing the client a passthrough
 * for it would undo the allow-listing the rest of this file does, for the sake of one
 * boolean. The client sends `direction`; the query is assembled from that plus the
 * session's own user.
 *
 * The folder selector is `in:`, NOT `mailbox:`. Both name the same thing on WildDuck's
 * master branch, but `mailbox:` was only added later and the deployed 1.46.25 has no
 * case for it — an unknown keyword is dropped without a word, which left `-from:me` as
 * the entire query and returned every received message in the ACCOUNT rather than in the
 * folder. `in:` has been there all along, resolves the id scoped to the user, and falls
 * back to a mailbox id that matches nothing when it cannot resolve.
 *
 * It goes INSIDE the query either way: WildDuck ignores the separate `mailbox` parameter
 * whenever `q` is present — the two take different code paths in its search handler — so
 * passing it alongside would silently search the whole account too.
 *
 * Addresses are NOT quoted. `from:"a@b.c"` looks like the careful thing to write and is
 * the opposite: logic-query-parser splits it into two tokens, `from:` with no value and
 * a bare `a@b.c`, and WildDuck then reads the second as a FULLTEXT term. The filter
 * silently stops being a sender filter — matching any message that merely mentions the
 * address, and for the negated half excluding them. Unquoted, it stays one token.
 *
 * Since quoting cannot do it, the address is kept safe by refusing anything that could
 * be read as syntax: whitespace would split the token, a quote would start a phrase.
 * Real WildDuck addresses are normalised and never look like that.
 *
 * The mailbox is repeated per branch rather than factored out in front. The parser has
 * no parentheses and binds `and` tighter than `or`, so `mailbox:X from:a or from:b`
 * parses as `(mailbox:X AND from:a) OR from:b` — the second alias unscoped, matching
 * across every folder in the account. Repeating it puts the selector inside both
 * branches, which is the same thing parentheses would have done.
 */
const SAFE_ADDRESS = /^[^\s"]+@[^\s"]+$/;

export const directionQuery = (mailbox: string, addresses: string[], direction: "in" | "out"): string => {
  const safe = addresses.filter(address => SAFE_ADDRESS.test(address));
  if (!safe.length) throw new ApiError(StatusCodes.BAD_GATEWAY, "Upstream error", "upstream_error");
  return direction === "out"
    ? safe.map(address => `in:${mailbox} from:${address}`).join(" or ")
    : `in:${mailbox} ${safe.map(address => `-from:${address}`).join(" ")}`;
};

const assertOwnsMailbox = async (req: Request, mailboxId: string): Promise<void> => {
  const id = String(mailboxId);
  if ((await ownedMailboxIds(req, false)).has(id)) return;
  if ((await ownedMailboxIds(req, true)).has(id)) return;
  throw new ApiError(StatusCodes.FORBIDDEN, "Invalid mailbox", "forbidden");
};

// Encode a single user-controlled URL path segment before interpolating it into
// the upstream WildDuck URL. Express decodes %2F/%3F/%26 inside a path param and
// the WHATWG URL parser collapses ../, which together let a crafted id climb
// above /users/{sessionUserId}/ to another user's data (cross-user IDOR) or
// inject query parameters. Rejecting separators and percent-encoding the rest
// neutralizes both vectors.
export const seg = (value: string | string[] | undefined): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\/\\]/.test(value) ||   // smuggled separators (e.g. decoded %2F) enable traversal
    value === "." || value === ".."   // dot-segments the URL parser would collapse
  ) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid path parameter", "invalid_path_parameter");
  }
  return encodeURIComponent(value);
};

// ---------------------------------------------------------------------------
// Which account does this request speak for?
//
// A session is a bag of signed-in accounts (accountsOf), and mailbox ObjectIds
// are globally unique — one Mongo collection for every user — so a mailbox id
// in the URL determines its owning account by itself. Resolution order:
//   1. the account BOUND by bindMailboxAccount(): mailbox-scoped routes pin the
//      owner of the path mailbox, and every userId()/token() call downstream
//      follows it — which is what keeps the upstream URLs, ownership checks and
//      caches speaking for the right account without rewriting any of them;
//   2. an explicit ?account=<id>: must be a member of this session (403
//      otherwise); naming a re-auth stub gets a distinct error so the client
//      can prompt for that account's password;
//   3. the first usable account — for a single-account session exactly the
//      pre-multi-account behavior.
const kAccount: unique symbol = Symbol("raven-resolved-account");

const sessionAccounts = (req: Request): SessionAccount[] => accountsOf(req.session);

export const activeAccount = (req: Request): SessionAccount & { token: string } => {
  const bound = (req as any)[kAccount] as (SessionAccount & { token: string }) | undefined;
  if (bound) return bound;
  const accounts = sessionAccounts(req);
  const wanted = typeof req.query.account === "string" && req.query.account ? req.query.account : null;
  if (wanted) {
    const hit = accounts.find(a => a.id === wanted);
    if (!hit) throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
    if (!usableAccount(hit)) throw new ApiError(StatusCodes.FORBIDDEN, "Account requires sign-in", "account_reauth_required");
    return hit;
  }
  const first = accounts.find(usableAccount);
  if (!first) throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
  return first;
};

export const token = (req: Request): string => activeAccount(req).token;

export const userId = (req: Request): string => activeAccount(req).id;

/**
 * Resolve the account for a PAGE load, leniently.
 *
 * activeAccount() is strict on purpose: an API request naming a re-auth stub must
 * fail rather than quietly act as a different account. Page loads are the opposite
 * case — their job is to render the app and tell the client what the session holds.
 * A tab pinned to an account that has since been stubbed (a colleague's shared
 * mailbox whose password changed) would otherwise 403, and pageHandler turns 403 into
 * a redirect to /login: the colleague gets signed out of the UI although their own
 * account still works, which is exactly what surgical eviction exists to prevent.
 * The client re-pins from the account the layout answers with.
 */
const bindPageAccount = (req: Request): void => {
  const accounts = sessionAccounts(req);
  const wanted = typeof req.query.account === "string" && req.query.account ? req.query.account : null;
  const asked = wanted ? accounts.find(a => a.id === wanted) : null;
  const chosen = (asked && usableAccount(asked)) ? asked : accounts.find(usableAccount);
  if (chosen) (req as any)[kAccount] = chosen;
  // Nothing usable: leave it unbound so activeAccount() throws the 403 that sends
  // the browser to the login page, which is the right answer for a dead session.
};

/**
 * Which signed-in account owns this mailbox — or null, with `unreachable` saying
 * whether that is an answer or merely an unanswered question.
 *
 * Cached pass over every account first, only then the fresh (refetching) pass, so one
 * account's stale cache cannot 403 a mailbox created seconds ago while a refetch for a
 * DIFFERENT account still lies ahead.
 *
 * Failures are collected rather than thrown. One account's mailbox list erroring used
 * to abort the whole search, so a folder owned by a perfectly healthy account was
 * refused — permanently, whenever the failing account happened to sort first and its
 * cache stayed empty. Shared by every caller precisely so that fix cannot hold in one
 * route and not the other, which is how it stood: the same loop was written out again
 * for unified bulk actions, and trashing a selection failed there for an account that
 * was never the problem.
 */
const resolveMailboxOwner = async (
  accounts: Array<SessionAccount & { token: string }>,
  id: string,
): Promise<{ owner: (SessionAccount & { token: string }) | null; unreachable: boolean }> => {
  let unreachable = false;
  for (const fresh of [false, true] as const) {
    for (const account of accounts) {
      const owned = await withDeadline(
        ownedMailboxIdsFor(account, fresh),
        OWNER_PROBE_TIMEOUT_MS,
      ).catch(e => {
        unreachable = true;
        logger.warn(
          { account: account.id, detail: String((e as any)?.message) },
          "mailbox owner lookup failed for one account",
        );
        return null;
      });
      if (owned?.has(id)) return { owner: account, unreachable };
    }
  }
  return { owner: null, unreachable };
};

// "Not yours" is only an honest answer if every account was actually asked.
// NOT_FOUND, deliberately, and not FORBIDDEN. pageHandler turns a 403 into a redirect
// to /login, and mounting that layout publishes a logout to every other tab — so a stale
// bookmark, a mistyped id or a folder deleted on another device made the whole browser
// look signed out while the session was perfectly valid. 403-to-login belongs to
// sessions with no usable account, which is a different thing. It also says less: a
// mailbox this session cannot see is indistinguishable from one that does not exist.
const noOwner = (unreachable: boolean): ApiError => unreachable
  ? new ApiError(StatusCodes.BAD_GATEWAY, "Upstream error", "upstream_error")
  : new ApiError(StatusCodes.NOT_FOUND, "Mailbox not found", "not_found");

// Pin the owning account of a path mailbox to the request. 403 when no account
// in the session owns it — a foreign id must not get an arbitrary token to
// travel with. Single-account sessions skip the pre-flight entirely and keep
// today's behavior: WildDuck scopes every URL by /users/{id}/ and answers 404
// for foreign ids itself.
const bindMailboxAccount = async (req: Request, rawMailbox: string | string[] | undefined): Promise<void> => {
  seg(rawMailbox); // shape-check early; separators and dot-segments are invalid everywhere
  const id = rawMailbox as string;
  const accounts = sessionAccounts(req).filter(usableAccount);
  if (!accounts.length) throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
  if (accounts.length === 1) {
    (req as any)[kAccount] = accounts[0];
    return;
  }
  const { owner, unreachable } = await resolveMailboxOwner(accounts, id);
  if (!owner) throw noOwner(unreachable);
  (req as any)[kAccount] = owner;
};

// Defense-in-depth CSRF guard for state-changing requests. SameSite=lax is the
// primary protection, but it is operator-overridable to "none"; this rejects any
// unsafe-method request whose Origin doesn't match the host. Requests with no
// Origin header (same-origin navigations, non-browser clients) pass through and
// remain gated by the session cookie.
const enforceSameOrigin = (config: Config): RequestHandler => (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  const origin = req.get("origin");
  if (!origin) return next();
  const reject = () => res.status(StatusCodes.FORBIDDEN).json({ error: { status: 403, message: errMsg(req, "cross_origin_blocked", "Cross-origin request blocked") } });
  let originUrl: URL | null = null;
  try { originUrl = new URL(origin); } catch { originUrl = null; }
  const reqHost = req.get("host");
  if (originUrl === null || !reqHost) return reject();
  // host:port must always match — a different-port app on the same hostname is a
  // separate origin that still shares the host-scoped cookie. (req's Host carries
  // the external host:port; Traefik preserves it.)
  if (originUrl.host.toLowerCase() !== reqHost.toLowerCase()) return reject();
  // Scheme is only enforced when our view of the protocol is trustworthy: direct
  // TLS, or a configured trusted proxy that sets X-Forwarded-Proto (req.protocol
  // honors it). Behind a TLS-terminating proxy WITHOUT trust_proxy, req.protocol is
  // the INTERNAL http while the browser sends Origin: https — a scheme check there
  // would wrongly reject same-origin login/draft/profile writes. Where we CAN
  // trust it, comparing scheme blocks a plain-HTTP same-host page under
  // same_site=none cookies.
  const schemeTrusted = config.ssl || (config.trust_proxy != null && config.trust_proxy !== false);
  if (schemeTrusted && originUrl.protocol !== `${req.protocol}:`) return reject();
  return next();
};

// --- Remote image proxy (SSRF-guarded) --------------------------------------
// Email image URLs are attacker-controlled, so the proxy MUST refuse to fetch
// internal/loopback/link-local/private addresses (e.g. http://wildduck:8080,
// http://169.254.169.254 cloud metadata, http://127.0.0.1). We resolve the host
// and reject any non-public IP before fetching, and re-validate across redirects.

// Classify an IP literal with ipaddr.js instead of hand-rolled IPv6 parsing.
// The old code matched only the dotted IPv4-mapped form (::ffff:127.0.0.1), but
// Node serializes those in hex (::ffff:7f00:1 / ::ffff:a9fe:a9fe for the cloud
// metadata IP), so a crafted email image URL like http://[::ffff:7f00:1]/ slipped
// the guard. ipaddr collapses mapped/compatible forms and knows every reserved
// range, so only ordinary public unicast is treated as safe.
export const isPrivateIp = (ip: string): boolean => {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // unparseable -> unsafe
  }
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  // Everything that isn't plain public unicast (loopback, private, link-local,
  // CGNAT, ULA, multicast, reserved, NAT64-embedded, …) is unsafe for the proxy.
  return addr.range() !== "unicast";
};

// Returns the parsed URL together with the validated IPs we will connect to, so
// the fetch can be pinned to them (see pinnedGet) instead of re-resolving the host.
export const assertPublicHttpUrl = async (raw: string): Promise<{ url: URL; ips: string[] }> => {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid image url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Unsupported image url scheme");
  }
  // An image proxy has no business opening arbitrary ports. The private-IP check below
  // only constrains WHICH host we reach, not which port: without this, a remote image
  // URL of the form https://public-host:22 (or :25, :3306, …) still passes, and
  // pinnedGet happily connects and writes an HTTP request at it — turning the proxy
  // into a port prober / service fingerprinter for public hosts, from our IP. An empty
  // port means "scheme default", which is exactly 80/443.
  if (u.port !== "" && u.port !== "80" && u.port !== "443") {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Image url port not allowed");
  }
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "");
  let ips: string[];
  if (net.isIP(host)) {
    ips = [host];
  } else {
    const records = await dns.lookup(host, { all: true }).catch(() => null);
    if (!records || records.length === 0) throw new ApiError(StatusCodes.BAD_REQUEST, "Cannot resolve image host");
    ips = records.map(r => r.address);
  }
  if (ips.some(isPrivateIp)) throw new ApiError(StatusCodes.BAD_REQUEST, "Image host not allowed");
  // Every resolved address passed the private-range check; keep them all so the
  // fetch can fall back from an unreachable address (e.g. an AAAA before an A on an
  // IPv4-only host) to a working one before failing.
  return { url: u, ips };
};

// GET with the TCP connection pinned to a pre-validated IP. assertPublicHttpUrl
// resolves+validates the host, and we connect to THAT address rather than letting
// fetch re-resolve — a DNS-rebinding host could otherwise answer with a public IP
// during validation and a private/link-local one for the actual fetch (TOCTOU),
// re-opening the SSRF. `servername` keeps TLS SNI and the Host header keeps
// routing on the original hostname; redirects are followed manually (re-validated).
const pinnedGetOne = (url: URL, ip: string, signal: AbortSignal): Promise<http.IncomingMessage> => {
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = lib.request({
      host: ip,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      servername: isHttps ? url.hostname : undefined,
      headers: { host: url.host, "user-agent": "RavenImageProxy/1.0", accept: "image/*" },
      timeout: PROXY_FETCH_TIMEOUT_MS,
      signal,   // aborts the in-flight request (even pre-headers) on client disconnect
    }, resolve);
    req.on("timeout", () => req.destroy(new Error("Proxy fetch timed out")));
    req.on("error", reject);
    req.end();
  });
};

// Try each validated address until one connects: a DNS set can list an
// unreachable AAAA before a working A (IPv4-only hosts), and all of them already
// passed the isPrivateIp check, so falling back stays within the SSRF guard.
const pinnedGet = async (url: URL, ips: string[], signal: AbortSignal): Promise<http.IncomingMessage> => {
  let lastErr: unknown;
  for (const ip of ips) {
    try { return await pinnedGetOne(url, ip, signal); }
    catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("No reachable address for image host");
};

// The rate-limit identity for a request. Anonymous callers key off the session id and
// nothing is minted for them; an authenticated one gets the durable key that survives
// rotation (session.ts). Every route these limiters guard is authenticated, so the mint
// happens on a session that is already being written anyway.
const throttleId = (req: Request): string =>
  req.session?.throttleKey ?? req.sessionID ?? "unauthenticated";

// Brute-force / credential-stuffing protection for the login endpoint. Only
// failed attempts count (skipSuccessfulRequests), so legitimate users are never
// locked out; keyed by client IP (honors trust proxy).
const loginLimiter = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  limit: LOGIN_RATE_MAX,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  // Resolve the 429 body per-request so it honors the caller's language. The i18n
  // middleware runs before this limiter (api.use order), so req.locale is set.
  message: (req: Request) => ({ error: { status: 429, message: errMsg(req, "too_many_logins", "Too many login attempts, please try again later") } }),
});

// The password-change path re-authenticates the current password (see PUT /me), which
// is an online credential check just like login — so it needs the same throttle, or a
// stolen/unattended session could brute-force the current password unlimited times and
// escalate to a full account takeover. Keyed by the session user (so IP rotation does
// not help), only FAILED changes count (skipSuccessfulRequests), and only requests that
// actually change the password are throttled (skip) so a plain name change is never
// limited.
const passwordChangeLimiter = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  limit: LOGIN_RATE_MAX,
  skipSuccessfulRequests: true,
  skip: (req) => req.body?.password == null,
  // Keyed per BROWSER (one browser = one human): with several accounts signed in,
  // switching accounts must not hand out a fresh bucket — and neither must ROTATING
  // the session, which is what the session id alone amounted to. throttleKey() spells
  // out the brute force that opened up.
  keyGenerator: (req) => throttleId(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: (req: Request) => ({ error: { status: 429, message: errMsg(req, "too_many_attempts", "Too many attempts, please try again later") } }),
});

// Everything except login and the password change was unthrottled, so one authenticated
// session could loop 25MB attachment uploads, image-proxy fetches, sends, or bulk
// mailbox operations as fast as the link allowed — cheap for the caller, expensive for
// us and for WildDuck behind us. Keyed by the session user, not the IP, so rotating
// addresses does not reset the budget. These ceilings sit far above real interactive
// use: they are here to stop a runaway script, not to pace a person.
const sessionLimiter = (name: string, limit: number) => rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  limit,
  // Same rotation-proof identity as the password throttle: a budget one can refill by
  // signing an account in is not a budget.
  keyGenerator: (req: Request) => `${name}:${throttleId(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req: Request) => ({ error: { status: 429, message: errMsg(req, "too_many_attempts", "Too many attempts, please try again later") } }),
});

const uploadLimiter = sessionLimiter("storage", 200);
const imageProxyLimiter = sessionLimiter("proxy-image", 1000);
const submitLimiter = sessionLimiter("submit", 100);
// Draft creation is the one write the UI makes on a timer: compose autosaves every
// ~1.5s while typing, and each save also deletes the previous message, so this is the
// cheapest write-amplification lever an authenticated script has. The ceiling has to
// clear real use — several compose windows autosaving continuously — hence the high
// number; it bounds a runaway, it does not pace a typist.
const draftLimiter = sessionLimiter("messages-create", 1200);
const bulkLimiter = sessionLimiter("bulk", 300);

export const api = (config: Config) => {
  const api = Router();

  api.use(json({ limit: config.json_body_limit || "1mb" }));

  api.use(i18n.middleware(config));

  api.use(enforceSameOrigin(config));

  api.get("/healthz", handler(async (_req, res) => {
    res.json({
      ok: true,
      uptime_s: Math.floor(process.uptime()),
      ts: new Date().toISOString(),
    });
  }))

  api.post("/login", loginLimiter, handler(async (req, res) => {
    const { username, password, add } = validate(() => LoginSchema.parse(req.body));
    const v = await authenticate(username, password);
    // Both branches go through establishSession — rotation, account bag, legacy mirror
    // and throttle identity are its business, not this route's.
    const mode = add && sessionAccounts(req).length ? "add" : "fresh";
    const established = await establishSession(req, mode, v);
    // The session was rotated away by a concurrent add — see establishSession. The
    // account IS signed in upstream; the browser just has to come back on the session
    // that survived, and the switcher will show it.
    if (!established) throw new ApiError(StatusCodes.CONFLICT, "Session changed, reload", "session_changed");
    const { previousId } = established;
    // The rotation orphans any /updates response opened under the OLD id: it keeps
    // piping the pre-add account set, and — because closing is matched by session id —
    // a later per-account logout would look right here and leave that one running. Cut
    // them; the client reconnects onto a stream that includes the new account.
    if (mode === "add") closeSessionLiveStreams(previousId);
    // Name the account so the client tab can point at it immediately.
    res.json({ id: v.id });
  }))

  api.post("/logout", handler(async (req, res) => {
    // Sign out ONE account when asked and at least one other usable account
    // remains; the whole session otherwise (also the pre-multi-account path).
    const one = typeof req.body?.account === "string" && req.body.account ? String(req.body.account) : null;
    const accounts = sessionAccounts(req);
    // Named an account this session no longer holds — another tab signed it out and
    // this one had not caught up yet. That is done, not a request to sign out
    // everything else: falling through to the destroy below took every remaining
    // healthy account with it.
    if (one && !accounts.some(a => a.id === one)) {
      res.json({});
      return;
    }
    if (one && accounts.some(a => a.id !== one && usableAccount(a))) {
      await removeAccountFromSession(req, one);
      // The merged update stream still carries the removed account's events;
      // close it and the EventSource reconnects with what remains.
      closeSessionLiveStreams(req.sessionID);
      res.json({});
      return;
    }
    // Destroy the server-side session record and clear the cookie so the
    // session id cannot be reused after logout (and so a fixated id is dropped).
    await new Promise<void>((resolve) => {
      req.session.destroy((err) => {
        if(err) console.error("Failed to destroy session on logout:", err);
        resolve();
      });
    });
    // Mirror the attributes the cookie was issued with, not just path/domain — a
    // Set-Cookie that does not match them may not overwrite what the browser stored.
    res.clearCookie(config.session_name || "raven.sid", sessionCookieClearOptions(config, req.secure));
    res.json({});
  }))

  /**
   * changed to use intertab with localStorage
   * this change makes raven-webmail fully stateless
   *  */ 
  /*
  api.get("/auth", handler(async (req, res) => {

    res.type("text/event-stream");

    const send = (data: {username: string | null}) => {
      try {
        res.write("data: " + JSON.stringify(data) + "\n\n", () => {})
      } catch(e) {}
    }

    send({ username: req.session.authentication?.username || null })

    const off = Auth.on(event => {
      if(event.sid === req.sessionID) {
        send({ username: event.username });
      }
    })

    let keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n", () => {})
      } catch(e) {}
    }, 5000)

    req.on("close", () => {
      clearInterval(keepalive);
      off();
    })
  }))
  */

  api.get("/updates", handler(async (req, res) => {
    const accounts = sessionAccounts(req).filter(usableAccount);
    if (!accounts.length) throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
    // Captured BEFORE the awaits: an eviction can land while watch() is in
    // flight, and this connection must not come up afterwards still carrying an
    // evicted token.
    const openedAt = evictionCounter;
    const closedAt = streamCloseCounter;
    // One upstream stream per account, multiplexed into this one response. The
    // events need no tagging: they carry mailbox ids, which are globally unique.
    const settled = await Promise.allSettled(accounts.map(a => watchWithDeadline(a.id, a.token as string)));
    const destroy = destroyStream;
    const kept: Array<{ account: SessionAccount; stream: NodeJS.ReadableStream }> = [];
    settled.forEach((result, i) => {
      if (result.status !== "fulfilled") {
        // A 403 here is WildDuck refusing the token, not the network having a bad
        // moment — the password changed elsewhere, or the token was revoked. Left
        // alone the entry keeps its token, stays usable, and the browser retries a
        // credential that can never work again on every reconnect, while the switcher
        // shows the account as fine and the unified views stay quietly short. Stub it
        // so it reads "sign in again"; anything else is genuinely worth retrying.
        const reason = result.reason as unknown;
        if (reason instanceof ApiError && reason.status === StatusCodes.FORBIDDEN) {
          const stubbed = accounts[i].id;
          void stubAccountInSession(req, stubbed).catch((e: unknown) => {
            logger.warn({ account: stubbed, detail: String((e as any)?.message) },
              "could not stub an account whose update stream was refused");
          });
        }
        return;
      }
      // The pre-registration window: an account evicted while its watch() was in
      // flight must not come up at all.
      if (wasEvictedSince(accounts[i].id, req.sessionID, openedAt)) destroy(result.value);
      else kept.push({ account: accounts[i], stream: result.value });
    });
    // A change to this session landed while watch() was in flight, and the close it
    // triggered could not reach a response that had not registered yet. Hand the
    // client a stream that ends immediately rather than one built on the account set
    // it is no longer entitled to; EventSource reconnects and gets the current one.
    if (streamsClosedSince(req.sessionID, closedAt)) {
      for (const item of kept) destroy(item.stream);
      logger.info({ session: req.sessionID }, "updates stream superseded before it registered");
      res.type("text/event-stream");
      res.end();
      return;
    }

    // Accounts that failed to open (or were evicted mid-flight) are simply missing
    // from this connection: it would otherwise pipe the others happily for hours
    // while that one mailbox never reports a single new message. Serve what we have,
    // then close so the browser's own EventSource retry reopens the full set.
    const degraded = kept.length < accounts.length;
    if (!kept.length) {
      // Single-account behavior preserved: an expired token surfaces its own
      // error (403 session_expired) rather than a generic one.
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failure) throw failure.reason;
      throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
    }
    res.type("text/event-stream");
    const live = new Set(kept);
    // Registered so a password change can cut this off. Each response captured
    // its WildDuck tokens when it opened and keeps piping regardless of what
    // happens to the session record afterwards — closing the stream here is what
    // makes sessionsEvicted honest.
    const entry: LiveStream = {
      users: new Set(kept.map(k => k.account.id)),
      session: req.sessionID,
      close: () => {
        for (const { stream } of live) destroy(stream);
        res.end();
      },
    };
    for (const item of kept) {
      // Whole events only: raw chunks from parallel upstreams interleave partial
      // frames (see sseEventSplitter).
      // Backpressure. res.write() returning false means the socket is full — a reader
      // that has stalled, or simply is slower than several busy accounts together — and
      // ignoring it lets Node buffer without bound until the connection closes. The
      // upstreams are paused until it drains, which is what pipe() used to do for us
      // before these streams were merged by hand.
      const push = sseEventSplitter(event => {
        if (res.writableEnded) return;
        if (!res.write(event)) {
          for (const { stream } of live) (stream as NodeJS.ReadableStream & { pause?: () => void }).pause?.();
          res.once("drain", () => {
            for (const { stream } of live) (stream as NodeJS.ReadableStream & { resume?: () => void }).resume?.();
          });
        }
      });
      item.stream.on("data", push);
      const gone = () => {
        live.delete(item);
        destroy(item.stream);
        // ANY upstream dying ends the whole response, not just the last one. The
        // others keep working, so nothing would ever prompt a reconnect — and this
        // account would go silent for the life of the tab: no EXISTS, no EXPUNGE, no
        // COUNTERS, with the list quietly out of date and no error to show for it.
        // Ending it lets EventSource reopen and rebuild the merge over every account,
        // which is the same recovery a partially-opened stream gets above.
        if (!res.writableEnded) res.end();
      };
      item.stream.on("end", gone);
      item.stream.on("error", gone);
    }
    liveStreams.add(entry);
    const retry = degraded
      ? setTimeout(() => { if (!res.writableEnded) res.end(); }, PARTIAL_STREAM_RETRY_MS)
      : null;
    if (degraded) {
      logger.warn(
        { session: req.sessionID, opened: kept.length, wanted: accounts.length },
        "updates stream opened without every account; closing for retry",
      );
    }
    const drop = () => {
      if (retry) clearTimeout(retry);
      liveStreams.delete(entry);
      for (const { stream } of live) destroy(stream);
    };
    res.on("close", drop);
    res.on("finish", drop);
  }))

  api.put("/me", passwordChangeLimiter, handler(async (req, res) => {
    const body = validate(() => MeSchema.parse(req.body));
    // existingPassword is a raven-only field: WildDuck's PUT /users/:id does NOT
    // verify the current password (a master-scoped token can set any password), so
    // the "existingPassword required" rule is only real if WE enforce it. When the
    // password is being changed, re-authenticate the current one first and reject
    // with 403 on mismatch — otherwise a hijacked (or left-open) session could
    // silently take over the account password. Never forward existingPassword.
    // evictOtherSessions is raven-only too; neither field may reach WildDuck.
    const { existingPassword, evictOtherSessions, ...update } = body;
    // The account being edited follows ?account= (activeAccount). Captured ONCE,
    // before any rotation, so the whole handler speaks for one account.
    const account = activeAccount(req);
    const id = account.id;
    if (update.password != null) {
      // Verify the current password by re-authenticating. Only a genuine credential
      // failure counts as "wrong password": WildDuck answers 403 (or resolves with
      // success:false). A transport/backend failure (WildDuck down -> 502/5xx, invalid
      // JSON) must surface as-is, not masquerade as an incorrect password.
      const auth = await authenticate(account.username, existingPassword ?? "")
        .catch((e) => {
          if (e instanceof ApiError && e.status === StatusCodes.FORBIDDEN) return null;
          throw e;
        });
      if (!auth || auth.success !== true) {
        throw new ApiError(StatusCodes.FORBIDDEN, "Current password is incorrect", "invalid_existing_password");
      }
    }
    const json = await put(`/users/${id}`, account.token, update);

    // Only meaningful for a password change; true otherwise so the client's check
    // (`sessionsEvicted === false`) never fires on a plain name update.
    let sessionsEvicted = true;
    // Captured BEFORE rotation: the id a stolen copy of this cookie is riding.
    const preRotateSession = req.sessionID;
    // ON unless explicitly unchecked — the reflex after a break-in must work
    // without reading fine print; routine rotation of a shared mailbox is where
    // the user deliberately unchecks it.
    const evictRequested = update.password != null && evictOtherSessions !== false;

    if (update.password != null) {
      // The rotation happens UNCONDITIONALLY: a stolen COPY of this cookie rides
      // the current session id, and the password change is the moment to strand
      // it (see rotateSession). What the checkbox governs is OTHER sessions —
      // and there the eviction is surgical: the account is stubbed out of them
      // (needsReauth, token stripped) so a colleague with ten shared mailboxes
      // loses exactly this one, visibly, and keeps the other nine. Their open
      // update streams are closed too; the EventSource reconnects without the
      // evicted account, so the flag stays honest about live listeners.
      //
      // Runs AFTER the change, and its failure is reported rather than thrown:
      // the password HAS changed by this point, so a 5xx would tell the user the
      // opposite of the truth — but they must also not read "Password updated"
      // and believe devices were signed out when they were not.
      sessionsEvicted = await rotateSession(req)
        .then(async () => {
          // ALWAYS, checkbox or not. Rotation destroys the old session record, but an
          // /updates response opened under it holds its own WildDuck watches and keeps
          // delivering mailbox events — arrivals, counters, expunges — to whoever holds
          // the copied cookie. API access dies with the record; this is what stops the
          // event feed. The honest browser reconnects with its new cookie.
          closeSessionLiveStreams(preRotateSession);
          if (!evictRequested) return true;
          const count = await evictAccountFromOtherSessions(id, req.sessionID);
          const streams = closeOtherLiveStreams(id, req.sessionID);
          logger.info({ count, streams }, "account evicted from other sessions after password change");
          return true;
        })
        .catch((e: any) => {
          logger.error(
            { detail: String(e?.message) },
            "password changed but rotation/eviction could not be completed",
          );
          return false;
        });
    }

    res.json({ ...json, sessionsEvicted, evictionRequested: evictRequested });
  }))

  api.put("/signature", handler(async (req, res) => {
    const { html } = validate(() => SignatureSchema.parse(req.body));
    const body = { metaData: {[RAVEN_SIGNATURE_META_KEY]: html } };
    const json = await put(`/users/${userId(req)}`, token(req), body);
    res.json(json);
  }))

  api.get("/mailboxes", handler(async (req, res) => {
    const generation = mailboxIdsGeneration;
    const json = await get(`/users/${userId(req)}/mailboxes?counters=true`, token(req));
    rememberMailboxIds(req, json, generation);
    res.json(json);
  }))

  api.post("/mailboxes", handler(async (req, res) => {
    const path = String(req.body?.path?.trim() || "");
    if(!path) throw new ApiError(StatusCodes.BAD_REQUEST, "'path' is required", "path_required");
    const json = await post(`/users/${userId(req)}/mailboxes`, token(req), { path });
    forgetMailboxIds(req);
    res.json(json);
  }))

  api.delete("/mailboxes/:mailbox", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    await del(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req));
    forgetMailboxIds(req);
    res.json({});
  }))

  api.put("/mailboxes/:mailbox", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const body = validate(() => MailboxUpdateSchema.parse(req.body));
    const json = await put(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req), body);
    forgetMailboxIds(req);
    res.json(json);
  }))

  api.get("/mailboxes/:mailbox/messages", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    // Allow-list the two params the UI sends (pagination cursor + page size).
    // Forwarding req.query verbatim would let clients inject undocumented
    // WildDuck params (metaData, threadCounters, unseen, etc.).
    const allowed: Record<string, string> = {};
    if (typeof req.query.next === "string" && req.query.next) allowed.next = req.query.next;
    if (typeof req.query.limit === "string" && req.query.limit) allowed.limit = req.query.limit;

    // Filtering by direction goes through WildDuck's search, not the mailbox listing —
    // that is the only endpoint that can express "from me" and, with negation, "not
    // from me". Deliberately the SAME route and the same response shape as the
    // unfiltered listing: total, nextCursor and the page all describe the filtered set,
    // so a page stays a full page and the counter counts what is on screen. Doing it in
    // the client would have meant paging until enough rows survived a local filter, and
    // a count that could not be trusted.
    const direction = req.query.direction;
    if (direction === "in" || direction === "out") {
      const mailbox = seg(req.params.mailbox);
      const q = directionQuery(mailbox, await ownAddresses(req), direction);
      const body = await get(`/users/${userId(req)}/search?${qs.stringify({ ...allowed, q })}`, token(req));
      // Search omits specialUse; the list UI reads it off the mailbox it already holds,
      // but keep the shape identical so nothing downstream has to know which endpoint
      // answered.
      res.json({ specialUse: null, ...(body as object) });
      return;
    }

    const qsStr = qs.stringify(allowed);
    const body = await get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages${qsStr ? "?" + qsStr : ""}`, token(req));
    res.json(body);
  }))

  api.put("/mailboxes/:mailbox/messages", bulkLimiter, handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const body = validate(() => BulkMessageUpdateSchema.parse(req.body));
    // moveTo relocates real mail, so confirm the destination is the caller's own.
    if (body.moveTo != null) await assertOwnsMailbox(req, body.moveTo);
    const json = await put(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req), body);
    res.json(json);
  }))

  api.post("/mailboxes/:mailbox/messages", draftLimiter, handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const body = validate(() => CreateMessageSchema.parse(req.body));
    // `reference` makes WildDuck read the referenced message to build the quoted body
    // and carry attachments across — a read primitive pointed at a mailbox id the
    // client chose, so it gets the same ownership check as moveTo.
    if (body.reference?.mailbox != null) await assertOwnsMailbox(req, body.reference.mailbox);
    const json = await post(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req), body);
    res.json(json);
  }))

  api.delete("/mailboxes/:mailbox/messages", bulkLimiter, handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    await del(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req));
    res.json({});
  }))

  api.get("/mailboxes/:mailbox/messages/:message", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const body = await get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}`, token(req));
    res.json(body);
  }))

  api.delete("/mailboxes/:mailbox/messages/:message", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const body = await del(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}`, token(req));
    res.json(body);
  }))

  api.put("/mailboxes/:mailbox/messages/:message/flag", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const value = !!req.body.value;
    // Validate the message id is a numeric string before embedding it in the
    // bulk-update body sent to WildDuck (it is not in the URL path here, so
    // seg() does not apply, but we still must reject arbitrary values).
    // seg() also rejects empty / non-string / separator values.
    const messageId = seg(req.params.message);
    if (!/^\d+$/.test(messageId)) {
      throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid message id", "invalid_message_id");
    }
    const body = await put(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req), {
      message: messageId,
      flagged: value,
    })

    res.json(body);
  }))

  api.post("/mailboxes/:mailbox/messages/:message/submit", submitLimiter, handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    // The submit endpoint takes no meaningful client-supplied fields — the draft
    // to send is identified by the URL params alone. Accept an empty body only.
    const body = await post(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}/submit`, token(req), {});
    res.json(body);
  }))

  api.get("/mailboxes/:mailbox/messages/:message/attachments/:attachment", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const back = await fetch(url(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}/attachments/${seg(req.params.attachment)}`), {
      headers: { "x-access-token": token(req) }
    }).catch(e => {
      throw new ApiError(502, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway", "bad_gateway");
    });

    if(back.ok) {
      const contentType = back.headers.get("content-type");
      const contentLength = back.headers.get("content-length");
      if(contentType) res.setHeader("content-type", contentType);
      if(contentLength) res.setHeader("content-length", contentLength);
      // Never let an attacker-supplied attachment (e.g. text/html or SVG) render
      // as a document in our own origin: force a download disposition and stop
      // content-type sniffing. Inline <img> embedding of cid images still works
      // because subresource loads ignore Content-Disposition.
      res.setHeader("x-content-type-options", "nosniff");
      const disposition = back.headers.get("content-disposition");
      if(disposition && /filename/i.test(disposition)) {
        res.setHeader("content-disposition", disposition.replace(/^\s*inline/i, "attachment"));
      } else {
        res.setHeader("content-disposition", "attachment");
      }
      if(back.body) {
        fromWeb(back.body as any).pipe(res);
      } else {
        res.end();
      }
    } else {
      res.status(back.status);
      res.end("Cannot GET attachment");
    }
  }));

  api.get("/mailboxes/:mailbox/messages/:message/source", handler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    const back = await fetch(url(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}/message.eml`), {
      headers: { "x-access-token": token(req) }
    }).catch(e => {
      throw new ApiError(502, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway", "bad_gateway");
    });

    if(back.ok) {
      // Force the untrusted raw RFC822 source to be treated as plain text and
      // never sniffed/rendered as HTML in our own origin. Inline so it opens in
      // a browser tab (like Gmail's "Show original") rather than downloading.
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("content-disposition", "inline");
      if(back.body) {
        fromWeb(back.body as any).pipe(res);
      } else {
        res.end();
      }
    } else {
      res.status(back.status);
      res.end("Cannot GET message source");
    }
  }));

  api.get("/search", pageHandler(async (req, res) => {
    const json = await get(`/users/${userId(req)}/search?${searchQueryString(req.query)}`, token(req));
    res.json(json)
  }))

  // -------------------------------------------------------------- unified views
  // "All inboxes" / "all sent": one upstream page per account, merged newest
  // first. VIRTUAL — no message moves anywhere; every row keeps living in its own
  // account's real mailbox, and the per-message routes keep working through the
  // mailbox id each row carries. Cursor & merge contract: unified.ts.
  //
  // `total` sums EVERY account named by the outgoing cursor, not just the ones
  // that answered this round: an account that runs out is carried as `done` and
  // stops producing rounds, so a round-only sum made the toolbar count shrink as
  // the reader paged. Each cursor entry remembers its own account's total.
  const unifiedMessages = (view: "inbox" | "sent") => handler(async (req, res) => {
    const accounts = sessionAccounts(req).filter(usableAccount);
    if (!accounts.length) throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ""), 10) || Number(PAGE_SIZE_LIMIT), 1), 250);
    let incoming: UnifiedCursor = {};
    if (typeof req.query.next === "string" && req.query.next) {
      const decoded = decodeUnifiedCursor(req.query.next);
      if (!decoded) throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid cursor", "invalid_cursor");
      incoming = decoded;
    }

    const rounds: UnifiedRoundInput[] = [];
    const carried: UnifiedCursor = {};
    let carriedMore = false;

    const settled = await Promise.allSettled(accounts.map(async account => {
      const entry: UnifiedCursorEntry = incoming[account.id] ?? { cursor: null, skip: 0 };
      if (entry.done) return { entry, round: null as UnifiedRoundInput | null };
      const boxes = await mailboxesFor(account);
      const box = view === "inbox"
        ? boxes.find(b => b.path === "INBOX")
        : boxes.find(b => b.specialUse === "\\Sent");
      // An account without the folder contributes nothing, permanently.
      if (!box) return { entry: { cursor: null, skip: 0, done: true as const }, round: null };
      const params: Record<string, string> = { limit: String(limit) };
      if (entry.cursor) params.next = entry.cursor;
      const json = await get(`/users/${account.id}/mailboxes/${box.id}/messages?${qs.stringify(params)}`, account.token);
      const round: UnifiedRoundInput = {
        account: account.id,
        username: account.username,
        results: (json?.results ?? []) as UnifiedRoundInput["results"],
        skip: entry.skip,
        pageCursor: entry.cursor,
        nextCursor: (json?.nextCursor ?? false) as string | false,
        total: Number(json?.total ?? 0),
      };
      return { entry, round };
    }));

    settled.forEach((result, i) => {
      const account = accounts[i];
      if (result.status === "fulfilled") {
        if (result.value.round) rounds.push(result.value.round);
        else carried[account.id] = result.value.entry; // done accounts ride along
        return;
      }
      // One account's upstream failing must not blank the other inboxes: its
      // cursor entry is carried VERBATIM so the next round picks it back up, and
      // this page is served from the accounts that answered.
      logger.warn(
        { account: account.id, detail: String((result.reason as any)?.message) },
        "unified view: account fetch failed",
      );
      carried[account.id] = incoming[account.id] ?? { cursor: null, skip: 0 };
      carriedMore = true;
    });

    // Every account failed: that is an outage, not an empty mailbox.
    if (!rounds.length && carriedMore) {
      throw new ApiError(StatusCodes.BAD_GATEWAY, "Upstream error", "upstream_error");
    }

    const merged = mergeUnifiedRound(rounds, limit);
    const cursor = { ...merged.cursor, ...carried };
    const hasMore = merged.hasMore || carriedMore;
    res.json({
      success: true,
      total: totalOf(cursor),
      page: 1,
      previousCursor: false,
      nextCursor: hasMore ? encodeUnifiedCursor(cursor) : false,
      specialUse: null,
      // Says out loud that an account is missing from these rows. Serving what answered
      // keeps the view alive, but the client cannot tell that from a genuinely shorter
      // list — and it REPLACES its rows on a first-page refresh, so an unmarked partial
      // page would erase every row of the failed account, and every older page with it.
      partial: carriedMore,
      results: merged.results,
    });
  });

  api.get("/unified/inbox/messages", unifiedMessages("inbox"));
  api.get("/unified/sent/messages", unifiedMessages("sent"));

  // Bulk actions over a unified selection. Trash and spam need each message's OWN
  // account's folder — the client cannot know another account's Trash id — so the
  // grouping happens here: (mailbox, message) pairs, grouped by mailbox, owning
  // account bound per group exactly like the path-scoped routes bind theirs, that
  // account's Trash/Junk resolved, one bulk PUT per source mailbox.
  const UnifiedBulkSchema = z.object({
    action: z.enum(["trash", "spam"]),
    items: z.array(z.object({
      mailbox: z.string().min(1),
      message: z.number().int().positive(),
    })).min(1).max(1000),
  });

  api.put("/unified/messages", bulkLimiter, handler(async (req, res) => {
    const { action, items } = validate(() => UnifiedBulkSchema.parse(req.body));
    const accounts = sessionAccounts(req).filter(usableAccount);
    if (!accounts.length) throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");

    const groups = new Map<string, number[]>();
    for (const item of items) groups.set(item.mailbox, [...(groups.get(item.mailbox) ?? []), item.message]);

    // Plan first, move second. Issuing each PUT as its group resolved meant a later
    // group with no Trash folder — or a mailbox no account owns — failed the request
    // AFTER earlier groups had already moved: the client shows an error and keeps the
    // whole selection, while part of the action quietly stands. Every predictable
    // refusal is now raised before the first message moves. The move pass can still
    // break midway on a transport failure, which nothing can prevent, but it no longer
    // does so over a folder we knew about all along.
    const plan: Array<{ owner: SessionAccount & { token: string }; mailboxId: string; ids: number[]; target: string }> = [];
    for (const [mailboxId, ids] of groups) {
      // A mailbox no account owns must not pick an arbitrary token to travel with.
      const { owner, unreachable } = await resolveMailboxOwner(accounts, mailboxId);
      if (!owner) throw noOwner(unreachable);
      const boxes = await mailboxesFor(owner);
      const target = action === "trash"
        ? boxes.find(b => b.specialUse === "\\Trash")
        : boxes.find(b => b.specialUse === "\\Junk");
      if (!target) throw new ApiError(StatusCodes.CONFLICT, "Folder not available", "folder_not_available");
      plan.push({ owner, mailboxId, ids, target: target.id });
    }

    for (const step of plan) {
      await put(`/users/${step.owner.id}/mailboxes/${seg(step.mailboxId)}/messages`, step.owner.token, {
        message: step.ids.join(","),
        moveTo: step.target,
      });
    }
    res.json({ success: true });
  }));

  api.post("/storage", uploadLimiter, handler(async (req, res) => {
    const contentType = String(req.headers["content-type"] || "");
    const contentLength = String(req.headers["content-length"] || "");
    
    let headers: Record<string, string> = {
      "x-access-token": token(req),
    }

    contentType && (headers["content-type"] = contentType);
    contentLength && (headers["content-length"] = contentLength);

    // Reject an oversized upload before streaming a single byte when the browser
    // declares its size (File/Blob bodies always send Content-Length).
    if (Number(contentLength || "0") > STORAGE_SIZE_LIMIT) {
      throw new ApiError(StatusCodes.REQUEST_TOO_LONG, "Attachment too large", "attachment_too_large");
    }

    // Allow-list the two params the upload UI sends; forwarding req.query
    // verbatim would expose undocumented WildDuck storage params.
    const storageAllowed: Record<string, string> = {};
    if (typeof req.query.filename === "string" && req.query.filename) storageAllowed.filename = req.query.filename;
    if (typeof req.query.contentType === "string" && req.query.contentType) storageAllowed.contentType = req.query.contentType;
    const storageQs = qs.stringify(storageAllowed);

    // Hard-cap the stream too: a hand-crafted chunked upload omits Content-Length and
    // would slip the check above, so the byteLimiter tears the request down the moment
    // it exceeds the ceiling (and we destroy req so nothing keeps reading).
    const limiter = byteLimiter(STORAGE_SIZE_LIMIT);
    limiter.on("error", () => req.destroy());
    req.pipe(limiter);

    const back = await fetch(url(`/users/${userId(req)}/storage${storageQs ? "?" + storageQs : ""}`), {
      method: "POST",
      headers: headers,
      body: limiter as any,
      duplex: "half" as any,
    } as any).catch(e => {
      throw new ApiError(502, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway", "bad_gateway");
    })

    const json = await back.json().catch(e => {
      throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Invalid JSON from backend", "bad_gateway");
    })

    if(json?.error) {
      // Same treatment as client.ts's Requester. This route builds its own fetch()
      // (it streams the upload body), so it never passed through that hardening and
      // was still echoing the raw upstream message — internal paths, storage ids —
      // straight to the browser.
      const status = back.ok ? StatusCodes.INTERNAL_SERVER_ERROR : back.status;
      if(DISPLAY_ERRORS) throw new ApiError(status, String(json.error));
      throw new ApiError(status, "The mail server could not process the request", "backend_error");
    }

    res.status(back.status).json(json);
  }))

  api.get("/proxy-image", imageProxyLimiter, handler(async (req, res) => {
    // Require an authenticated session so this can never be used as an open proxy.
    if (!sessionAccounts(req).some(usableAccount)) {
      throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
    }
    // Only same-origin loads (the app and the message iframe) and direct address-bar
    // navigations are legitimate here. enforceSameOrigin skips GETs, so without this
    // a third-party page — including one on a SIBLING subdomain (Sec-Fetch-Site:
    // same-site) under a shared parent domain — could embed this authenticated GET
    // as <img>; the browser would attach the session cookie, turning it into a blind
    // authenticated image proxy. Sec-Fetch-Site is unspoofable from script: allow
    // only "same-origin" and "none" (direct/bookmark); reject "same-site" and
    // "cross-site". An absent header (old browsers) falls through to the session check.
    const fetchSite = req.get("sec-fetch-site");
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
    }

    // Abort the outbound fetch the moment the client disconnects — including while
    // we're still awaiting response headers, before the streaming pipe is wired up.
    // Registered here (not after the loop) so a client can't fire many slow-host
    // fetches and disconnect to tie up sockets until the per-hop timeout.
    const ac = new AbortController();
    let upstream: http.IncomingMessage | null = null;
    res.on("close", () => { ac.abort(); upstream?.destroy(); });

    let target = await assertPublicHttpUrl(String(req.query.url || ""));

    // Follow up to 3 redirects, re-validating AND re-pinning each hop.
    for (let i = 0; i <= MAX_IMAGE_REDIRECTS; i++) {
      upstream = await pinnedGet(target.url, target.ips, ac.signal).catch(() => {
        throw new ApiError(StatusCodes.BAD_GATEWAY, "Cannot fetch image");
      });

      const status = upstream.statusCode || 0;
      if (status >= 300 && status < 400) {
        const location = upstream.headers.location;
        upstream.destroy(); // close the redirect response; only its Location was needed
        if (!location) break;
        target = await assertPublicHttpUrl(new URL(location, target.url).toString());
        continue;
      }
      break;
    }

    const status = upstream?.statusCode || 0;
    if (!upstream || status < 200 || status >= 300) {
      upstream?.destroy();
      throw new ApiError(StatusCodes.BAD_GATEWAY, "Cannot fetch image");
    }

    const contentType = (upstream.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      upstream.destroy();
      throw new ApiError(StatusCodes.UNSUPPORTED_MEDIA_TYPE, "Not a supported image type");
    }

    // Reject immediately if Content-Length is present and already over the limit.
    const contentLength = Number(upstream.headers["content-length"] || "0");
    if (contentLength > IMAGE_SIZE_LIMIT) {
      upstream.destroy();
      throw new ApiError(StatusCodes.BAD_GATEWAY, "Image too large");
    }

    res.setHeader("content-type", contentType);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=86400");
    // upstream is a Node Readable; enforce the byte cap while streaming so servers
    // omitting Content-Length (chunked) cannot bypass the check.
    const limiter = byteLimiter(IMAGE_SIZE_LIMIT);
    limiter.on("error", () => {
      // Abort both the upstream read and the response mid-stream — the client gets
      // a truncated body + reset, the right outcome once headers are flushed.
      upstream!.destroy();
      res.destroy();
    });
    // If upstream aborts/errors mid-body (e.g. closes the socket before delivering
    // its promised Content-Length), tear down the client response too — otherwise
    // the image load hangs and ties up the connection.
    const abortDownstream = () => { if (!res.destroyed) res.destroy(); };
    upstream.on("error", abortDownstream);
    upstream.on("aborted", abortDownstream);
    // (client-disconnect teardown is wired above, before the fetch, so it also
    // covers a disconnect while awaiting headers; limiter auto-destroys with upstream.)
    upstream.pipe(limiter).pipe(res);
  }))

  const pages = Router();
  
  api.use("/pages", pages);

  pages.use((req, _res, next) => { bindPageAccount(req); next(); });

  pages.get("/layout", pageHandler(async (req, res) => {
    const generation = mailboxIdsGeneration;
    // Addresses come along so the client can answer "did I send this?" the same way the
    // server does when it filters a folder. Two answers to one question drift apart:
    // the list would call a message sent while the move menu offered to put it back in
    // the Inbox. Failing to read them is not worth failing the whole page over — the
    // move menu then falls back to the primary address, which is what it used before.
    const [user, boxes, addresses] = await Promise.all([
      get(`/users/${userId(req)}`, token(req)),
      get(`/users/${userId(req)}/mailboxes?counters=true`, token(req)),
      ownAddresses(req).catch(() => [] as string[]),
    ])
    rememberMailboxIds(req, boxes, generation);

    // Unified sidebar entries need every account's INBOX and Sent: the id sets
    // let the client reconcile SSE events (mailbox ids are globally unique), and
    // the summed counters seed the badges until live COUNTERS events take over.
    // One bounded, briefly-cached fetch per ADDITIONAL account; a single-account
    // session gets null — a unified view of one account is just that account.
    const usableAll = sessionAccounts(req).filter(usableAccount);
    let unified: null | {
      inbox: Array<{ id: string; unseen: number; total: number }>;
      sent: Array<{ id: string; total: number }>;
    } = null;
    // No owner map any more. Deep links re-pin from the `account` each mailbox and
    // message page now states — the server bound it for that very request, so it is
    // never partial, where a map missing an account read exactly like "yours".
    if (usableAll.length > 1) {
      // Uncached: these counters seed the client's badges — see mailboxesFor.
      const read = () => Promise.allSettled(usableAll.map(a => mailboxesFor(a, true)));
      let metas = await read();
      // One retry, because most of these failures are a blink rather than a state.
      if (metas.some(m => m.status !== "fulfilled")) metas = await read();


      // All accounts or none. A missing account still leaves a perfectly usable-looking
      // unified view — but its mailbox ids never enter the client's id sets, so every
      // EXISTS, EXPUNGE and COUNTERS event that account sends is dropped for as long as
      // the layout lives: rows that never move, badges frozen at whatever they were.
      // Withholding the unified entries is visible and rights itself on the next load;
      // a silently deaf account does neither.
      const missing = metas.filter(m => m.status !== "fulfilled").length;
      if (missing) {
        logger.warn(
          { accounts: usableAll.length, missing },
          "layout: unified entries withheld, one or more accounts unreadable",
        );
      } else {
        // Per mailbox, NOT summed: COUNTERS events arrive per mailbox, and the client
        // keeps the badges live by updating exactly the entry an event names.
        const inbox: Array<{ id: string; unseen: number; total: number }> = [];
        const sent: Array<{ id: string; total: number }> = [];
        for (const meta of metas) {
          if (meta.status !== "fulfilled") continue;
          for (const b of meta.value) {
            if (b.path === "INBOX") inbox.push({ id: b.id, unseen: b.unseen, total: b.total });
            else if (b.specialUse === "\\Sent") sent.push({ id: b.id, total: b.total });
          }
        }
        unified = { inbox, sent };
      }
    }

    const props = {
      user,
      mailboxes: boxes.results,
      addresses: addresses.length ? addresses : [String(user?.address ?? "")].filter(Boolean),
      username: activeAccount(req).username,
      // Every account in this session, for the switcher. needsReauth entries are
      // the stubs surgical eviction leaves behind — shown as "sign in again".
      accounts: sessionAccounts(req).map(a => ({ id: a.id, username: a.username, needsReauth: !usableAccount(a) })),
      unified,
    };

    return res.json({
      props,
      stuff: {
        user,
        mailboxes: boxes.results,
      }
    })
  }))

  pages.get("/me", pageHandler(async (req, res) => {
    const user = await get(`/users/${userId(req)}`, token(req));
    res.json({ props: { user }})
  }))

  pages.get("/signature", pageHandler(async (req, res) => {
    const user = await get(`/users/${userId(req)}`, token(req));
    res.json({ props: { user }})
  }))
  
  pages.get("/search", pageHandler(async (req, res) => {
    const props = await get(`/users/${userId(req)}/search?${searchQueryString(req.query)}`, token(req));
    res.json({ props })
  }))

  pages.get("/mailbox/:mailbox", pageHandler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    
    const {limit = PAGE_SIZE_LIMIT} = req.query;

    const [ mailbox, messages ] = await Promise.all([
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req)),
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages?${qs.stringify({limit})}`, token(req))
    ])

    // Which account this request was BOUND to. The client used to get an owner map in
    // the layout instead, and a map with an account missing from it — one whose
    // metadata could not be read — was indistinguishable from "this mailbox is yours",
    // so the tab silently kept the wrong chrome. Here it is per request and never
    // partial: bindMailboxAccount above resolved it or the request did not get this far.
    res.json({ props: { mailbox, messages, account: userId(req) }})
  }))

  pages.get("/mailbox/:mailbox/message/:message", pageHandler(async (req, res) => {
    await bindMailboxAccount(req, req.params.mailbox);
    
    const [ mailbox, message ] = await Promise.all([
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req)),
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}?markAsSeen=true`, token(req)) 
    ]);

    // See the mailbox page above: the bound account, stated rather than inferred.
    res.json({ props: { message, mailbox, account: userId(req) }})
  }))

  return api;
}

export const query = (req: Request): string => {
  const i = req.url.indexOf("?");
  if(i === -1) {
    return "";
  } else {
    return req.url.slice(i);
  }
}
