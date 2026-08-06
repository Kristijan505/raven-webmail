import { describe, expect, it } from "vitest";
import { flushDrafts, registerDraftFlush, trackTeardownSave } from "./compose";

/**
 * Minimizing a compose window UNMOUNTS it: the teardown fires one last save and then
 * unregisters the window's flusher. So an account switch or a sign-out moments later
 * finds no flusher for that draft, waits for nothing, and replaces the document —
 * aborting a save that was still in flight while flushDrafts() reports success.
 *
 * These pin the part that has no component left to speak for it.
 */
describe("flushDrafts — windows that are already gone", () => {
  it("keeps waiting while a departed window's save is still in flight", async () => {
    let land!: () => void;
    trackTeardownSave(new Promise<void>(resolve => { land = resolve; }));

    let resolved = false;
    const flushing = flushDrafts().then(v => { resolved = true; return v; });
    await new Promise(r => setTimeout(r, 20));
    // Nothing is registered as a flusher — the window unregistered on its way out — so
    // without the save being tracked this has already resolved and the caller is free to
    // replace the document out from under it.
    expect(resolved).toBe(false);

    land();
    expect(await flushing).toBe(true);
  });

  it("reports failure when that save could not land", async () => {
    trackTeardownSave(Promise.reject(new Error("upstream refused")));
    // false is what stops the caller: the edits exist nowhere but the page it is about
    // to throw away.
    expect(await flushDrafts()).toBe(false);
  });

  it("still reports an open window's failure", async () => {
    const off = registerDraftFlush(() => Promise.reject(new Error("upstream refused")));
    expect(await flushDrafts()).toBe(false);
    off();
    expect(await flushDrafts()).toBe(true);
  });
});
