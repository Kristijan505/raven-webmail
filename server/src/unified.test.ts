import { describe, expect, it } from "vitest";
import { decodeUnifiedCursor, encodeUnifiedCursor, mergeUnifiedRound } from "./unified";
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
    expect(merged.cursor[ACC_A]).toEqual({ cursor: "curA", skip: 1 });
    expect(merged.cursor[ACC_B]).toEqual({ cursor: null, skip: 0 });
    expect(merged.hasMore).toBe(true);
  });

  it("advances to the upstream nextCursor once a page is fully consumed", () => {
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(3, "2026-07-30T12:00:00Z")], pageCursor: "curA", nextCursor: "nextA" }),
    ], 10);
    expect(merged.cursor[ACC_A]).toEqual({ cursor: "nextA", skip: 0 });
    expect(merged.hasMore).toBe(true);
  });

  it("marks an exhausted account done, and only all-done ends the list", () => {
    const merged = mergeUnifiedRound([
      round(ACC_A, { results: [row(1, "2026-07-30T08:00:00Z")], nextCursor: false }),
      round(ACC_B, { results: [row(2, "2026-07-30T09:00:00Z")], nextCursor: "moreB" }),
    ], 10);
    expect(merged.cursor[ACC_A]).toEqual({ cursor: null, skip: 0, done: true });
    expect(merged.cursor[ACC_B]).toEqual({ cursor: "moreB", skip: 0 });
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
    expect(merged.cursor[ACC_A]).toEqual({ cursor: null, skip: 1 });
  });
});
