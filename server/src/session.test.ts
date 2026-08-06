import { describe, it, expect } from "vitest";
import express from "express";
import ExpressSession from "express-session";
import type { AddressInfo } from "node:net";
import { accountsOf, buildEvictionOps, rotateSession, usableAccount, writeAccounts } from "./session";

// Exercised against the real express-session, not a stand-in: the whole point of
// rotateSession is what regenerate() does to the stored record and to the cookie, and a
// hand-rolled fake would only ever confirm my own assumptions about that. A memory
// store stands in for Mongo — the id lifecycle is the Store contract, not Mongo's.
const AUTH = { id: "u1", username: "kiki@red-code.dev", token: "wildduck-token" };

const withServer = async (run: (base: string, store: any) => Promise<void>) => {
  const store = new ExpressSession.MemoryStore();
  const app = express();
  app.use(ExpressSession({
    secret: "test-secret-that-is-long-enough-to-be-plausible",
    resave: false,
    saveUninitialized: false,
    store,
  }));

  app.get("/login", (req, res) => {
    req.session.authentication = { ...AUTH } as any;
    res.json({ sid: req.sessionID });
  });

  app.post("/rotate", async (req, res) => {
    const before = req.sessionID;
    await rotateSession(req);
    res.json({ before, after: req.sessionID, auth: req.session.authentication });
  });

  app.get("/whoami", (req, res) => {
    res.json({ sid: req.sessionID, auth: req.session.authentication ?? null });
  });

  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(base, store); } finally { server.close(); }
};

const cookieOf = (res: Response): string => (res.headers.getSetCookie()[0] ?? "").split(";")[0];
const stored = (store: any, sid: string): Promise<any> =>
  new Promise(resolve => store.get(sid, (_e: any, s: any) => resolve(s)));

describe("rotateSession — remediating a stolen raven.sid", () => {
  it("moves this browser to a new id and carries its authentication across", async () => {
    await withServer(async (base, store) => {
      const login = await fetch(`${base}/login`);
      const cookie = cookieOf(login);
      const { sid } = await login.json();

      const res = await fetch(`${base}/rotate`, { method: "POST", headers: { cookie } });
      const body = await res.json();

      expect(body.before).toBe(sid);
      expect(body.after).not.toBe(sid);
      // The WildDuck token is minted at login and never re-issued, so losing it here
      // would log the user out of the tab they just changed their password in.
      expect(body.auth).toMatchObject(AUTH);
      expect((await stored(store, body.after))?.authentication).toMatchObject(AUTH);
    });
  });

  it("destroys the old record, so a copy of that cookie authenticates nothing", async () => {
    // The finding this exists for: attacker and victim share ONE session id, so
    // "delete every session except the current one" spared the attacker. After
    // rotation the copy points at an id that is simply gone.
    await withServer(async (base, store) => {
      const login = await fetch(`${base}/login`);
      const stolen = cookieOf(login);
      const { sid } = await login.json();
      expect((await stored(store, sid))?.authentication).toMatchObject(AUTH);

      await fetch(`${base}/rotate`, { method: "POST", headers: { cookie: stolen } });

      expect(await stored(store, sid)).toBeFalsy();
      const replay = await fetch(`${base}/whoami`, { headers: { cookie: stolen } });
      const body = await replay.json();
      expect(body.auth).toBeNull();
      expect(body.sid).not.toBe(sid);
    });
  });

  it("hands back a new cookie so the honest browser stays logged in", async () => {
    await withServer(async base => {
      const login = await fetch(`${base}/login`);
      const res = await fetch(`${base}/rotate`, { method: "POST", headers: { cookie: cookieOf(login) } });
      const fresh = cookieOf(res);
      expect(fresh).not.toBe(cookieOf(login));

      const who = await fetch(`${base}/whoami`, { headers: { cookie: fresh } });
      expect((await who.json()).auth).toMatchObject(AUTH);
    });
  });
});

describe("accountsOf — the read shim for pre-multi-account sessions", () => {
  it("reads a legacy session as a one-account bag", () => {
    expect(accountsOf({ authentication: { ...AUTH } } as any).map(a => a.username)).toEqual([AUTH.username]);
  });

  it("prefers the accounts array once it exists", () => {
    const session: any = { authentication: { ...AUTH }, accounts: [{ ...AUTH, id: "u2", username: "other@x" }] };
    expect(accountsOf(session).map(a => a.id)).toEqual(["u2"]);
  });

  it("yields an empty bag for an anonymous session", () => {
    expect(accountsOf({} as any)).toEqual([]);
  });
});

