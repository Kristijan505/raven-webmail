import { describe, expect, it } from "vitest";
import { decodeUnifiedCursor, encodeUnifiedCursor, mergeUnifiedRound, totalOf } from "./unified";
import type { UnifiedRoundInput } from "./unified";

const ACC_A = "615c1f2e4a3b9c0d7e8f1a2b";
const ACC_B = "715c1f2e4a3b9c0d7e8f1a2b";

const row = (id: number, idate: string) => ({ id, idate });
const round = (account: string, over: Partial<UnifiedRoundInput> = {}): UnifiedRoundInput => ({
  account,
  username: `${account.slice(0, 4)}@x`,
  results: [],
  skip: 0,
  pageCursor: null,
  nextCursor: false,
  total: 0,
  ...over,
});
const ids = (r: { results: Array<{ id: number; account: { id: string } }> }) =>
  r.results.map(m => `${m.account.id.slice(0, 4)}:${m.id}`);

describe("unified cursor codec", () => {
  it("round-trips", () => {
    const cursor = { [ACC_A]: { cursor: "abc", skip: 3 }, [ACC_B]: { cursor: null, skip: 0, done: true as const } };
    expect(decodeUnifiedCursor(encodeUnifiedCursor(cursor))).toEqual(cursor);
  });

  it("rejects garbage instead of guessing", () => {
    // The cursor is client-supplied input that parameterizes upstream fetches;
    // anything off must be a 400, not a partially-honored object.
    expect(decodeUnifiedCursor("not-base64!!")).toBeNull();
    expect(decodeUnifiedCursor(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
    expect(decodeUnifiedCursor(Buffer.from('{"not-an-objectid":{"cursor":null,"skip":0}}').toString("base64url"))).toBeNull();
    expect(decodeUnifiedCursor(Buffer.from(`{"${ACC_A}":{"cursor":null,"skip":-1}}`).toString("base64url"))).toBeNull();
    expect(decodeUnifiedCursor(Buffer.from(`{"${ACC_A}":{"cursor":null,"skip":9999}}`).toString("base64url"))).toBeNull();
    expect(decodeUnifiedCursor(Buffer.from(`{"${ACC_A}":{"cursor":${JSON.stringify("x".repeat(600))},"skip":0}}`).toString("base64url"))).toBeNull();
  });

  it("normalizes a done entry to its canonical shape", () => {
    const decoded = decodeUnifiedCursor(Buffer.from(`{"${ACC_A}":{"done":true,"cursor":"junk","skip":42}}`).toString("base64url"));
    expect(decoded).toEqual({ [ACC_A]: { cursor: null, skip: 0, done: true } });
  });
});

describe("mergeUnifiedRound", () => {
  it("interleaves accounts newest-first by idate", () => {
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(2, "2026-07-30T10:00:00Z"), row(1, "2026-07-30T08:00:00Z")] }),
      round(ACC_B, { results: [row(9, "2026-07-30T09:00:00Z")] }),
    ], 10);
    expect(ids(merged)).toEqual(["615c:2", "715c:9", "615c:1"]);
    expect(merged.hasMore).toBe(false);
  });

  it("keeps colliding uids apart — id alone is NOT the key across accounts", () => {
    // WildDuck uids are small per-mailbox integers; two accounts will collide on id 5
    // in real use. The unified list must key by (account, id), never id.
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(5, "2026-07-30T10:00:00Z")] }),
      round(ACC_B, { results: [row(5, "2026-07-30T09:00:00Z")] }),
    ], 10);
    expect(merged.results).toHaveLength(2);
    expect(ids(merged)).toEqual(["615c:5", "715c:5"]);
  });

  it("applies the skip so re-fetched rows are not served twice", () => {
    const page = [row(3, "2026-07-30T10:00:00Z"), row(2, "2026-07-30T09:00:00Z"), row(1, "2026-07-30T08:00:00Z")];
    const merged = mergeUnifiedRound([round(ACC_A, { results: page, skip: 2, pageCursor: "p1" })], 10);
    expect(ids(merged)).toEqual(["615c:1"]);
  });

  it("keeps the SAME page cursor with a larger skip when a page is only partly used", () => {
    // The heart of statelessness: WildDuck cursors advance in whole pages, so a
    // half-consumed page is remembered as (same cursor, bigger skip) and refetched.
    const pageA = [row(3, "2026-07-30T12:00:00Z"), row(2, "2026-07-30T11:00:00Z")];
    const pageB = [row(7, "2026-07-30T10:00:00Z")];
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: pageA, pageCursor: "curA", nextCursor: "nextA" }),
      round(ACC_B, { results: pageB, pageCursor: null, nextCursor: false }),
    ], 1);
    expect(ids(merged)).toEqual(["615c:3"]);
    expect(merged.cursor[ACC_A]).toEqual({ cursor: "curA", skip: 1, total: 0 });
    expect(merged.cursor[ACC_B]).toEqual({ cursor: null, skip: 0, total: 0 });
    expect(merged.hasMore).toBe(true);
  });

  it("advances to the upstream nextCursor once a page is fully consumed", () => {
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(3, "2026-07-30T12:00:00Z")], pageCursor: "curA", nextCursor: "nextA" }),
    ], 10);
    expect(merged.cursor[ACC_A]).toEqual({ cursor: "nextA", skip: 0, total: 0 });
    expect(merged.hasMore).toBe(true);
  });

  it("marks an exhausted account done, and only all-done ends the list", () => {
    // B carries two rows so the merge can drain A before B's page runs out — an
    // account is only `done` once its rows have actually been SERVED, which is why
    // the shape here is not simply one row each.
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(1, "2026-07-30T08:00:00Z")], nextCursor: false }),
      round(ACC_B, { results: [row(2, "2026-07-30T09:00:00Z"), row(3, "2026-07-30T07:00:00Z")], nextCursor: "moreB" }),
    ], 10);
    expect(ids(merged)).toEqual(["715c:2", "615c:1", "715c:3"]);
    expect(merged.cursor[ACC_A]).toEqual({ cursor: null, skip: 0, done: true, total: 0 });
    expect(merged.cursor[ACC_B]).toEqual({ cursor: "moreB", skip: 0, total: 0 });
    expect(merged.hasMore).toBe(true);

    const finished = mergeUnifiedRound([
      round(ACC_A, { results: [row(1, "2026-07-30T08:00:00Z")], nextCursor: false }),
    ], 10);
    expect(finished.hasMore).toBe(false);
  });

  it("breaks idate ties deterministically by account id, preserving upstream order within an account", () => {
    // Within one account the page order is authoritative (WildDuck returns uid
    // descending) — the merge never reorders it; the tie-break only decides which
    // ACCOUNT'S head goes first when idates match exactly.
    const at = "2026-07-30T10:00:00Z";
    const merged = mergeUnifiedRound([
      round(ACC_B, { results: [row(1, at)] }),
      round(ACC_A, { results: [row(9, at), row(4, at)] }),
    ], 10);
    expect(ids(merged)).toEqual(["615c:9", "615c:4", "715c:1"]);
  });

  it("honors the limit across accounts and sums totals", () => {
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(2, "2026-07-30T10:00:00Z"), row(1, "2026-07-30T08:00:00Z")], total: 40 }),
      round(ACC_B, { results: [row(9, "2026-07-30T09:00:00Z")], total: 2 }),
    ], 2);
    expect(ids(merged)).toEqual(["615c:2", "715c:9"]);
    expect(merged.total).toBe(42);
    expect(merged.hasMore).toBe(true); // A:1 still unserved via skip
    expect(merged.cursor[ACC_A]).toEqual({ cursor: null, skip: 1, total: 40 });
  });
});

