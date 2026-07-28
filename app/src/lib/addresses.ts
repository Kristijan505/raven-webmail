import { writable } from "svelte/store";

/**
 * Every address this account sends as — the primary one plus any aliases.
 *
 * "Did I send this?" is asked in two places that must not disagree: the server, when it
 * filters a folder by direction, and the move menu, when it decides whether to offer
 * "back to Inbox" or "back to Sent". Judging by the primary address alone files mail
 * sent from an alias as received, and having each side guess separately is how the list
 * ends up calling a message sent while the menu offers to put it back in the Inbox.
 *
 * Filled from the layout payload, which reads it from WildDuck.
 */
export const addresses = writable<string[]>([]);

/** Case-insensitive membership, which is what address comparison always wants. */
export const isOwnAddress = (
  list: string[] | null | undefined,
  address: string | null | undefined,
): boolean => {
  const needle = address?.trim().toLowerCase();
  if (!needle || !list?.length) return false;
  return list.some(own => own.trim().toLowerCase() === needle);
};
