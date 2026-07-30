import { writable } from "svelte/store";
import { isDrafts, isInbox, isJunk, isSent } from "./util";
import type { Mailbox } from "./types";

/**
 * Which direction of mail the list is filtered to, or null for both.
 *
 * The filter runs on the server (see the `direction` param on the message-list route):
 * a page of ten stays a page of ten, and the count describes the filtered set. That is
 * the whole reason it is not a local filter over the rows already loaded — those would
 * thin out a page and leave the counter describing something else.
 *
 * Stored under the same `raven.*` key family as the theme and language, and read the
 * same way: any value that is not one of the two directions means "no filter", so a key
 * left over from an older build cannot wedge the list into a filter with no way back.
 */
export type Direction = "in" | "out";

const KEY = "raven.direction";

// Guarded exactly like theme.ts and locale.ts: localStorage access throws a
// SecurityError where storage is disabled or third-party storage is blocked. This runs
// at module import, and the mailbox imports it, so an unguarded read would not cost the
// user their saved filter — it would cost them the whole authenticated UI. The write
// can throw on the same grounds, and on quota.
const stored = (): Direction | null => {
  if (typeof localStorage === "undefined") return null;
  let value: string | null = null;
  try { value = localStorage.getItem(KEY); } catch (_e) { return null; }
  return value === "in" || value === "out" ? value : null;
};

export const direction = writable<Direction | null>(stored());

direction.subscribe(value => {
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch (_e) { /* the filter still applies for this session */ }
});

/** Turn a chip on, or off again when it is already the active one. */
export const toggleDirection = (value: Direction) =>
  direction.update(current => (current === value ? null : value));

/** The query fragment for a listing request. Empty when nothing is filtered. */
export const directionParam = (value: Direction | null): string =>
  value ? `direction=${value}` : "";

/**
 * Whether a folder can hold both directions at once, and so is worth filtering.
 *
 * Inbox and Junk only ever receive, Sent and Drafts only ever originate — offering the
 * chips there would be offering to hide everything or nothing. What is left is Trash,
 * archives and the user's own folders, which is exactly where a message's direction
 * stops being obvious from where it sits.
 */
export const mixesDirections = (mailbox: Mailbox | null | undefined): boolean =>
  // Unified views are single-direction by construction — no chips there.
  !!mailbox && !mailbox.path?.startsWith("__unified") &&
  !isInbox(mailbox) && !isJunk(mailbox) && !isSent(mailbox) && !isDrafts(mailbox);

/** The filter that actually applies in a folder: none at all where the chips are hidden. */
export const activeDirection = (mailbox: Mailbox | null | undefined, value: Direction | null) =>
  mixesDirections(mailbox) ? value : null;
