import { describe, expect, it } from "vitest";
import { claimCarried, referenceFor, type Reference } from "./compose";
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

describe("claimCarried", () => {
  const att = (id: string, over: Partial<Attachment> = {}): Attachment =>
    ({ id, filename: `${id}.pdf`, sizeKb: 10, related: false, ...over } as Attachment);
  const ids = (list: Attachment[]) => list.map(a => a.id);

  it("keeps the originals the draft still has a copy of", () => {
    // The copies carry ids from the new message's mime tree, never the original's, so
    // the join has to be on content.
    const original = [att("ATT00003", { hash: "h1" }), att("ATT00004", { hash: "h2" })];
    const onDraft = [att("ATT00001", { hash: "h1" })];
    expect(ids(claimCarried(original, onDraft))).toEqual(["ATT00003"]);
  });

  it("leaves embedded images out whatever the draft holds", () => {
    const original = [att("ATT00001", { hash: "h1", related: true }), att("ATT00003", { hash: "h2" })];
    expect(ids(claimCarried(original, [att("x", { hash: "h1" }), att("y", { hash: "h2" })])))
      .toEqual(["ATT00003"]);
  });

  it("spends each copy once when the same file is attached twice", () => {
    // One survivor cannot vouch for both originals — that would restore the row the
    // user just removed.
    const twice = [att("ATT00003", { hash: "same" }), att("ATT00004", { hash: "same" })];
    expect(ids(claimCarried(twice, [att("ATT00001", { hash: "same" })]))).toEqual(["ATT00003"]);
    expect(ids(claimCarried(twice, [att("A", { hash: "same" }), att("B", { hash: "same" })])))
      .toEqual(["ATT00003", "ATT00004"]);
  });

  it("lets two known hashes settle it, name and size notwithstanding", () => {
    // Same name, same size, different contents: the hashes are authoritative, and the
    // metadata comparison must not overrule them.
    const original = [att("ATT00003", { hash: "gone", filename: "ponuda.pdf" })];
    const onDraft = [att("ATT00001", { hash: "other", filename: "ponuda.pdf" })];
    expect(claimCarried(original, onDraft)).toEqual([]);
  });

  it("falls back to name and size only when a hash is missing", () => {
    const named = (id: string, over = {}) => att(id, { filename: "ponuda.pdf", ...over });
    expect(ids(claimCarried([named("ATT00003")], [named("ATT00001")]))).toEqual(["ATT00003"]);
    expect(claimCarried([named("ATT00003", { sizeKb: 10 })], [named("ATT00001", { sizeKb: 99 })])).toEqual([]);
  });

  it("keeps nothing when the draft carries nothing", () => {
    expect(claimCarried([att("ATT00003", { hash: "h1" })], [])).toEqual([]);
  });
});

describe("claimCarried and the rest of the draft's parts", () => {
  const att = (id: string, over: Partial<Attachment> = {}): Attachment =>
    ({ id, filename: `${id}.pdf`, sizeKb: 10, related: false, ...over } as Attachment);
  const ids = (list: Attachment[]) => list.map(a => a.id);
  const upload = (filename: string) => ({ id: "s1", filename, contentType: "application/pdf", size: 1024 });

  it("does not let an upload vouch for the carried file it replaced", () => {
    // Remove ponuda.pdf, then attach your own ponuda.pdf: the upload lands in the
    // draft's attachments too, and counting it as evidence would restore the original
    // beside it — the message then goes out carrying the file twice.
    const original = [att("ATT00003", { hash: "h1", filename: "ponuda.pdf" })];
    const onDraft = [att("ATT00001", { hash: "h1", filename: "ponuda.pdf" })];
    expect(claimCarried(original, onDraft, [upload("ponuda.pdf")])).toEqual([]);
  });

  it("still keeps a carried file when an upload merely shares its name", () => {
    // Two parts, one name: the upload accounts for one of them, the carried copy for
    // the other. Discarding by name alone would have dropped both.
    const original = [att("ATT00003", { hash: "h1", filename: "ponuda.pdf" })];
    const onDraft = [
      att("ATT00001", { hash: "h1", filename: "ponuda.pdf" }),
      att("ATT00002", { hash: "h9", filename: "ponuda.pdf" }),
    ];
    expect(ids(claimCarried(original, onDraft, [upload("ponuda.pdf")]))).toEqual(["ATT00003"]);
  });

  it("ignores embedded parts on the draft as evidence", () => {
    const original = [att("ATT00003", { hash: "h1", filename: "logo.png" })];
    const onDraft = [att("ATT00001", { hash: "h1", filename: "logo.png", related: true })];
    expect(claimCarried(original, onDraft)).toEqual([]);
  });

  it("settles certain hash pairs before falling back to name and size", () => {
    // Same name and size; the first original has no hash, the second does, and only the
    // second's copy survives. Matching in one greedy pass let the hashless one take that
    // copy, swapping which id was selected — the next save would restore the removed
    // file and drop the kept one.
    const original = [
      att("ATT00003", { filename: "ponuda.pdf", sizeKb: 10 }),
      att("ATT00004", { hash: "h2", filename: "ponuda.pdf", sizeKb: 10 }),
    ];
    const onDraft = [att("ATT00001", { hash: "h2", filename: "ponuda.pdf", sizeKb: 10 })];
    expect(ids(claimCarried(original, onDraft))).toEqual(["ATT00004"]);
  });
});
