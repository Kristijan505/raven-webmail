import type { Message } from "../types";

/**
 * Drop repeats, keeping the first occurrence — the list is a keyed `{#each}`, and
 * Svelte throws on a duplicate key (in production too), so a repeat would take the
 * whole mailbox down.
 *
 * The one key that survives several accounts in one list: uids are small per-mailbox
 * integers and COLLIDE across accounts, so `id` alone must never key a row. In a
 * single-mailbox list the mailbox half is constant and this degenerates to the id.
 */
export const rowKey = (m: Pick<Message, "id" | "mailbox">): string => `${m.mailbox}:${m.id}`;

export const dedupById = (messages: Message[]): Message[] => {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const item of messages) {
    const key = rowKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
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
 *
 * That only works because WildDuck's `total` counts the whole MAILBOX, not the page:
 * `total = await getFilteredMessageCount(filter)` in its messages handler. If it were
 * page-scoped it would read 0 for any empty page and this would clear the list on
 * exactly the transient blip the branch above exists to survive.
 */
export type Page = { results: Message[]; nextCursor: string | false; total?: number };

export const reconcileFirstPage = (
  current: Page,
  fresh: Page,
): { results: Message[]; nextCursor: string | false } => {
  if (!fresh.results.length) {
    return fresh.total === 0
      ? { results: [], nextCursor: false }
      : { results: dedupById(current.results), nextCursor: current.nextCursor };
  }

  const minFreshId = Math.min(...fresh.results.map(m => m.id));
  const older = fresh.nextCursor ? current.results.filter(m => m.id < minFreshId) : [];
  const results = dedupById([...fresh.results, ...older]);

  // Does the fresh page reach back into rows we already hold? Only then do the two
  // halves of the list actually meet, and only then does keeping the old cursor make
  // sense — see below.
  const continuous = current.results.some(m => m.id >= minFreshId);

  // The cursor has to continue after the LAST row we hold, and the results and the
  // cursor therefore have to be decided together — which is why they are returned
  // together rather than left to the caller to pair up.
  //
  // When already-paginated rows are kept, the fresh page's cursor points only past page
  // one, so adopting it makes "load more" refetch pages that are already on screen: the
  // user clicks, dedup drops everything that comes back, and nothing appears to happen.
  // The cursor we already had still points past the last page loaded, so it stays.
  // Only when nothing older was retained does the fresh page describe the whole list,
  // and its cursor becomes the right one.
  //
  // All of which assumes the fresh page and the retained rows are one continuous run.
  // They are not when more than a page arrived while we were not listening — an SSE
  // drop, a backgrounded tab — because then the fresh page stops above everything we
  // hold and the messages in between were never fetched by anyone. Keeping the old
  // cursor there strands them for good: it points below the retained rows, so no amount
  // of "load more" ever walks through the gap. The fresh cursor is the one that does,
  // and dedup absorbs the retained rows when paging reaches them again.
  return { results, nextCursor: older.length && continuous ? current.nextCursor : fresh.nextCursor };
};