describe("mergeUnifiedRound — ordering across page boundaries", () => {
  it("stops rather than serve a row an unfetched page could outrank", () => {
    // The bug the E2E harness caught, reduced. Account A's fetched page has one row
    // left (18:00) and MORE pages behind it; account B has one row left (16:30) and
    // is likewise mid-list. Emitting both would serve 16:30 before A's 17:00 — which
    // exists, but on a page nobody had fetched yet.
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(2, "2026-07-30T18:00:00Z")], pageCursor: "pA", nextCursor: "nextA" }),
      round(ACC_B, { results: [row(8, "2026-07-30T16:30:00Z")], pageCursor: "pB", nextCursor: "nextB" }),
    ], 10);
    expect(ids(merged)).toEqual(["615c:2"]);
    // A is exhausted, so it advances; B keeps its unserved row for the next round.
    expect(merged.cursor[ACC_A]).toEqual({ cursor: "nextA", skip: 0, total: 0 });
    expect(merged.cursor[ACC_B]).toEqual({ cursor: "pB", skip: 0, total: 0 });
    expect(merged.hasMore).toBe(true);
  });

  it("keeps draining an account that has no more pages", () => {
    // The guard is about UNFETCHED rows. An exhausted account with nothing behind it
    // can never outrank anything, so the merge must keep going — otherwise the last
    // page of a finished account would stall the whole list.
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(2, "2026-07-30T18:00:00Z")], nextCursor: false }),
      round(ACC_B, { results: [row(8, "2026-07-30T16:30:00Z"), row(7, "2026-07-30T15:00:00Z")], nextCursor: false }),
    ], 10);
    expect(ids(merged)).toEqual(["615c:2", "715c:8", "715c:7"]);
    expect(merged.hasMore).toBe(false);
  });
});

