import { describe, expect, it } from "vitest";
import { referenceFor, type Reference } from "./compose";
import type { Attachment } from "../types";

const att = (id: string, related = false): Attachment =>
  ({ id, filename: `${id}.pdf`, related } as Attachment);

const ref = (action: Reference["action"]): Reference =>
  ({ mailbox: "mb1", id: 42, action, attachments: false });

describe("referenceFor", () => {
  it("carries everything when the original could not be read", () => {
    // The distinction that matters most here: null is "unknown", not "none". Falling
    // back to false would turn a failed lookup into a forward that silently arrives
    // without its attachments — the very bug this whole path exists to fix.
    expect(referenceFor(ref("forward"), null)).toMatchObject({ attachments: true });
    expect(referenceFor(ref("forward"), undefined)).toMatchObject({ attachments: true });
  });

  it("names exactly the attachments still on the draft", () => {
    expect(referenceFor(ref("forward"), [att("ATT00001"), att("ATT00003")]))
      .toMatchObject({ attachments: ["ATT00001", "ATT00003"] });
  });

  it("sends an empty list once the user has removed them all", () => {
    // Not the same as `false` to WildDuck, but it lands in the same place: an array is
    // truthy, so it takes the narrowing branch and matches nothing.
    expect(referenceFor(ref("forward"), [])).toMatchObject({ attachments: [] });
  });

  it("never attaches anything to a reply", () => {
    // Standard mail behaviour, and it must not depend on what happens to be on the
    // draft — a reply has no carried list to begin with.
    expect(referenceFor(ref("reply"), null)).toMatchObject({ attachments: false });
    expect(referenceFor(ref("replyAll"), [att("ATT00001")])).toMatchObject({ attachments: false });
  });

  it("keeps the rest of the reference intact", () => {
    // mailbox and id are what WildDuck resolves the original through; losing them
    // would break the reference entirely.
    expect(referenceFor(ref("forward"), [])).toMatchObject({ mailbox: "mb1", id: 42, action: "forward" });
  });

  it("passes a missing reference straight through", () => {
    expect(referenceFor(undefined, [att("ATT00001")])).toBeUndefined();
  });
});
