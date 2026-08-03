import { randomUUID } from "node:crypto";
import ExpressSession from "express-session";
import MongoSession from "connect-mongodb-session";
import type { CookieOptions, Request } from "express";
import type { SessionData } from "express-session";
import type { Authentication, SessionAccount } from "./client";
import { Config } from "./config";

const MongoStore = MongoSession(ExpressSession);

// session() runs once at boot. Keep the store reachable afterwards so a password
// change can evict that user's OTHER sessions (see destroyOtherSessions).
let activeStore: any = null;

/**
 * A session entry that can actually speak for its account: it has a token and has not
 * been stubbed by a surgical eviction.
 */
export const usableAccount = (a: SessionAccount): a is SessionAccount & { token: string } =>
  typeof a.token === "string" && a.token.length > 0 && a.needsReauth !== true;

/**
 * Every account in this session, whatever its vintage. Sessions written before the
 * multi-account model hold a single `authentication`; reading through this shim is
 * what lets them survive the deploy instead of logging everyone out.
 */
export const accountsOf = (session: SessionData): SessionAccount[] =>
  session.accounts ?? (session.authentication ? [session.authentication] : []);

/**
 * The one write path for the account list. Also maintains the legacy mirror
 * (`authentication` = first usable account) so a ROLLBACK to a single-account build
 * still finds a working session — multi-account code never reads the mirror.
 */
export const writeAccounts = (session: SessionData, accounts: SessionAccount[]): void => {
  session.accounts = accounts;
  session.authentication = (accounts.find(usableAccount) as Authentication | undefined) ?? null;
};

/**
 * A rate-limit identity for this browser that survives session rotation.
 *
 * The password-attempt throttle is per browser rather than per account on purpose —
 * switching accounts must not hand out a fresh bucket. Keying it on the session ID
 * looked like the way to say that, and it handed out a fresh bucket anyway: adding an
 * account rotates the ID, and a SUCCESSFUL login is not counted by the login throttle
 * either. So a stolen multi-account session could burn its allowance of current-password
 * guesses against the victim, add an account the attacker controls, come back with a new
 * ID and an empty bucket, and repeat without limit — an offline-speed brute force
 * against the one credential that gates account takeover.
 *
 * Minted once and carried by rotateSession, so the bucket follows the browser and not
 * the cookie value. A genuinely fresh login (regenerate, not rotate) does mint a new one
 * — correctly: that path replaces the account bag outright, so the session it produces
 * can no longer reach the victim's account at all.
 */
export const throttleKey = (session: SessionData): string => {
  if(!session.throttleKey) session.throttleKey = randomUUID();
  return session.throttleKey;
};

/**
 * Give this browser a NEW session id, carrying its authentication across.
 *
 * Without this, evicting "every session except the current one" cannot remediate the
 * case it exists for. A stolen `raven.sid` is not a second session — it is a copy of
 * this one, so the thief arrives on the very id being kept, and the exception written
 * to protect the user's own tab protects the thief's tab just as well. The password
 * changes, `sessionsEvicted: true` goes back, and the copied cookie keeps its WildDuck
 * token and full API access.
 *
 * Rotating first breaks the tie: regenerate() destroys the old record and mints a new
 * id for the browser that proved knowledge of the old password, and the copy is left
 * pointing at an id that no longer exists. Everything else is then evicted by the id
 * that no other client can be holding.
 *
 * regenerate() deliberately empties the new session, so `authentication` — the WildDuck
 * token, user id and username minted at login — is carried over by hand, and saved
 * before the caller deletes anything, so a crash between the two cannot leave the user
 * holding a session id with no authentication on it.
 */
export const rotateSession = (req: Request): Promise<void> => {
  // Carry the WHOLE account bag, not just the legacy mirror — rotating away a session
  // that holds several signed-in accounts must not quietly drop all but one of them.
  const carried = req.session.authentication;
  const carriedAccounts = req.session.accounts;
  // The throttle bucket rides along too — see throttleKey. Rotating away from it is
  // what made the password-attempt limit resettable on demand.
  const carriedThrottle = req.session.throttleKey;
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate(err => {
      if(err) return reject(err);
      req.session.authentication = carried;
      if(carriedAccounts) req.session.accounts = carriedAccounts;
      if(carriedThrottle) req.session.throttleKey = carriedThrottle;
      req.session.save(saveErr => saveErr ? reject(saveErr) : resolve());
    });
  });
}

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

/**
 * The Mongo operations behind evictAccountFromOtherSessions, built pure so the exact
 * queries are pinned by tests — this is the part reviews keep finding bugs in, and a
 * wrong filter here is either a mass logout or a failed eviction.
 */
export const buildEvictionOps = (userId: string, keepSessionId: string, idField: string) => ({
  // Legacy single-account sessions hold nothing but this account, so the stub IS
  // deletion — exactly what the pre-multi-account eviction did to them.
  deleteLegacy: {
    filter: {
      "session.authentication.id": userId,
      "session.accounts": { $exists: false },
      [idField]: { $ne: keepSessionId },
    },
  },
  // Multi-account sessions lose ONLY this account's credentials. The entry stays as a
  // stub — token stripped, needsReauth flagged — so the client can offer "sign in
  // again as X", and a colleague holding ten shared mailboxes keeps the other nine.
  stubAccounts: {
    filter: {
      "session.accounts": { $elemMatch: { id: userId, needsReauth: { $ne: true } } },
      [idField]: { $ne: keepSessionId },
    },
    update: {
      $set: { "session.accounts.$[entry].needsReauth": true },
      $unset: { "session.accounts.$[entry].token": "" },
    },
    options: { arrayFilters: [{ "entry.id": userId }] },
  },
  // The legacy mirror may point at the very account being evicted; left alone, a
  // rollback to a single-account build would resurrect its token. New code reads
  // `accounts` and never misses the mirror.
  clearMirror: {
    filter: {
      "session.accounts": { $exists: true },
      "session.authentication.id": userId,
      [idField]: { $ne: keepSessionId },
    },
    update: { $set: { "session.authentication": null } },
  },
});