describe("unified total across rounds", () => {
  // The count above the list must not shrink as the reader pages. An account that
  // runs out is carried as `done` and stops producing rounds, so the total can only
  // stay honest if the cursor remembers what each account contributed.
  it("keeps counting an account that has already finished", () => {
    // A has more pages behind it; B's single page is its whole mailbox, so B ends
    // this round `done` and never appears in a round again.
    const first = mergeUnifiedRound([
      round(ACC_A, {
        results: [row(2, "2026-07-30T10:00:00Z"), row(1, "2026-07-30T08:00:00Z")],
        total: 40, nextCursor: "nextA",
      }),
      round(ACC_B, { results: [row(9, "2026-07-30T09:00:00Z")], total: 2 }),
    ], 10);
    expect(first.total).toBe(42);
    expect(first.cursor[ACC_B]).toEqual({ cursor: null, skip: 0, done: true, total: 2 });

    // Round two: B is done, so the route fetches only A and carries B's entry.
    const carried = { [ACC_B]: first.cursor[ACC_B] };
    const second = mergeUnifiedRound([
      round(ACC_A, { results: [row(0, "2026-07-30T07:00:00Z")], total: 40, pageCursor: "nextA" }),
    ], 10);
    expect(second.total).toBe(40);                              // the merge alone cannot see B…
    expect(totalOf({ ...second.cursor, ...carried })).toBe(42); // …the whole cursor can.
  });

  it("carries the total through the wire format", () => {
    const cursor = {
      [ACC_A]: { cursor: "abc", skip: 3, total: 40 },
      [ACC_B]: { cursor: null, skip: 0, done: true as const, total: 2 },
    };
    expect(decodeUnifiedCursor(encodeUnifiedCursor(cursor))).toEqual(cursor);
    expect(totalOf(decodeUnifiedCursor(encodeUnifiedCursor(cursor))!)).toBe(42);
  });

  it("still reads a cursor minted before totals existed", () => {
    const old = encodeUnifiedCursor({ [ACC_A]: { cursor: "abc", skip: 3 } } as any);
    expect(decodeUnifiedCursor(old)).toEqual({ [ACC_A]: { cursor: "abc", skip: 3 } });
    expect(totalOf(decodeUnifiedCursor(old)!)).toBe(0);
  });

  it("rejects a tampered total rather than printing it", () => {
    const enc = (v: unknown) =>
      Buffer.from(JSON.stringify({ [ACC_A]: { cursor: null, skip: 0, total: v } }), "utf8").toString("base64url");
    expect(decodeUnifiedCursor(enc(-1))).toBe(null);
    expect(decodeUnifiedCursor(enc(1.5))).toBe(null);
    expect(decodeUnifiedCursor(enc("40"))).toBe(null);
  });
});
