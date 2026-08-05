import { describe, expect, it } from "vitest";
import { hitUpdate } from "./ratelimit";

/**
 * The window arithmetic, pinned. An inverted condition here is the kind of bug that
 * looks fine in a smoke test and is either "the limit never applies" (a fresh window
 * every hit) or "the limit never lifts" (counting into a window that ended hours ago).
 */
describe("hitUpdate", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const WINDOW = 15 * 60 * 1000;
  const [stage] = hitUpdate(now, WINDOW) as any[];
  const hits = stage.$set.hits.$cond;
  const expires = stage.$set.expiresAt.$cond;

  it("counts on inside a window that is still open", () => {
    // The condition both fields branch on is the SAME question: is the stored window
    // still in the future?
    expect(hits[0]).toEqual({ $gt: ["$expiresAt", now] });
    expect(expires[0]).toEqual({ $gt: ["$expiresAt", now] });
    // then-branch: one more hit, window untouched
    expect(hits[1]).toEqual({ $add: [{ $ifNull: ["$hits", 0] }, 1] });
    expect(expires[1]).toBe("$expiresAt");
  });

  it("starts over when the window has passed", () => {
    // else-branch: back to one, and a window that ends exactly windowMs from now
    expect(hits[2]).toBe(1);
    expect(expires[2]).toEqual(new Date(now.getTime() + WINDOW));
  });

  it("treats a document that has never been written as a first hit", () => {
    // On an upsert `$expiresAt` is missing, so $gt is false and the else-branch runs —
    // which is why the else-branch must be the one that sets 1 and a fresh window.
    expect(hits[2]).toBe(1);
    expect(expires[2] instanceof Date).toBe(true);
  });
});
