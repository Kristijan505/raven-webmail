import { derived, writable } from "svelte/store";

/**
 * Client half of the unified ("all inboxes" / "all sent") views.
 *
 * The layout ships every account's INBOX and Sent PER MAILBOX (id + counters), not
 * summed — COUNTERS events arrive per mailbox, so keeping the badges live means
 * updating exactly the entry an event names and letting the sums derive.
 */
export type UnifiedInboxEntry = { id: string; unseen: number; total: number };
export type UnifiedSentEntry = { id: string; total: number };
export type UnifiedInfo = { inbox: UnifiedInboxEntry[]; sent: UnifiedSentEntry[] } | null;

export const unifiedInfo = writable<UnifiedInfo>(null);

export const unifiedUnseen = derived(unifiedInfo, info =>
  info ? info.inbox.reduce((sum, b) => sum + b.unseen, 0) : 0);

/** The id sets the list uses to reconcile SSE events in a unified view. */
export const inboxIds = derived(unifiedInfo, info => new Set(info?.inbox.map(b => b.id) ?? []));
export const sentIds = derived(unifiedInfo, info => new Set(info?.sent.map(b => b.id) ?? []));

export const applyCounters = (event: { mailbox: string; unseen?: number; total?: number }): void => {
  unifiedInfo.update(info => {
    if (!info) return info;
    let changed = false;
    const inbox = info.inbox.map(b => {
      if (b.id !== event.mailbox) return b;
      changed = true;
      return { ...b, unseen: event.unseen ?? b.unseen, total: event.total ?? b.total };
    });
    const sent = info.sent.map(b => {
      if (b.id !== event.mailbox) return b;
      changed = true;
      return { ...b, total: event.total ?? b.total };
    });
    return changed ? { inbox, sent } : info;
  });
};

/**
 * The synthetic mailboxes behind the unified pages, recognised by ID.
 *
 * Their id is minted by this client (`unified-inbox` / `unified-sent`); every real
 * mailbox id is a 24-character WildDuck ObjectId, so the two can never collide. The
 * path was the wrong key: paths are user-controlled — the create-folder route takes
 * whatever the user types — so a folder literally named `__unified/sent` would have
 * been treated as the synthetic one, losing its direction chips, move menu and
 * clear-folder and showing recipients instead of senders.
 */
export const UNIFIED_IDS = { inbox: "unified-inbox", sent: "unified-sent" } as const;

export const isUnifiedMailbox = (m: { id?: string } | null | undefined): boolean =>
  m?.id === UNIFIED_IDS.inbox || m?.id === UNIFIED_IDS.sent;

/** The synthetic "all sent" mailbox specifically — it has no \Sent specialUse. */
export const isUnifiedSent = (m: { id?: string } | null | undefined): boolean =>
  m?.id === UNIFIED_IDS.sent;

/**
 * Live message total per unified view, summed from the same per-mailbox counters the
 * badges use. The synthetic mailbox's own `total` is a snapshot taken when the page
 * loaded: it survives load-more, new mail and an EXPUNGE of a row that was never on
 * screen, all of which move the real figure. These entries are updated by every
 * COUNTERS event (applyCounters), so the sum stays honest without a refetch.
 */
export const unifiedTotals = derived(unifiedInfo, info => ({
  [UNIFIED_IDS.inbox]: info ? info.inbox.reduce((sum, b) => sum + b.total, 0) : null,
  [UNIFIED_IDS.sent]: info ? info.sent.reduce((sum, b) => sum + b.total, 0) : null,
} as Record<string, number | null>));

/**
 * Newest first, ties broken by account then id — the same order server/src/unified.ts
 * merges in.
 *
 * Applied when a unified page is APPENDED, because the server cannot always keep the
 * promise on its own: when one account's upstream fails mid-walk its cursor is carried
 * and the page is served from the accounts that answered, so a row that outranks what
 * was just shown can arrive a round late. Re-sorting on append puts it where it
 * belongs instead of leaving it stranded at the bottom of the list. A page the server
 * merged correctly is already in this order, so this is a no-op for it.
 */
export const sortUnified = <T extends { id: number; idate?: string | null; account?: { id: string } }>(
  rows: T[],
): T[] =>
  [...rows].sort((a, b) => {
    const ai = a.idate ?? "", bi = b.idate ?? "";
    if (ai !== bi) return ai < bi ? 1 : -1;
    const aa = a.account?.id ?? "", ba = b.account?.id ?? "";
    if (aa !== ba) return aa < ba ? -1 : 1;
    return b.id - a.id;
  });

export const unifiedListBase = (view: "inbox" | "sent"): string => `/api/unified/${view}/messages`;
