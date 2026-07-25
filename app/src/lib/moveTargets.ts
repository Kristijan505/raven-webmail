import type { Mailbox } from "./types";

// IMAP special-use attributes. Mirrors the predicates in util.ts, restated here so this
// module stays importable on its own — util.ts pulls in icons, $app/navigation and
// @sveltejs/kit, none of which belong in a unit test of folder semantics.
const DRAFTS = "\\Drafts";
const SENT = "\\Sent";
const JUNK = "\\Junk";
const TRASH = "\\Trash";
const INBOX_PATH = "INBOX";

// The four folders that are reached by a dedicated button rather than by filing.
// Everything else the account has is a legitimate place to file mail.
//
// Stated as a denylist on purpose. Selecting destinations by `specialUse == null`
// instead would silently drop any folder carrying an attribute we did not anticipate —
// an Archive, or whatever a future server version introduces — even though it is right
// there in the sidebar and the user can see it. A folder the user can see should be a
// destination unless there is a reason it is not, and "we did not recognise the
// attribute" is not a reason. WildDuck documents specialUse as one of Drafts, Junk,
// Sent or Trash, so today this makes no difference; it is about which way the code
// fails when that stops being true.
const ACTION_FOLDERS = new Set([DRAFTS, SENT, JUNK, TRASH]);

/**
 * The folders it makes sense to move the current selection INTO.
 *
 * Spam and Trash are deliberately never offered. Each already has its own toolbar
 * button — "Mark as spam" and "Delete" — on both the message list and the message page,
 * so listing them here as well only added a second route to the same action. That
 * second route is what allowed mail to be filed somewhere it did not belong.
 *
 * Drafts offers nothing at all. A draft has no home other than Drafts, and getting rid
 * of one is what Delete is for.
 *
 * Inbox is the way back to received mail — but it is NOT offered from Sent. A message
 * you sent does not belong in the Inbox, and offering it there is precisely how a sent
 * mail could be made to look like a received one.
 *
 * TODO(origin): a message carries no record of where it came from, which is why two
 * things are missing. Sent is never a destination, though it should be reachable from a
 * custom folder for mail that WAS sent before being filed; and Trash offers a folder
 * list at all, where a single "Restore" that puts the message back on its own would be
 * right. WildDuck accepts per-message metaData on the same PUT that performs the move,
 * so the marker can be written as part of the move — but a move made outside Raven
 * (IMAP, phone) carries no marker, so the UI has to degrade honestly to "origin
 * unknown" rather than guess.
 */
export const moveDestinations = (
  mailbox: Mailbox | undefined,
  mailboxes: Mailbox[],
): Mailbox[] => {
  if (!mailbox || mailbox.specialUse === DRAFTS) return [];

  const inbox = mailboxes.find(m => m.path === INBOX_PATH);
  // Everything that is not an action folder and not the Inbox — which is listed
  // separately below, and carries no special-use attribute of its own to exclude it by.
  const filable = mailboxes.filter(m => !ACTION_FOLDERS.has(m.specialUse ?? "") && m.id !== inbox?.id);

  const backToInbox = inbox && mailbox.path !== INBOX_PATH && mailbox.specialUse !== SENT
    ? [inbox]
    : [];

  return [...backToInbox, ...filable.filter(m => m.id !== mailbox.id)];
};
