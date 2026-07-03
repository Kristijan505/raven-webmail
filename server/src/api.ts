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
const MeSchema = z.object({
  name: z.string().min(1).optional(),
  existingPassword: z.string().optional(),
  password: z.string().optional(),
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
    res.clearCookie(config.session_name || "raven.sid", {
      path: "/",
      domain: config.session_cookie_domain || undefined,
    });
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
    const stream = await watch(userId(req), token(req));
    res.type("text/event-stream");
    stream.pipe(res);
  }))

  api.put("/me", handler(async (req, res) => {
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
      const ok = await authenticate(req.session.authentication!.username, existingPassword ?? "")
        .then(r => r?.success === true)
        .catch(() => false);
      if (!ok) {
        throw new ApiError(StatusCodes.FORBIDDEN, "Current password is incorrect", "invalid_existing_password");
      }
    }
    const json = await put(`/users/${id}`, token(req), update);
    res.json(json);
  }))

  api.put("/signature", handler(async (req, res) => {
    const { html } = validate(() => SignatureSchema.parse(req.body));
    const body = { metaData: {[RAVEN_SIGNATURE_META_KEY]: html } };
    const json = await put(`/users/${userId(req)}`, token(req), body);
    res.json(json);
  }))

  api.get("/mailboxes", handler(async (req, res) => {
    const json = await get(`/users/${userId(req)}/mailboxes?counters=true`, token(req));
    res.json(json);
  }))

  api.post("/mailboxes", handler(async (req, res) => {
    const path = String(req.body?.path?.trim() || "");
    if(!path) throw new ApiError(StatusCodes.BAD_REQUEST, "'path' is required", "path_required");
    const json = await post(`/users/${userId(req)}/mailboxes`, token(req), { path });
    res.json(json);
  }))

  api.delete("/mailboxes/:mailbox", handler(async (req, res) => {
    await del(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req));
    res.json({});
  }))

  api.put("/mailboxes/:mailbox", handler(async (req, res) => {
    const body = validate(() => MailboxUpdateSchema.parse(req.body));
    const json = await put(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}`, token(req), body);
    res.json(json);
  }))

  api.get("/mailboxes/:mailbox/messages", handler(async (req, res) => {
    // Allow-list the two params the UI sends (pagination cursor + page size).
    // Forwarding req.query verbatim would let clients inject undocumented
    // WildDuck params (metaData, threadCounters, unseen, etc.).
    const allowed: Record<string, string> = {};
    if (typeof req.query.next === "string" && req.query.next) allowed.next = req.query.next;
    if (typeof req.query.limit === "string" && req.query.limit) allowed.limit = req.query.limit;
    const qsStr = qs.stringify(allowed);
    const body = await get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages${qsStr ? "?" + qsStr : ""}`, token(req));
    res.json(body);
  }))

  api.put("/mailboxes/:mailbox/messages", handler(async (req, res) => {
    const body = validate(() => BulkMessageUpdateSchema.parse(req.body));
    const json = await put(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req), body);
    res.json(json);
  }))

  api.post("/mailboxes/:mailbox/messages", handler(async (req, res) => {
    const body = validate(() => CreateMessageSchema.parse(req.body));
    const json = await post(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages`, token(req), body);
    res.json(json);
  }))

  api.delete("/mailboxes/:mailbox/messages", handler(async (req, res) => {
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

  api.post("/mailboxes/:mailbox/messages/:message/submit", handler(async (req, res) => {
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

  api.post("/storage", handler(async (req, res) => {
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
      throw new ApiError(back.ok ? 500 : back.status, String(json.error));
    }

    res.status(back.status).json(json);
  }))

  api.get("/proxy-image", handler(async (req, res) => {
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
    const [user, boxes] = await Promise.all([
      get(`/users/${userId(req)}`, token(req)),
      get(`/users/${userId(req)}/mailboxes?counters=true`, token(req))
    ])

    return res.json({
      props: {
        user,
        mailboxes: boxes.results,
        username: req.session.authentication!.username
      },
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
