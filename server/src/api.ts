import { Request, RequestHandler, Router } from "express"
import { validate, handler, ApiError, pageHandler } from "./util";
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
import rateLimit from "express-rate-limit";
import { z } from "zod";

const fromWeb = (Readable as any).fromWeb as ((stream: any) => NodeJS.ReadableStream);

// Returns a Transform that passes bytes through unchanged but destroys the
// pipeline with an error once `maxBytes` have been seen. This enforces a hard
// download cap regardless of whether the upstream server sends Content-Length
// (chunked responses omit it, making a header-only check bypassable).
const byteLimiter = (maxBytes: number): Transform => {
  let seen = 0;
  return new Transform({
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
const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
const SignatureSchema = z.object({
  html: z.string(),
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
  message: z.string().min(1),
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  moveTo: z.string().min(1).optional(),
});

// Address used in draft creation (To / Cc / Bcc fields).
const AddressSchema = z.object({
  name: z.string().optional(),
  address: z.string().min(1),
});

// Reference to a message being replied to or forwarded.
const ReferenceSchema = z.object({
  mailbox: z.string().min(1),
  id: z.number().int().positive(),
  action: z.enum(["reply", "replyAll", "forward"]),
  attachments: z.boolean(),
});

// Draft creation body — mirrors createMessageBody() in app/src/lib/Compose/compose.ts.
// Zod strips any extra keys the client might inject before we proxy to WildDuck.
const CreateMessageSchema = z.object({
  draft: z.boolean().optional(),
  to: z.array(AddressSchema).optional(),
  cc: z.array(AddressSchema).optional(),
  bcc: z.array(AddressSchema).optional(),
  subject: z.string().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
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
    throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid path parameter");
  }
  return encodeURIComponent(value);
};

// Defense-in-depth CSRF guard for state-changing requests. SameSite=lax is the
// primary protection, but it is operator-overridable to "none"; this rejects any
// unsafe-method request whose Origin doesn't match the host. Requests with no
// Origin header (same-origin navigations, non-browser clients) pass through and
// remain gated by the session cookie.
const enforceSameOrigin: RequestHandler = (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  const origin = req.get("origin");
  if (!origin) return next();
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    originHost = null;
  }
  // req.hostname honors X-Forwarded-Host when trust proxy is set, so this works
  // behind a reverse proxy; compare hostnames (port-insensitive) to avoid false 403s.
  if (originHost === null || originHost !== req.hostname) {
    res.status(StatusCodes.FORBIDDEN).json({ error: { status: 403, message: "Cross-origin request blocked" } });
    return;
  }
  return next();
};

// --- Remote image proxy (SSRF-guarded) --------------------------------------
// Email image URLs are attacker-controlled, so the proxy MUST refuse to fetch
// internal/loopback/link-local/private addresses (e.g. http://wildduck:8080,
// http://169.254.169.254 cloud metadata, http://127.0.0.1). We resolve the host
// and reject any non-public IP before fetching, and re-validate across redirects.

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
};

const isPrivateIpv4 = (ip: string): boolean => {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable -> treat as unsafe
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToInt(base)!;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange("0.0.0.0", 8) || inRange("10.0.0.0", 8) || inRange("100.64.0.0", 10) ||
    inRange("127.0.0.0", 8) || inRange("169.254.0.0", 16) || inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) || inRange("192.0.2.0", 24) || inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) || inRange("198.51.100.0", 24) || inRange("203.0.113.0", 24) ||
    inRange("224.0.0.0", 4) || inRange("240.0.0.0", 4)
  );
};

export const isPrivateIp = (ip: string): boolean => {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateIpv4(ip);
  if (fam === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    if (lower === "::1" || lower === "::") return true;
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
    return false;
  }
  return true; // not a valid IP literal -> unsafe
};

export const assertPublicHttpUrl = async (raw: string): Promise<URL> => {
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
  return u;
};

