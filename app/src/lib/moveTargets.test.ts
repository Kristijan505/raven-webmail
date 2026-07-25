import { describe, expect, it } from "vitest";
import { moveDestinations } from "./moveTargets";
import type { Mailbox } from "./types";

const mb = (id: string, path: string, specialUse: string | null = null): Mailbox =>
  ({ id, path, name: path, specialUse } as Mailbox);

const inbox = mb("1", "INBOX");
const sent = mb("2", "Sent", "\\Sent");
const drafts = mb("3", "Drafts", "\\Drafts");
const trash = mb("4", "Trash", "\\Trash");
const junk = mb("5", "Junk", "\\Junk");
const work = mb("6", "Work");
const bills = mb("7", "Bills");

const all = [inbox, sent, drafts, trash, junk, work, bills];
const names = (list: Mailbox[]) => list.map(m => m.path);

describe("moveDestinations", () => {
  it("never offers Spam or Trash — both have their own toolbar button", () => {
    for (const source of [inbox, sent, trash, junk, work]) {
      const out = names(moveDestinations(source, all));
      expect(out).not.toContain("Junk");
      expect(out).not.toContain("Trash");
    }
  });

  it("never offers Drafts or Sent as a destination", () => {
    for (const source of [inbox, sent, trash, junk, work]) {
      const out = names(moveDestinations(source, all));
      expect(out).not.toContain("Drafts");
      expect(out).not.toContain("Sent");
    }
  });

  it("offers nothing at all from Drafts", () => {
    expect(moveDestinations(drafts, all)).toEqual([]);
  });

  it("offers only custom folders from Inbox", () => {
    expect(names(moveDestinations(inbox, all))).toEqual(["Work", "Bills"]);
  });

  it("offers custom folders from Sent, but not Inbox", () => {
    // A message you sent does not belong in the Inbox — that is how a sent mail could
    // be made to look received.
    expect(names(moveDestinations(sent, all))).toEqual(["Work", "Bills"]);
  });

  it("offers Inbox and custom folders from Trash, so undelete works", () => {
    expect(names(moveDestinations(trash, all))).toEqual(["INBOX", "Work", "Bills"]);
  });

  it("offers Inbox and custom folders from Spam", () => {
    expect(names(moveDestinations(junk, all))).toEqual(["INBOX", "Work", "Bills"]);
  });

  it("never offers the folder you are already in", () => {
    expect(names(moveDestinations(work, all))).toEqual(["INBOX", "Bills"]);
  });

  it("survives an account missing special-use folders", () => {
    // find() returns undefined for a Trash that was deleted or a Junk never
    // provisioned; nothing here may throw, because a throw in the calling reactive
    // block freezes the Svelte scheduler.
    expect(() => moveDestinations(work, [work, bills])).not.toThrow();
    expect(names(moveDestinations(work, [work, bills]))).toEqual(["Bills"]);
  });

  it("returns nothing rather than throwing when the mailbox is missing", () => {
    expect(moveDestinations(undefined, all)).toEqual([]);
  });
});
