import { describe, expect, it } from "vitest";
import { dedupById, reconcileFirstPage } from "./reconcile";
import type { Message } from "../types";

const msg = (id: number): Message => ({ id, subject: `msg-${id}` } as Message);
const ids = (list: Message[]) => list.map(m => m.id);
const rows = (r: { results: Message[] }) => r.results.map(m => m.id);

describe("dedupById", () => {
  it("keeps the first occurrence of a repeated id", () => {
    expect(ids(dedupById([msg(3), msg(2), msg(3)]))).toEqual([3, 2]);
  });

  it("leaves a list without repeats untouched", () => {
    expect(ids(dedupById([msg(3), msg(2), msg(1)]))).toEqual([3, 2, 1]);
  });
});

describe("reconcileFirstPage", () => {
  // The regression this whole module exists for: compose saves a draft by
  // creating a new message and deleting the old one, so the orphan's id is
  // always BELOW its replacement's. If the EXPUNGE is missed, only the refetch
  // can clear it.
  it("drops an orphaned draft that sits below the fresh page when there are no older pages", () => {
    const current = [msg(102), msg(101)]; // 101 was deleted server-side, EXPUNGE lost
    const fresh = [msg(102)];
    expect(rows(reconcileFirstPage({ results: current, nextCursor: false }, { results: fresh, nextCursor: false }))).toEqual([102]);
  });

  it("keeps rows below the fresh page while older pages still exist", () => {
    // The user paginated with next(); rows below the first page are real.
    const current = [msg(50), msg(49), msg(20), msg(19)];
    const fresh = [msg(50), msg(49)];
    expect(rows(reconcileFirstPage({ results: current, nextCursor: "c1" }, { results: fresh, nextCursor: "c2" }))).toEqual([50, 49, 20, 19]);
  });

  it("drops a stale row that falls inside the fresh page's id window", () => {
    const current = [msg(30), msg(29), msg(28)];
    const fresh = [msg(30), msg(28)]; // 29 is gone
    expect(rows(reconcileFirstPage({ results: current, nextCursor: false }, { results: fresh, nextCursor: false }))).toEqual([30, 28]);
  });

  it("prepends newly arrived messages", () => {
    expect(rows(reconcileFirstPage({ results: [msg(10)], nextCursor: false }, { results: [msg(12), msg(11), msg(10)], nextCursor: false })))
      .toEqual([12, 11, 10]);
  });

  it("keeps the list on an empty response when the total is unknown", () => {
    expect(rows(reconcileFirstPage({ results: [msg(9), msg(8)], nextCursor: false }, { results: [], nextCursor: false }))).toEqual([9, 8]);
    expect(rows(reconcileFirstPage({ results: [msg(9), msg(8)], nextCursor: "c1" }, { results: [], nextCursor: "c1" }))).toEqual([9, 8]);
  });

  it("keeps the list on an empty page the server still counts as non-empty", () => {
    // A blank page that contradicts the server's own total is a blip, not an empty
    // mailbox — wiping here would clear a mailbox the user had scrolled through.
    expect(rows(reconcileFirstPage({ results: [msg(9), msg(8)], nextCursor: false }, { results: [], nextCursor: false, total: 2 }))).toEqual([9, 8]);
  });

  it("clears the list when the server confirms the mailbox is empty", () => {
    // The ghost-row case: the mailbox really did empty (discarded drafts, another
    // client) and the EXPUNGE events never arrived, so only the refetch can say so.
    expect(rows(reconcileFirstPage({ results: [msg(9), msg(8)], nextCursor: false }, { results: [], nextCursor: false, total: 0 }))).toEqual([]);
  });

  it("cannot emit a duplicate key even if fresh and current overlap", () => {
    const current = [msg(7), msg(6), msg(5)];
    const fresh = [msg(7), msg(6)];
    const out = reconcileFirstPage({ results: current, nextCursor: "c1" }, { results: fresh, nextCursor: "c2" });
    expect(ids(out.results)).toEqual([7, 6, 5]);
    expect(new Set(ids(out.results)).size).toBe(out.results.length);
  });

  it("keeps the existing cursor while already-paginated rows are retained", () => {
    // Codex's case. Everything was loaded (cursor false), then one message arrived, so
    // the refetched FIRST page reports a cursor again. Adopting it would bring "load
    // more" back for pages already on screen: the click refetches them, dedup drops
    // every row, and nothing appears to happen until the cursor walks past what is
    // already loaded.
    const current = { results: [msg(50), msg(49), msg(20), msg(19)], nextCursor: false as const };
    const fresh = { results: [msg(51), msg(50), msg(49)], nextCursor: "page2" };
    const out = reconcileFirstPage(current, fresh);
    expect(ids(out.results)).toEqual([51, 50, 49, 20, 19]);
    expect(out.nextCursor).toBe(false);
  });

  it("adopts the fresh cursor when nothing older was retained", () => {
    // First load, or a refetch that supersedes everything held: the fresh page then
    // describes the whole list and its cursor is the one to continue from.
    const out = reconcileFirstPage(
      { results: [msg(50)], nextCursor: false },
      { results: [msg(51), msg(50)], nextCursor: "page2" },
    );
    expect(out.nextCursor).toBe("page2");
  });

  it("keeps the cursor when a blank page is treated as a blip", () => {
    const out = reconcileFirstPage(
      { results: [msg(9)], nextCursor: "page2" },
      { results: [], nextCursor: false, total: 5 },
    );
    expect(ids(out.results)).toEqual([9]);
    expect(out.nextCursor).toBe("page2");
  });

  it("restarts from the fresh cursor when a gap opened between the pages", () => {
    // More than a page arrived while nothing was listening (SSE drop, backgrounded
    // tab), so the refetched first page stops ABOVE everything held and 110..101 was
    // never fetched by anyone. Keeping the old cursor would point below the retained
    // rows and strand that run permanently — no "load more" walks through it.
    const current = { results: [msg(100), msg(99)], nextCursor: false as const };
    const fresh = { results: [msg(160), msg(159)], nextCursor: "110" };
    const out = reconcileFirstPage(current, fresh);
    expect(ids(out.results)).toEqual([160, 159, 100, 99]);
    expect(out.nextCursor).toBe("110");
  });

  it("still keeps the old cursor when the pages actually meet", () => {
    // The distinction the line above turns on: here the fresh page reaches back into
    // rows already held, so the two halves are one run and the old cursor is right.
    const current = { results: [msg(50), msg(49), msg(20)], nextCursor: "deep" };
    const fresh = { results: [msg(51), msg(50), msg(49)], nextCursor: "page2" };
    expect(reconcileFirstPage(current, fresh).nextCursor).toBe("deep");
  });

  it("clears the cursor along with the list when the mailbox is confirmed empty", () => {
    const out = reconcileFirstPage(
      { results: [msg(9)], nextCursor: "page2" },
      { results: [], nextCursor: false, total: 0 },
    );
    expect(out.results).toEqual([]);
    expect(out.nextCursor).toBe(false);
  });
});
