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
import { destroyOtherSessions, rotateSession, sessionCookieClearOptions } from "./session";
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
type LiveStream = { user: string; session: string; close: () => void };
const liveStreams = new Set<LiveStream>();

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
    if (entry.user !== user || entry.session === keepSession) continue;
    liveStreams.delete(entry);
    try { entry.close(); closed++; } catch { /* already gone */ }
  }
  return closed;
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

const ownedMailboxIds = async (req: Request, fresh: boolean): Promise<Set<string>> => {
  const uid = userId(req);
  const hit = mailboxIdsCache.get(uid);
  const age = hit ? Date.now() - hit.at : Infinity;
  // `fresh` asks to bypass the normal TTL, but not the refresh floor — see
  // forgetMailboxIds above for why that is safe.
  if (hit && age < (fresh ? MAILBOX_IDS_REFRESH_MIN_MS : MAILBOX_IDS_TTL_MS)) return hit.ids;

  const generation = mailboxIdsGeneration;
  const boxes = await get(`/users/${uid}/mailboxes`, token(req));
  const ids = new Set<string>(((boxes?.results ?? []) as Array<{ id: unknown }>).map(b => String(b.id)));

  if (generation === mailboxIdsGeneration) cacheMailboxIds(uid, ids);
  return ids;
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
 * Note `mailbox:` goes INSIDE the query. WildDuck ignores the separate `mailbox`
 * parameter whenever `q` is present — the two take different code paths in its search
 * handler — so passing it alongside would silently search the entire account.
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
    ? safe.map(address => `mailbox:${mailbox} from:${address}`).join(" or ")
    : `mailbox:${mailbox} ${safe.map(address => `-from:${address}`).join(" ")}`;
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
  keyGenerator: (req) => req.session?.authentication?.id ?? "unauthenticated",
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
  keyGenerator: (req: Request) => `${name}:${req.session?.authentication?.id ?? "unauthenticated"}`,
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
    const { username, password } = validate(() => LoginSchema.parse(req.body));
    const v = await authenticate(username, password);
    // Rotate the session id at the privilege boundary to defeat session fixation.
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate(err => err ? reject(err) : resolve());
    });
    req.session.authentication = v;
    await new Promise<void>((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });
    res.json({});
  }))

  api.post("/logout", handler(async (req, res) => {
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
    // Captured BEFORE the await: an eviction can land while watch() is in flight, and
    // this connection must not come up afterwards still carrying the old token.
    const openedAt = evictionCounter;
    const stream = await watch(userId(req), token(req));
    if (wasEvictedSince(userId(req), req.sessionID, openedAt)) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
    }
    res.type("text/event-stream");
    stream.pipe(res);
    // Registered so a password change can actually cut it off. This response captured
    // its WildDuck token when it opened and keeps piping regardless of what happens to
    // the session record afterwards — so without this, deleting a stolen session left
    // that client still receiving counters and arrival/expunge events while PUT /me
    // reported the eviction complete. The flag has to be true only when it is true.
    const entry: LiveStream = {
      user: userId(req),
      session: req.sessionID,
      // Tear down the upstream too, not just our response — otherwise the connection
      // to WildDuck stays open behind a client that can no longer receive it.
      close: () => {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        res.end();
      },
    };
    liveStreams.add(entry);
    const drop = () => liveStreams.delete(entry);
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
    const { existingPassword, ...update } = body;
    const id = userId(req); // throws 403 if unauthenticated -> session.authentication is set below
    if (update.password != null) {
      // Verify the current password by re-authenticating. Only a genuine credential
      // failure counts as "wrong password": WildDuck answers 403 (or resolves with
      // success:false). A transport/backend failure (WildDuck down -> 502/5xx, invalid
      // JSON) must surface as-is, not masquerade as an incorrect password.
      const auth = await authenticate(req.session.authentication!.username, existingPassword ?? "")
        .catch((e) => {
          if (e instanceof ApiError && e.status === StatusCodes.FORBIDDEN) return null;
          throw e;
        });
      if (!auth || auth.success !== true) {
        throw new ApiError(StatusCodes.FORBIDDEN, "Current password is incorrect", "invalid_existing_password");
      }
    }
    const json = await put(`/users/${id}`, token(req), update);

    // Only meaningful for a password change; true otherwise so the client's check
    // (`sessionsEvicted === false`) never fires on a plain name update.
    let sessionsEvicted = true;

    if (update.password != null) {
      // Evict this user's OTHER sessions now that the password has changed. Changing
      // the password is what someone does when they think a session was stolen, and
      // without this it does not evict anything: every session holds its own WildDuck
      // token from login, so a copied raven.sid keeps working. The current session is
      // kept — it just proved knowledge of the old password above, and logging the
      // user out of the tab they are working in would be gratuitous.
      //
      // Runs AFTER the change, and its failure is reported rather than thrown. Failing
      // the response is not an option: the password HAS changed by this point, so a 5xx
      // would tell the user the opposite of the truth. But swallowing it silently is
      // worse — they would read "Password updated" and believe the other sessions were
      // evicted when they were not, which is the entire reason they changed it. So the
      // change succeeds and the client is told what actually happened.
      // The flag answers "is it certain no other session survives?", NOT "was anything
      // deleted" — zero deletions because there were no other sessions is success, and
      // the UI must not warn about it. It is false only when the eviction could not be
      // carried out at all. The count is logged so that is auditable after the fact.
      // Rotate before evicting. The exception below is "keep the session making the
      // change" — but a copied raven.sid arrives on that exact id, so the exception
      // would spare the copy too. rotateSession moves this browser to an id no one
      // else can be holding first; only then does "everything except mine" mean it.
      sessionsEvicted = await rotateSession(req)
        .then(() => destroyOtherSessions(id, req.sessionID))
        .then((count: number) => {
          // Session records alone are not enough: an /updates response already open
          // holds its own token and would keep streaming. Close those too, or the flag
          // below would claim more than was actually done.
          //
          // Since rotation, this also closes the caller's OWN stream — it was opened
          // under the id we just retired, and that id is exactly what cannot be trusted
          // any more. The client reconnects on its own: it is a native EventSource, and
          // by the time the browser retries it holds the new cookie set by the response
          // below, which passes the wasEvictedSince check as the session that was kept.
          const streams = closeOtherLiveStreams(id, req.sessionID);
          logger.info({ count, streams }, "other sessions invalidated after password change");
          return true;
        })
        .catch((e: any) => {
          logger.error(
            { detail: String(e?.message) },
            "password changed but other sessions could not be invalidated",
          );
          return false;
        });
    }

    res.json({ ...json, sessionsEvicted });
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
    await del(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req));
    forgetMailboxIds(req);
    res.json({});
  }))

  api.put("/mailboxes/:mailbox", handler(async (req, res) => {
    const body = validate(() => MailboxUpdateSchema.parse(req.body));
    const json = await put(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req), body);
    forgetMailboxIds(req);
    res.json(json);
  }))

  api.get("/mailboxes/:mailbox/messages", handler(async (req, res) => {
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
    const body = validate(() => BulkMessageUpdateSchema.parse(req.body));
    // moveTo relocates real mail, so confirm the destination is the caller's own.
    if (body.moveTo != null) await assertOwnsMailbox(req, body.moveTo);
    const json = await put(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req), body);
    res.json(json);
  }))

  api.post("/mailboxes/:mailbox/messages", draftLimiter, handler(async (req, res) => {
    const body = validate(() => CreateMessageSchema.parse(req.body));
    // `reference` makes WildDuck read the referenced message to build the quoted body
    // and carry attachments across — a read primitive pointed at a mailbox id the
    // client chose, so it gets the same ownership check as moveTo.
    if (body.reference?.mailbox != null) await assertOwnsMailbox(req, body.reference.mailbox);
    const json = await post(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req), body);
    res.json(json);
  }))

  api.delete("/mailboxes/:mailbox/messages", bulkLimiter, handler(async (req, res) => {
    await del(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req));
    res.json({});
  }))

  api.get("/mailboxes/:mailbox/messages/:message", handler(async (req, res) => {
    const body = await get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}`, token(req));
    res.json(body);
  }))

  api.delete("/mailboxes/:mailbox/messages/:message", handler(async (req, res) => {
    const body = await del(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}`, token(req));
    res.json(body);
  }))

  api.put("/mailboxes/:mailbox/messages/:message/flag", handler(async (req, res) => {
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
    // The submit endpoint takes no meaningful client-supplied fields — the draft
    // to send is identified by the URL params alone. Accept an empty body only.
    const body = await post(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}/submit`, token(req), {});
    res.json(body);
  }))

  api.get("/mailboxes/:mailbox/messages/:message/attachments/:attachment", handler(async (req, res) => {
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
    if (req.session.authentication == null) {
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

    const props = {
      user,
      mailboxes: boxes.results,
      addresses: addresses.length ? addresses : [String(user?.address ?? "")].filter(Boolean),
      username: req.session.authentication!.username
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
    
    const {limit = PAGE_SIZE_LIMIT} = req.query;

    const [ mailbox, messages ] = await Promise.all([
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req)),
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages?${qs.stringify({limit})}`, token(req))
    ])

    res.json({ props: { mailbox, messages }})
  }))

  pages.get("/mailbox/:mailbox/message/:message", pageHandler(async (req, res) => {
    
    const [ mailbox, message ] = await Promise.all([
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req)),
      get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages/${seg(req.params.message)}?markAsSeen=true`, token(req)) 
    ]);

    res.json({ props: { message, mailbox }})
  }))

  return api;
}

export const token = (req: Request): string => {
  if(req.session.authentication == null) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
  }

  return req.session.authentication.token;
}

export const userId = (req: Request): string => {
  if(req.session.authentication == null) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden", "forbidden");
  }

  return req.session.authentication.id;
}

export const query = (req: Request): string => {
  const i = req.url.indexOf("?");
  if(i === -1) {
    return "";
  } else {
    return req.url.slice(i);
  }
}
