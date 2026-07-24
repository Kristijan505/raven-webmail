import { describe, expect, it } from "vitest";
import { dedupById, reconcileFirstPage } from "./reconcile";
import type { Message } from "../types";

const msg = (id: number): Message => ({ id, subject: `msg-${id}` } as Message);
const ids = (list: Message[]) => list.map(m => m.id);

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
    expect(ids(reconcileFirstPage(current, fresh, false))).toEqual([102]);
  });

  it("keeps rows below the fresh page while older pages still exist", () => {
    // The user paginated with next(); rows below the first page are real.
    const current = [msg(50), msg(49), msg(20), msg(19)];
    const fresh = [msg(50), msg(49)];
    expect(ids(reconcileFirstPage(current, fresh, true))).toEqual([50, 49, 20, 19]);
  });

  it("drops a stale row that falls inside the fresh page's id window", () => {
    const current = [msg(30), msg(29), msg(28)];
    const fresh = [msg(30), msg(28)]; // 29 is gone
    expect(ids(reconcileFirstPage(current, fresh, false))).toEqual([30, 28]);
  });

  it("prepends newly arrived messages", () => {
    expect(ids(reconcileFirstPage([msg(10)], [msg(12), msg(11), msg(10)], false)))
      .toEqual([12, 11, 10]);
  });

  it("never wipes the list on an empty response", () => {
    expect(ids(reconcileFirstPage([msg(9), msg(8)], [], false))).toEqual([9, 8]);
    expect(ids(reconcileFirstPage([msg(9), msg(8)], [], true))).toEqual([9, 8]);
  });

  it("reports an empty mailbox as empty once the fresh page confirms it", () => {
    // Distinct from the case above: the server DID return a page, it just has
    // nothing left in it after the last draft was discarded.
    expect(ids(reconcileFirstPage([msg(9)], [msg(9)], false))).toEqual([9]);
  });

  it("cannot emit a duplicate key even if fresh and current overlap", () => {
    const current = [msg(7), msg(6), msg(5)];
    const fresh = [msg(7), msg(6)];
    const out = reconcileFirstPage(current, fresh, true);
    expect(ids(out)).toEqual([7, 6, 5]);
    expect(new Set(ids(out)).size).toBe(out.length);
  });
});