/**
 * Surgically evict ONE account from every other session that holds it.
 *
 * This is the opt-in half of a password change ("sign out this account on other
 * devices"). It deliberately does NOT destroy whole sessions: with shared mailboxes a
 * password change is often routine, and the colleague who has the shared box plus
 * their own mail signed in must lose exactly the shared box — as a visible stub that
 * asks for the new password — and nothing else.
 *
 * Same store access and the same blank-argument guards as destroyOtherSessions above
 * (Mongo serializes undefined to null, and `{$ne: null}` matches everything).
 */
export const evictAccountFromOtherSessions = async (userId: string, keepSessionId: string): Promise<number> => {
  const store = activeStore;
  const collection = store?.collection;
  if(!collection) throw new Error("session store is not initialized");
  if(!userId) throw new Error("evictAccountFromOtherSessions requires a user id");
  if(!keepSessionId) throw new Error("evictAccountFromOtherSessions requires the current session id");
  const idField: string = store.options?.idField ?? "_id";
  const ops = buildEvictionOps(userId, keepSessionId, idField);
  const del = await collection.deleteMany(ops.deleteLegacy.filter);
  const stub = await collection.updateMany(ops.stubAccounts.filter, ops.stubAccounts.update, ops.stubAccounts.options);
  await collection.updateMany(ops.clearMirror.filter, ops.clearMirror.update);
  return (del?.deletedCount ?? 0) + (stub?.modifiedCount ?? 0);
}

/**
 * Remove ONE account from a stored session, atomically.
 *
 * Deliberately a targeted $pull rather than read-modify-write. express-session saves the
 * whole document, so two tabs signing out two different accounts each read {A,B,C} and
 * each write their own complete copy — {B,C} and {A,C} — and whichever lands last
 * resurrects the account the other just removed, token and all, which the reconnecting
 * update stream then happily subscribes to again. A $pull describes the change instead
 * of the result, so both survive in either order.
 *
 * The legacy `authentication` mirror is rewritten in the same update: it is only ever
 * the first usable entry, and leaving it pointing at the account just removed would
 * hand a rollback build a session speaking for someone who signed out.
 */
/**
 * Recompute the legacy `authentication` mirror from whatever `accounts` now holds.
 *
 * A pipeline stage rather than a value, so it is derived from the array as it ends up
 * — computing it from a snapshot in the caller put the concurrency race back one level
 * down, leaving the mirror naming an account that had just been removed.
 */
const MIRROR_STAGE = {
  $set: {
    "session.authentication": {
      $ifNull: [{
        $first: {
          $filter: {
            input: { $ifNull: ["$session.accounts", []] },
            as: "a",
            cond: {
              $and: [
                { $eq: [{ $type: "$$a.token" }, "string"] },
                { $gt: [{ $strLenCP: { $ifNull: ["$$a.token", ""] } }, 0] },
                { $ne: ["$$a.needsReauth", true] },
              ],
            },
          },
        },
      }, null],
    },
  },
};

export const pullAccountFromSession = async (sessionId: string, accountId: string): Promise<void> => {
  const store = activeStore;
  const collection = store?.collection;
  if(!collection) throw new Error("session store is not initialized");
  if(!sessionId) throw new Error("pullAccountFromSession requires a session id");
  if(!accountId) throw new Error("pullAccountFromSession requires an account id");
  const idField: string = store.options?.idField ?? "_id";
  // An aggregation-pipeline update so the mirror is derived from what the array ACTUALLY
  // becomes. Passing a value computed by the caller reintroduced the race one level
  // down: two tabs removing A and B each computed the mirror from the same snapshot, so
  // the survivor could end up as {C} with `authentication` still naming A or B — and the
  // whole point of that mirror is that a rollback build reads it, which would then
  // resurrect an account the user signed out.
  const kept = {
    $filter: {
      input: { $ifNull: ["$session.accounts", []] },
      as: "a",
      cond: { $ne: ["$$a.id", accountId] },
    },
  };
  await collection.updateOne({ [idField]: sessionId }, [
    { $set: { "session.accounts": kept } },
    MIRROR_STAGE,
  ]);
};

/**
 * Mark one account in a stored session as needing re-authentication, atomically.
 *
 * The counterpart to the surgical eviction, for the case where WildDuck itself rejects
 * the token: without it the entry keeps a token, stays `usableAccount`, and the browser
 * retries a credential that will never work again — every reconnect, forever — while the
 * switcher never offers "sign in again" and unified views stay quietly short.
 */
export const markAccountNeedsReauth = async (sessionId: string, accountId: string): Promise<void> => {
  const store = activeStore;
  const collection = store?.collection;
  if(!collection || !sessionId || !accountId) return;
  const idField: string = store.options?.idField ?? "_id";
  await collection.updateOne(
    { [idField]: sessionId },
    {
      $set: { "session.accounts.$[entry].needsReauth": true },
      $unset: { "session.accounts.$[entry].token": "" },
    },
    { arrayFilters: [{ "entry.id": accountId }] },
  );
  // Recomputed separately: an update cannot mix arrayFilters with a pipeline, and the
  // mirror must not be left naming the account just stubbed.
  await collection.updateOne({ [idField]: sessionId }, [MIRROR_STAGE]);
};

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