// Brute-force / credential-stuffing protection for the login endpoint. Only
// failed attempts count (skipSuccessfulRequests), so legitimate users are never
// locked out; keyed by client IP (honors trust proxy).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: { status: 429, message: "Too many login attempts, please try again later" } },
});

export const api = (config: Config) => {
  const api = Router();

  api.use(json({ limit: config.json_body_limit || "1mb" }));

  api.use(i18n.middleware(config));

  api.use(enforceSameOrigin);

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
    const json = await put(`/users/${userId(req)}`, token(req), body);
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
    if(!path) throw new ApiError(StatusCodes.BAD_REQUEST, "'path' is required");
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
    const body = await get(`/users/${userId(req)}/mailboxes/${seg(req.params.mailbox)}/messages${query(req)}`, token(req));
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
      throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid message id");
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
      throw new ApiError(502, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway");
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
      throw new ApiError(502, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway");
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
    const query = { ...req.query, limit: req.query.limit || "50" }; 
    const json = await get(`/users/${userId(req)}/search?${qs.stringify(query)}`, token(req));
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

    const back = await fetch(url(`/users/${userId(req)}/storage${query(req)}`), {
      method: "POST",
      headers: headers,
      body: req as any,
      duplex: "half" as any,
    } as any).catch(e => {
      throw new ApiError(502, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway");
    })

    const json = await back.json().catch(e => {
      throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "Invalid JSON from backend");
    })

    if(json?.error) {
      throw new ApiError(back.ok ? 500 : back.status, String(json.error));
    }

    res.status(back.status).json(json);
  }))

  api.get("/proxy-image", handler(async (req, res) => {
    // Require an authenticated session so this can never be used as an open proxy.
    if (req.session.authentication == null) {
      throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
    }

    let current = await assertPublicHttpUrl(String(req.query.url || ""));
    let upstream: Awaited<ReturnType<typeof fetch>> | null = null;

    // Follow up to 3 redirects, re-validating each hop against private ranges.
    for (let i = 0; i < 4; i++) {
      upstream = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "RavenImageProxy/1.0", accept: "image/*" },
        signal: AbortSignal.timeout(8000),
      }).catch(() => { throw new ApiError(StatusCodes.BAD_GATEWAY, "Cannot fetch image"); });

      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get("location");
        if (!location) break;
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }
      break;
    }

    if (!upstream || !upstream.ok) {
      throw new ApiError(StatusCodes.BAD_GATEWAY, "Cannot fetch image");
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!/^image\//i.test(contentType)) {
      throw new ApiError(StatusCodes.UNSUPPORTED_MEDIA_TYPE, "Not an image");
    }

    const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MiB

    // Reject immediately if Content-Length is present and already over the limit.
    const contentLength = Number(upstream.headers.get("content-length") || "0");
    if (contentLength > IMAGE_SIZE_LIMIT) {
      throw new ApiError(StatusCodes.BAD_GATEWAY, "Image too large");
    }

    res.setHeader("content-type", contentType);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=86400");
    if (upstream.body) {
      // Enforce the byte cap while streaming so that servers omitting
      // Content-Length (chunked transfer encoding) cannot bypass the check.
      const limiter = byteLimiter(IMAGE_SIZE_LIMIT);
      limiter.on("error", () => {
        // Abort the response mid-stream; the client receives a truncated body
        // and a connection reset, which is the correct outcome for an oversize
        // image — we cannot send a proper HTTP error after headers are flushed.
        res.destroy();
      });
      fromWeb(upstream.body as any).pipe(limiter).pipe(res);
    } else {
      res.end();
    }
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
    const query = { ...req.query, limit: req.query.limit || "50" }; 
    const props = await get(`/users/${userId(req)}/search?${qs.stringify(query)}`, token(req));
    res.json({ props })
  }))

  pages.get("/mailbox/:mailbox", pageHandler(async (req, res) => {
    
    const {limit = "50"} = req.query;

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
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
  }

  return req.session.authentication.token;
}

export const userId = (req: Request): string => {
  if(req.session.authentication == null) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
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
