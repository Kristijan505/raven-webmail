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

// NB: this predicate exists TWICE, in two languages — here, and as the $filter condition
// inside MIRROR_STAGE, which Mongo evaluates server-side. They cannot share code, so they
// have to be changed together: a mirror derived by a laxer or stricter rule than this one
// would name an account the rest of the code does not consider usable.

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
 *
 * Called at LOGIN, where the session is written anyway, and nowhere else. Minting it
 * lazily on first use was its own bypass: concurrent requests on a session that has no
 * key yet each load the same keyless copy, each mint a DIFFERENT id, and each therefore
 * get their own ten guesses. The reader (throttleId in api.ts) never mints — a session
 * without a key falls back to its id, which is at least shared.
 */
export const throttleKey = (session: SessionData): string => {
  if(!session.throttleKey) session.throttleKey = randomUUID();
  return session.throttleKey;
};

/**
 * The account bag as the STORE holds it right now.
 *
 * rotateSession carries the bag forward, and the copy on the request can be older than
 * the record: a tab signing an account out lands its atomic $pull while another tab is
 * midway through adding one, and carrying that stale snapshot into the new session
 * resurrects the account that was just removed, token and all. Re-reading immediately
 * before the rotation narrows that to the microseconds inside regenerate(); closing it
 * completely would need the whole login to hold a lock, which is not worth what it
 * costs on a path this hot.
 */
/**
 * The session collection and the field its ids live under.
 *
 * Four functions used to open with the same three lines and their own wording for the
 * same two failures; this is that, once. `required` is what tells a caller that cannot
 * proceed without the store (an eviction) from one that can shrug (a best-effort read).
 */
const storeHandle = (required = true): { collection: any; idField: string } | null => {
  const store = activeStore;
  const collection = store?.collection;
  if(!collection) {
    if(required) throw new Error("session store is not initialized");
    return null;
  }
  return { collection, idField: store.options?.idField ?? "_id" };
};

export const readStoredAccounts = async (sessionId: string): Promise<SessionAccount[] | null> => {
  const handle = sessionId ? storeHandle(false) : null;
  if(!handle) return null;
  const { collection, idField } = handle;
  const doc = await collection.findOne({ [idField]: sessionId }).catch(() => null);
  const accounts = doc?.session?.accounts;
  return Array.isArray(accounts) ? accounts as SessionAccount[] : null;
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
export const rotateSession = async (req: Request): Promise<void> => {
  // Carry the WHOLE account bag, not just the legacy mirror — rotating away a session
  // that holds several signed-in accounts must not quietly drop all but one of them.
  // Read from the STORE rather than from this request: see readStoredAccounts.
  const carried = req.session.authentication;
  const stored = await readStoredAccounts(req.sessionID);
  const carriedAccounts = stored ?? req.session.accounts;
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
 * Create or re-establish this browser's session for `account`.
 *
 * The ONE place that writes a whole session document, because that is what creating a
 * session is. Everything the login paths have to get right lives here rather than in
 * each route: the privilege-boundary rotation, the account bag, the legacy mirror, and
 * the throttle identity — which has to exist from the first request, since minting it
 * later let concurrent guesses each mint their own and multiply the limit.
 *
 * Returns the id the browser held BEFORE, which the caller needs: the rotation orphans
 * any /updates response opened under it, and those close by session id.
 */
export const establishSession = async (
  req: Request,
  mode: "fresh" | "add",
  account: SessionAccount,
): Promise<{ previousId: string }> => {
  const previousId = req.sessionID;
  if(mode === "add") {
    await rotateSession(req);
    // Signing into an account already present (including a re-auth stub) REPLACES its
    // entry: that is how a stubbed shared mailbox comes back after its password changed
    // elsewhere.
    writeAccounts(req.session, [...accountsOf(req.session).filter(a => a.id !== account.id), account]);
  } else {
    // Rotate the session id at the privilege boundary to defeat session fixation.
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate(err => err ? reject(err) : resolve());
    });
    writeAccounts(req.session, [account]);
  }
  throttleKey(req.session);
  await new Promise<void>((resolve, reject) => {
    req.session.save(err => err ? reject(err) : resolve());
  });
  return { previousId };
};

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

