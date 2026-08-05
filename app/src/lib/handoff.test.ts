import { beforeEach, describe, expect, it, vi } from "vitest";

const flushDrafts = vi.fn<() => Promise<boolean>>();
const setTabAccount = vi.fn<(id: string | null) => boolean>();
const invalidateAll = vi.fn();

vi.mock("$app/navigation", () => ({ invalidateAll: () => invalidateAll() }));
vi.mock("$lib/Compose/compose", () => ({ flushDrafts: () => flushDrafts() }));
vi.mock("$lib/intertab", () => ({ intertab: () => ({ set: () => {}, watch: () => () => {} }) }));
vi.mock("$lib/account", () => ({
  setTabAccount: (id: string | null) => setTabAccount(id),
  tabAccount: { subscribe: (run: (v: string | null) => void) => { run(null); return () => {}; } },
}));

const { repinTab } = await import("./handoff");

const reload = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).location = { reload, assign: vi.fn() };
  flushDrafts.mockResolvedValue(true);
  setTabAccount.mockReturnValue(true);
});

/**
 * The guard fires when a URL belongs to an account this tab is not pinned to — a
 * bookmark, a link from a unified row. It corrects the pin and rebuilds. Rebuilding by
 * replacing the document destroys the global composer, so what it must never do is
 * replace the document while something is unsaved.
 */
describe("repinTab", () => {
  it("replaces the document once everything is saved and the pin stuck", async () => {
    await repinTab("acct-b");
    expect(setTabAccount).toHaveBeenCalledWith("acct-b");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it("saves BEFORE it pins and reloads", async () => {
    const order: string[] = [];
    flushDrafts.mockImplementation(async () => { order.push("flush"); return true; });
    setTabAccount.mockImplementation(() => { order.push("pin"); return true; });
    reload.mockImplementation(() => { order.push("reload"); });
    await repinTab("acct-b");
    expect(order).toEqual(["flush", "pin", "reload"]);
  });

  it("rebuilds in place instead of reloading when a draft could not be saved", async () => {
    flushDrafts.mockResolvedValue(false);
    await repinTab("acct-b");
    // The pin is still corrected — the page ALREADY belongs to the other account, and
    // leaving the tab stamping requests for the previous one is the bug this guard
    // exists to stop. What is skipped is throwing the writing away.
    expect(setTabAccount).toHaveBeenCalledWith("acct-b");
    expect(reload).not.toHaveBeenCalled();
    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("rebuilds in place when the pin could not be stored", async () => {
    // Web Storage disabled: the pin lives in this document alone, so a reload would drop
    // it and land back on the wrong account, firing the guard again.
    setTabAccount.mockReturnValue(false);
    await repinTab("acct-b");
    expect(reload).not.toHaveBeenCalled();
    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("ignores a second call while the first is still flushing", async () => {
    let land!: (v: boolean) => void;
    flushDrafts.mockReturnValueOnce(new Promise<boolean>(res => { land = res; }));
    const first = repinTab("acct-b");
    // The guard lives in a reactive statement, so it can fire again mid-flush. Twice
    // means two flushes racing one reload.
    await repinTab("acct-b");
    expect(flushDrafts).toHaveBeenCalledTimes(1);
    land(true);
    await first;
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