describe("writeAccounts — the legacy mirror", () => {
  const acc = (id: string, over: any = {}) => ({ ...AUTH, id, username: `${id}@x`, ...over });

  it("mirrors the first USABLE account, skipping re-auth stubs", () => {
    // The mirror exists so a ROLLBACK to a single-account build still finds a working
    // session; mirroring a stub would roll back into a broken one.
    const session: any = {};
    writeAccounts(session, [acc("u1", { needsReauth: true, token: null }), acc("u2")]);
    expect(session.authentication?.id).toBe("u2");
    expect(session.accounts?.length).toBe(2);
  });

  it("nulls the mirror when nothing usable remains", () => {
    const session: any = {};
    writeAccounts(session, [acc("u1", { needsReauth: true, token: null })]);
    expect(session.authentication).toBeNull();
  });

  it("usableAccount rejects stubs and tokenless entries", () => {
    expect(usableAccount(acc("u1"))).toBe(true);
    expect(usableAccount(acc("u1", { needsReauth: true }))).toBe(false);
    expect(usableAccount(acc("u1", { token: "" }))).toBe(false);
  });
});

describe("rotateSession with several accounts", () => {
  it("carries the whole bag across the new session id", async () => {
    // Rotation happens on every add-account and password change; dropping all but the
    // mirror would silently sign the user out of every other account they had.
    const store = new ExpressSession.MemoryStore();
    const app = express();
    app.use(ExpressSession({
      secret: "test-secret-that-is-long-enough-to-be-plausible",
      resave: false,
      saveUninitialized: false,
      store,
    }));
    app.get("/login-two", (req, res) => {
      writeAccounts(req.session, [{ ...AUTH } as any, { ...AUTH, id: "u2", username: "second@x" } as any]);
      req.session.save(() => res.json({ sid: req.sessionID }));
    });
    app.post("/rotate", async (req, res) => {
      const before = req.sessionID;
      await rotateSession(req);
      res.json({ before, after: req.sessionID, accounts: req.session.accounts?.map(a => a.id) });
    });
    const server = app.listen(0);
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const login = await fetch(`${base}/login-two`);
      const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
      const res = await fetch(`${base}/rotate`, { method: "POST", headers: { cookie } });
      const body = await res.json();
      expect(body.after).not.toBe(body.before);
      expect(body.accounts).toEqual([AUTH.id, "u2"]);
    } finally { server.close(); }
  });
});

// A faithful-enough mini-Mongo for exactly the operators the eviction uses, so the
// END STATE is pinned, not just the query shapes. Implementing the operators here is
// circular only if the queries are wrong in the same way twice — which the shape
// tests below guard against.
const miniMongo = (docs: any[]) => {
  const matchesLeaf = (doc: any, path: string, cond: any): boolean => {
    const value = path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$exists" in cond) return (value !== undefined) === cond.$exists;
      if ("$ne" in cond) return value !== cond.$ne;
      if ("$elemMatch" in cond) {
        return Array.isArray(value) && value.some(item =>
          Object.entries(cond.$elemMatch).every(([k, c]) => matchesLeaf({ x: item }, `x.${k}`, c)));
      }
    }
    return value === cond;
  };
  const matches = (doc: any, filter: any) =>
    Object.entries(filter).every(([path, cond]) => matchesLeaf(doc, path, cond));
  return {
    docs,
    deleteMany(filter: any) {
      const stay = docs.filter(d => !matches(d, filter));
      const deletedCount = docs.length - stay.length;
      docs.length = 0; docs.push(...stay);
      return { deletedCount };
    },
    updateMany(filter: any, update: any, options?: any) {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (!matches(doc, filter)) continue;
        modifiedCount++;
        const applyPath = (path: string, fn: (parent: any, key: string) => void) => {
          const parts = path.split(".");
          const arrayIdx = parts.findIndex(part => part.startsWith("$["));
          if (arrayIdx !== -1) {
            const arr = parts.slice(0, arrayIdx).reduce((v, k) => v?.[k], doc) as any[];
            const name = parts[arrayIdx].slice(2, -1);
            const cond = (options?.arrayFilters ?? []).find((f: any) => Object.keys(f)[0].startsWith(name + "."));
            for (const item of arr ?? []) {
              const ok = !cond || Object.entries(cond).every(([k, c]) => item[k.split(".")[1]] === c);
              if (ok) {
                const rest = parts.slice(arrayIdx + 1);
                const parent = rest.slice(0, -1).reduce((v, k) => v?.[k], item);
                fn(parent ?? item, rest[rest.length - 1]);
              }
            }
          } else {
            const parent = parts.slice(0, -1).reduce((v, k) => v?.[k], doc);
            fn(parent, parts[parts.length - 1]);
          }
        };
        // Refuse what this fake cannot honour. It used to apply $set and $unset and walk
        // past everything else in silence, so the version bump the eviction now depends
        // on was simply not there — and the test still passed, still claiming to pin the
        // update end to end. A fake that shrugs at an operator it does not implement
        // reports success for code it never ran.
        const known = new Set(["$set", "$unset", "$inc"]);
        for (const op of Object.keys(update)) {
          if (!known.has(op)) throw new Error(`miniMongo does not implement ${op}`);
        }
        for (const [path, v] of Object.entries(update.$set ?? {})) applyPath(path, (parent, key) => { parent[key] = v; });
        for (const path of Object.keys(update.$unset ?? {})) applyPath(path, (parent, key) => { delete parent[key]; });
        for (const [path, v] of Object.entries(update.$inc ?? {})) {
          applyPath(path, (parent, key) => { parent[key] = (parent[key] ?? 0) + (v as number); });
        }
      }
      return { modifiedCount };
    },
  };
};

