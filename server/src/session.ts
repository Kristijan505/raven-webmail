import ExpressSession from "express-session";
import MongoSession from "connect-mongodb-session";
import type { CookieOptions } from "express";
import { Config } from "./config";

const MongoStore = MongoSession(ExpressSession);

// session() runs once at boot. Keep the store reachable afterwards so a password
// change can evict that user's OTHER sessions (see destroyOtherSessions).
let activeStore: any = null;

/**
 * Destroy every stored session belonging to `userId` except `keepSessionId`.
 *
 * Changing the password is the one lever a user has when they suspect a session was
 * stolen, and it only means something if the other sessions actually die. Ours would
 * not: each session carries its own WildDuck token minted at login, so a copied
 * `raven.sid` keeps working indefinitely after the password changes.
 *
 * express-session's Store interface has no "delete where field matches", so this
 * reaches for the backing collection. Documents are `{ [idField]: sid, session: {...},
 * expires }` and the session object is stored as-is, so the authenticated user id sits
 * at `session.authentication.id` (mirroring userId() in api.ts). The collection handle
 * is assigned synchronously in the store's constructor — the driver buffers commands
 * until the connection is up — so there is no need to await a connect here.
 *
 * Returns how many sessions were dropped.
 */
export const destroyOtherSessions = async (userId: string, keepSessionId: string): Promise<number> => {
  const store = activeStore;
  const collection = store?.collection;
  if(!collection) throw new Error("session store is not initialized");
  // Refuse to build the query from a blank argument. Mongo serializes `undefined` to
  // `null`, so `{_id: {$ne: undefined}}` becomes "_id is not null" — i.e. every
  // document — and a blank userId would match sessions whose authentication field is
  // simply absent. Either mistake turns a targeted eviction into a much wider delete,
  // so fail loudly instead (the caller logs it and the password change still stands).
  if(!userId) throw new Error("destroyOtherSessions requires a user id");
  if(!keepSessionId) throw new Error("destroyOtherSessions requires the current session id");
  const idField: string = store.options?.idField ?? "_id";
  const result = await collection.deleteMany({
    "session.authentication.id": userId,
    [idField]: { $ne: keepSessionId },
  });
  return result?.deletedCount ?? 0;
}

// Only a real trusted-proxy value counts. An explicit trust_proxy=false means
// "not behind a proxy", so it must NOT enable proxy-derived cookie handling
// (secure="auto" from X-Forwarded-Proto, proxy:true) — `!= null` alone would,
// since false != null.
const trustsProxy = (config: Config): boolean =>
  config.trust_proxy != null && config.trust_proxy !== false;

// When TLS is terminated at a reverse proxy (trust_proxy set, ssl=false), tie the
// Secure flag to the forwarded protocol ("auto") instead of leaving it off, so the
// session cookie is never issued over a plaintext hop. Direct TLS => always secure.
const cookieSecure = (config: Config): boolean | "auto" =>
  config.session_cookie_secure ?? (config.ssl ? true : trustsProxy(config) ? "auto" : false);

/**
 * Attributes for res.clearCookie on logout.
 *
 * A Set-Cookie only overwrites a stored cookie when its attributes line up, so clearing
 * with just {path, domain} can leave a Secure / HttpOnly / SameSite cookie sitting in
 * the browser. The server-side record is destroyed regardless — the stale id is already
 * useless — but leaving it behind is untidy and makes reasoning about session fixation
 * harder than it needs to be. `secure: "auto"` is something express-session resolves
 * per request, so it is resolved here against this request's own protocol.
 */
export const sessionCookieClearOptions = (config: Config, isSecureRequest: boolean): CookieOptions => {
  const secure = cookieSecure(config);
  return {
    path: "/",
    domain: config.session_cookie_domain || undefined,
    httpOnly: config.session_cookie_http_only ?? true,
    sameSite: config.session_cookie_same_site || "lax",
    secure: secure === "auto" ? isSecureRequest : secure,
  };
}

export const session = (config: Config) => {
  const maxAge = config.session_cookie_max_age_ms ?? 7 * 24 * 60 * 60 * 1000;
  const trustProxy = trustsProxy(config);
  const secure = cookieSecure(config);

  return ExpressSession({
    name: config.session_name || "raven.sid",
    secret: config.secret_token,
    saveUninitialized: false,
    resave: config.session_resave ?? false,
    rolling: config.session_rolling ?? false,
    proxy: trustProxy ? true : undefined,
    unset: "destroy",
    cookie: {
      maxAge,
      secure,
      httpOnly: config.session_cookie_http_only ?? true,
      sameSite: config.session_cookie_same_site || "lax",
      domain: config.session_cookie_domain || undefined,
    },
    store: activeStore = new MongoStore({
      uri: config.mongodb_url,
      collection: "sessions-v2",
      expires: maxAge,
    })
  })
}
