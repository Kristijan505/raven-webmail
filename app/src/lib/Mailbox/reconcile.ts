import type { Message } from "../types";

/**
 * Drop repeats of the same message id, keeping the first occurrence.
 * The list is rendered by a keyed `{#each}`, and Svelte throws on a duplicate
 * key (in production too), so a repeat would take the whole mailbox down.
 */
export const dedupById = (messages: Message[]): Message[] => {
  const seen = new Set<number>();
  const out: Message[] = [];
  for (const item of messages) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
};

/**
 * Merge a freshly refetched FIRST page into the list we currently hold.
 *
 * Messages are ordered newest-id-first, so the fresh page is authoritative for
 * everything from its highest id down to its lowest — anything we still hold in
 * that window but the server no longer returns has been deleted and must go.
 *
 * `hasOlderPages` (the server's next cursor) decides what happens BELOW that
 * window. When there are no further pages the fresh page IS the entire mailbox,
 * so rows below its lowest id are stale as well. That case is the whole point
 * here: compose autosaves a draft by creating a brand-new message and deleting
 * the previous one, so an orphaned draft always ends up with a LOWER id than the
 * save that replaced it. It therefore never falls inside the fresh id window,
 * and a reconciliation that only trusted that window could never drop it — the
 * phantom just sat in the list until a manual reload.
 *
 * An empty fresh page is ambiguous on its own — it is what a genuinely emptied mailbox
 * looks like AND what a transient blank response looks like. Trusting it blindly lets
 * one blip wipe a mailbox the user has scrolled through; never trusting it strands
 * ghost rows when the mailbox really did empty and the EXPUNGE events were missed
 * (another client, or an SSE reconnect). `serverTotal` — the count the server reports
 * alongside the page — breaks the tie. When it is not supplied the cautious branch is
 * taken and the current list is kept.
 */
export const reconcileFirstPage = (
  current: Message[],
  fresh: Message[],
  hasOlderPages: boolean,
  serverTotal?: number,
): Message[] => {
  if (!fresh.length) {
    return serverTotal === 0 ? [] : dedupById(current);
  }
  const minFreshId = Math.min(...fresh.map(m => m.id));
  const older = hasOlderPages ? current.filter(m => m.id < minFreshId) : [];
  return dedupById([...fresh, ...older]);
};