describe("buildEvictionOps — surgical eviction, pinned end to end", () => {
  const ops = buildEvictionOps("u1", "sid-keep", "_id");

  it("never touches the session performing the change", () => {
    expect((ops.deleteLegacy.filter as any)._id).toEqual({ $ne: "sid-keep" });
    expect((ops.stubAccounts.filter as any)._id).toEqual({ $ne: "sid-keep" });
    expect((ops.mirrorFilter as any)._id).toEqual({ $ne: "sid-keep" });
  });

  it("deletes ONLY legacy sessions — a multi-account doc must never match the delete", () => {
    // This is the filter standing between "surgical" and "your colleague lost all ten
    // mailboxes": a multi-account session also has authentication.id === u1 (the
    // mirror), and only the $exists guard keeps it out of the delete.
    expect((ops.deleteLegacy.filter as any)["session.accounts"]).toEqual({ $exists: false });
  });

  it("stubs the account in place, once, leaving other entries alone", () => {
    const keep = { _id: "sid-keep", session: { accounts: [{ id: "u1", token: "t-keep" }] } };
    const legacy = { _id: "s1", session: { authentication: { id: "u1", token: "t1" } } };
    const colleague = { _id: "s2", session: {
      authentication: { id: "u1", token: "t1" },
      accounts: [{ id: "u1", username: "shared@x", token: "t1" }, { id: "u2", username: "own@x", token: "t2" }],
    } };
    const alreadyStubbed = { _id: "s3", session: { accounts: [{ id: "u1", needsReauth: true }] } };
    const unrelated = { _id: "s4", session: { authentication: { id: "u3", token: "t3" } } };
    const db = miniMongo([keep, legacy, colleague, alreadyStubbed, unrelated]);

    const del = db.deleteMany(ops.deleteLegacy.filter);
    const stub = db.updateMany(ops.stubAccounts.filter, ops.stubAccounts.update, ops.stubAccounts.options);

    expect(del.deletedCount).toBe(1);                       // legacy u1 gone
    expect(stub.modifiedCount).toBe(1);                     // colleague stubbed, once
    expect(db.docs.map(d => d._id)).toEqual(["sid-keep", "s2", "s3", "s4"]);
    const entries = (colleague.session.accounts as any[]);
    expect(entries[0]).toMatchObject({ id: "u1", username: "shared@x", needsReauth: true });
    expect(entries[0].token).toBeUndefined();               // credential stripped
    expect(entries[1]).toMatchObject({ id: "u2", token: "t2" });  // the other nine survive
    // The mirror is no longer written here at all — it is DERIVED, by the same pipeline
    // stage every other session write uses, and this fake speaks only $set/$unset. What
    // it must not do is name the stubbed account, which the recompute guarantees and
    // session.mjs checks against a real Mongo; blanking it, which is what this used to
    // assert, was wrong whenever the session still held an account of its own.
    expect((ops.mirrorFilter as any)["session.accounts"]).toEqual({ $elemMatch: { id: "u1" } });
    expect((keep.session.accounts as any[])[0].token).toBe("t-keep"); // keep untouched
  });

  it("bumps the document version in the same update as the stub", () => {
    // Without this the eviction is undone by any peer request that loaded the session
    // moments earlier: its base version still matches, so the compare-and-swap lets its
    // whole pre-eviction snapshot through and the stripped token comes back. Measured on
    // the repro under session_resave: 10 of 10 rounds restored it.
    const colleague = { _id: "s2", session: {
      rev: 7,
      accounts: [{ id: "u1", username: "shared@x", token: "t1" }, { id: "u2", token: "t2" }],
    } };
    const untouched = { _id: "s9", session: { rev: 3, accounts: [{ id: "u3", token: "t3" }] } };
    const db = miniMongo([colleague, untouched]);
    db.updateMany(ops.stubAccounts.filter, ops.stubAccounts.update, ops.stubAccounts.options);
    expect(colleague.session.rev).toBe(8);
    expect(untouched.session.rev).toBe(3);   // a session that holds nothing of u1's stays put
  });

  it("versions a session that predates versioning", () => {
    // Upgrade, not migration: the field simply appears on the first write.
    const legacyDoc = { _id: "s5", session: { accounts: [{ id: "u1", token: "t1" }] } } as any;
    miniMongo([legacyDoc]).updateMany(ops.stubAccounts.filter, ops.stubAccounts.update, ops.stubAccounts.options);
    expect(legacyDoc.session.rev).toBe(1);
  });
});
