import { describe, it, expect } from "vitest";
import express from "express";
import ExpressSession from "express-session";
import type { AddressInfo } from "node:net";
import { rotateSession } from "./session";

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