/**
 * ═══ The one write path for an EXISTING session's account bag. ═══
 *
 * Three rules, in one place, because keeping them in three places is what cost this
 * branch four review rounds:
 *
 * 1. Describe the CHANGE, never write the result. express-session persists the whole
 *    document, so two tabs each saving their own filtered copy silently undo each
 *    other — one signs out A, the other B, and whichever lands last brings the other's
 *    account back with its token.
 * 2. Derive the legacy mirror from what the array BECOMES, not from a snapshot the
 *    caller was holding. Computing it caller-side put the same race one level down.
 * 3. Bring the request's copy in line and then seal it, so nothing writes the whole
 *    document back afterwards. Not mutating it covers the default; session_resave is
 *    a supported option and under it express-session saves the stale copy regardless.
 *
 * Every account-bag edit goes through here. Creating or rotating a session is the one
 * thing that legitimately writes the whole document — that is establishSession, below.
 */
const editAccounts = async (
  req: Request,
  update: object | object[],
  options?: object,
): Promise<void> => {
  // FIRST, and synchronously — before any await. A caller that does not wait for this
  // (the reauth stub fires and forgets, mid-response) would otherwise have its response
  // end while this is still in flight, and express-session would write the stale copy
  // back after the atomic update rather than before it. Sealing on the way in is the
  // difference between the seal covering this response and missing it entirely.
  sealSession(req);
  const { collection, idField } = storeHandle()!;
  if(!req.sessionID) throw new Error("editAccounts requires a session id");
  const key = { [idField]: req.sessionID };
  await collection.updateOne(key, update, options);
  // Separately, because Mongo refuses arrayFilters together with a pipeline. Idempotent
  // and derived from the current array, so concurrent edits still leave it right.
  await collection.updateOne(key, [MIRROR_STAGE]);
  const stored = await readStoredAccounts(req.sessionID);
  if(stored) writeAccounts(req.session, stored);
};

/**
 * Stop express-session writing this session at the end of the response.
 *
 * Its automatic save persists the whole document whenever the in-memory copy differs
 * from what was loaded — and with session_resave on, even when it does not. Either way
 * that is the read-modify-write the atomic edits above exist to avoid.
 */
const sealSession = (req: Request): void => {
  (req.session as unknown as { save: (cb?: (e?: unknown) => void) => unknown }).save =
    (cb) => { cb?.(); return req.session; };
};

/** Sign one account out of THIS session. */
export const removeAccountFromSession = (req: Request, accountId: string): Promise<void> => {
  if(!accountId) throw new Error("removeAccountFromSession requires an account id");
  return editAccounts(req, [{
    $set: {
      "session.accounts": {
        $filter: {
          input: { $ifNull: ["$session.accounts", []] },
          as: "a",
          cond: { $ne: ["$$a.id", accountId] },
        },
      },
    },
  }]);
};

/**
 * Mark one account in THIS session as needing re-authentication.
 *
 * The counterpart to the surgical eviction, for when WildDuck itself refuses the token:
 * without it the entry keeps a token, stays `usableAccount`, and the browser retries a
 * credential that will never work again on every reconnect — while the switcher shows
 * the account as healthy and the unified views stay quietly short.
 */
export const stubAccountInSession = (req: Request, accountId: string): Promise<void> => {
  if(!accountId) throw new Error("stubAccountInSession requires an account id");
  return editAccounts(
    req,
    {
      $set: { "session.accounts.$[entry].needsReauth": true },
      $unset: { "session.accounts.$[entry].token": "" },
    },
    { arrayFilters: [{ "entry.id": accountId }] },
  );
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
