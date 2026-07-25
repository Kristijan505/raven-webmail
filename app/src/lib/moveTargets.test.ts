import { describe, expect, it } from "vitest";
import { moveDestinations, wasSent } from "./moveTargets";
import type { Mailbox } from "./types";

const ME = "kiki@red-code.dev";
const mine = { from: { address: ME } };
const theirs = { from: { address: "kolega@example.com" } };

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

  it("never offers Drafts, and offers Sent only for mail that was sent", () => {
    for (const source of [inbox, sent, trash, junk, work]) {
      expect(names(moveDestinations(source, all, [theirs], ME))).not.toContain("Drafts");
      // Received mail must never be filable into Sent, whatever folder it is in now.
      expect(names(moveDestinations(source, all, [theirs], ME))).not.toContain("Sent");
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
    expect(names(moveDestinations(trash, all, [theirs], ME))).toEqual(["INBOX", "Work", "Bills"]);
  });

  it("offers Inbox and custom folders from Spam", () => {
    expect(names(moveDestinations(junk, all, [theirs], ME))).toEqual(["INBOX", "Work", "Bills"]);
  });

  it("never offers the folder you are already in", () => {
    expect(names(moveDestinations(work, all, [theirs], ME))).toEqual(["INBOX", "Bills"]);
  });

  it("survives an account missing special-use folders", () => {
    // find() returns undefined for a Trash that was deleted or a Junk never
    // provisioned; nothing here may throw, because a throw in the calling reactive
    // block freezes the Svelte scheduler.
    expect(() => moveDestinations(work, [work, bills], [theirs], ME)).not.toThrow();
    expect(names(moveDestinations(work, [work, bills], [theirs], ME))).toEqual(["Bills"]);
  });

  it("returns nothing rather than throwing when the mailbox is missing", () => {
    expect(moveDestinations(undefined, all)).toEqual([]);
  });

  it("never offers Inbox for mail this account sent", () => {
    // The reported bug: a sent message trashed and then restored into the Inbox reads
    // as received. It can still be filed away, and now it can go back to Sent.
    expect(names(moveDestinations(trash, all, [mine], ME))).toEqual(["Sent", "Work", "Bills"]);
  });

  it("never offers Sent for mail this account received", () => {
    expect(names(moveDestinations(trash, all, [theirs], ME))).toEqual(["INBOX", "Work", "Bills"]);
  });

  it("lets a sent message filed in a custom folder go back to Sent", () => {
    expect(names(moveDestinations(work, all, [mine], ME))).toEqual(["Sent", "Bills"]);
  });

  it("lets a received message filed in a custom folder go back to Inbox", () => {
    expect(names(moveDestinations(work, all, [theirs], ME))).toEqual(["INBOX", "Bills"]);
  });

  it("offers custom folders only for a mixed selection", () => {
    // Neither Inbox nor Sent is right for all of it, so offer what is right for both.
    expect(names(moveDestinations(trash, all, [mine, theirs], ME))).toEqual(["Work", "Bills"]);
  });

  it("falls back to custom folders when the direction is unknown", () => {
    // No messages passed, or no sender to compare: never open up Inbox or Sent on a
    // guess.
    expect(names(moveDestinations(trash, all, [], ME))).toEqual(["Work", "Bills"]);
    expect(names(moveDestinations(trash, all, [{}], ME))).toEqual(["INBOX", "Work", "Bills"]);
    expect(names(moveDestinations(trash, all, [mine], null))).toEqual(["INBOX", "Work", "Bills"]);
  });

  it("keeps a folder carrying an unrecognised special-use attribute as a destination", () => {
    // Only Drafts/Sent/Junk/Trash are reached by a dedicated button. Anything else the
    // account has — an Archive, or whatever a future server version adds — is a place
    // to file mail, and must not vanish just because the attribute is unfamiliar. It is
    // visible in the sidebar; it has to be reachable here.
    const archive = mb("8", "Archive", "\\Archive");
    expect(names(moveDestinations(inbox, [...all, archive]))).toContain("Archive");
    expect(names(moveDestinations(trash, [...all, archive]))).toContain("Archive");
    // And you still cannot file INTO it from itself.
    expect(names(moveDestinations(archive, [...all, archive]))).not.toContain("Archive");
  });
});

describe("wasSent", () => {
  it("trusts the folder where the folder knows", () => {
    // Mail you addressed to yourself sits in the Inbox with your own address on it.
    // The folder is authoritative there, so it does not read as sent.
    expect(wasSent(mine, inbox, ME)).toBe(false);
    expect(wasSent(mine, junk, ME)).toBe(false);
    // And anything in Sent was sent, whatever address it carries — which is what keeps
    // mail sent from an alias classified correctly for as long as it stays there.
    expect(wasSent(theirs, sent, ME)).toBe(true);
  });

  it("falls back to the sender only where the folder says nothing", () => {
    for (const folder of [trash, work]) {
      expect(wasSent(mine, folder, ME)).toBe(true);
      expect(wasSent(theirs, folder, ME)).toBe(false);
    }
  });

  it("compares addresses case-insensitively and ignores surrounding space", () => {
    expect(wasSent({ from: { address: "  KiKi@Red-Code.DEV " } }, work, ME)).toBe(true);
  });

  it("treats an unknown sender or unknown account address as received", () => {
    // Conservative on purpose: "received" allows Inbox and denies Sent, so a guess
    // never lets something that was not sent into Sent.
    expect(wasSent({}, work, ME)).toBe(false);
    expect(wasSent({ from: null }, work, ME)).toBe(false);
    expect(wasSent(mine, work, null)).toBe(false);
  });
});
