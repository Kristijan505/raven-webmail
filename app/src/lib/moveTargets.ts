import { isOwnAddress } from "./addresses";
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

/** Just enough of a message to tell which way it travelled. */
export type Directional = { from?: { address?: string } | null };

/**
 * Was this message sent by the account, or received by it?
 *
 * Decided when the menu opens, not recorded when the message moves — which is what
 * makes it work for a message that is already sitting in a custom folder or in Trash,
 * the case where nothing about the folder gives it away.
 *
 * The folder is consulted first wherever it is authoritative: anything in Sent was
 * sent, anything in Inbox or Spam was received, and no comparison can override that.
 * Only in the folders that carry no such meaning — custom ones and Trash — does the
 * sender address decide.
 *
 * Two things it cannot get right, both bounded:
 *  - An alias. Only the account's primary address is known here (WildDuck can hold
 *    several, but nothing exposes them to the client), so mail sent FROM an alias and
 *    since filed away reads as received. It then behaves exactly as it does today —
 *    Inbox offered, Sent not — so nothing regresses; it simply is not improved.
 *  - Mail you addressed to yourself, once moved out of the Inbox. It reads as sent,
 *    so Inbox stops being offered for it.
 * In both cases the answer is conservative: the message can still be filed into a
 * custom folder, and Sent is never opened up to something that was not sent.
 */
export const wasSent = (
  message: Directional,
  mailbox: Mailbox,
  accountAddresses: string[] | null | undefined,
): boolean => {
  if (mailbox.specialUse === SENT) return true;
  if (mailbox.specialUse === JUNK || mailbox.path === INBOX_PATH) return false;

  // Known and accepted: From is written by the sender, so a message forged with the
  // account's own address reads as sent once it leaves Inbox/Junk, and the menu then
  // offers Sent for it. The folder checks above are what keep that harmless where it
  // would matter — freshly delivered mail is classified by the mailbox it landed in,
  // never by this comparison — so reaching here at all takes the user deliberately
  // filing the message elsewhere first, and the worst outcome is a foreign message
  // sitting in Sent because they then chose to put it there. Nothing reads Sent as a
  // security boundary. The alternatives were measured and cost more than they buy:
  // `outbound` is the trustworthy signal but exists only on the full message, so the
  // list would need one upstream fetch per row; verifying it server-side on the move
  // instead would reject legitimate restores for every imported or migrated message,
  // which have no `outbound` at all; and a marker written at send time cannot say
  // anything about mail that predates it, which is the case this rule exists to cover.
  return isOwnAddress(accountAddresses, message?.from?.address);
};

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
  messages: Directional[] = [],
  accountAddresses: string[] | null | undefined = [],
): Mailbox[] => {
  if (!mailbox || mailbox.specialUse === DRAFTS) return [];

  const inbox = mailboxes.find(m => m.path === INBOX_PATH);
  const sent = mailboxes.find(m => m.specialUse === SENT);
  // Everything that is not an action folder and not the Inbox — which is listed
  // separately below, and carries no special-use attribute of its own to exclude it by.
  const filable = mailboxes.filter(m => !ACTION_FOLDERS.has(m.specialUse ?? "") && m.id !== inbox?.id);

  // Which way the selected mail travelled. A mixed selection satisfies neither test, so
  // it gets custom folders only — the intersection of what is allowed for each half,
  // rather than a menu that is wrong for some of what is selected.
  const directions = messages.map(m => wasSent(m, mailbox, accountAddresses));
  const allSent = directions.length > 0 && directions.every(Boolean);
  const allReceived = directions.length > 0 && !directions.some(Boolean);

  // Inbox is for mail that arrived. Offering it for something you sent is how a sent
  // message could be made to look received — the whole reason this takes direction into
  // account instead of just the current folder.
  const backToInbox = inbox && mailbox.path !== INBOX_PATH && allReceived ? [inbox] : [];
  // And Sent stays truthful: it opens up only for mail this account actually sent,
  // which is what makes a sent message recoverable from Trash or from a custom folder.
  const backToSent = sent && mailbox.specialUse !== SENT && allSent ? [sent] : [];

  return [...backToInbox, ...backToSent, ...filable.filter(m => m.id !== mailbox.id)];
};
