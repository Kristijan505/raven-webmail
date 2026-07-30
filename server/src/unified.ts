/**
 * The pure half of the unified ("all inboxes" / "all sent") views: cursor codec and
 * k-way merge. No Express, no fetching — api.ts owns the fan-out; everything here is
 * pinned by unified.test.ts.
 *
 * A unified page is assembled from one upstream page PER ACCOUNT, merged newest-first
 * by `idate`. The cursor must therefore remember, for every account, where its
 * contribution stopped — and it must do so STATELESSLY, because this server keeps no
 * per-client pagination state and two tabs may walk the same list independently.
 *
 * The trick is `skip`: WildDuck cursors advance only in whole pages, so when a merge
 * consumes half of an account's page, the unified cursor keeps THAT page's cursor and
 * the count already consumed. The next round refetches the same page (bounded, ≤250
 * rows) and slices the consumed prefix off. Only a fully-consumed page advances to the
 * upstream's nextCursor with skip 0. An account with nothing further is carried as
 * `done` so a later round neither refetches it nor mistakes it for a fresh start.
 *
 * Known, accepted drift: rows deleted between rounds shrink the refetched page, so a
 * `skip` can step over rows that moved up; rows arriving prepend and can re-serve a
 * row already shown. Both are the standard cursor+offset trade-off under mutation —
 * the client dedups, exactly as it already does for single-mailbox paging.
 */

export type UnifiedCursorEntry = {
  // Upstream cursor the CURRENT page was fetched with (null = first page)…
  cursor: string | null
  // …and how many of that page's rows earlier unified pages already consumed.
  skip: number
  // Set once the account has nothing further; kept so a later round neither
  // refetches it nor mistakes the missing entry for a fresh start.
  done?: true
}

export type UnifiedCursor = Record<string, UnifiedCursorEntry>

export type UnifiedRow = {
  id: number
  mailbox?: string
  idate?: string
  [key: string]: unknown
}

export type UnifiedRoundInput = {
  /** WildDuck user id of the account this page belongs to. */
  account: string
  /** Shown in the row badge; the switcher name is good enough here. */
  username: string
  /** The raw upstream page, BEFORE the skip is applied. */
  results: UnifiedRow[]
  skip: number
  pageCursor: string | null
  nextCursor: string | false
  total: number
}

export type UnifiedRoundResult = {
  results: Array<UnifiedRow & { account: { id: string; username: string } }>
  cursor: UnifiedCursor
  hasMore: boolean
  total: number
}

const B64: BufferEncoding = "base64url" as BufferEncoding;

export const encodeUnifiedCursor = (cursor: UnifiedCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString(B64);

/**
 * Strict decode of the client-supplied cursor — it is attacker-controlled input that
 * ends up parameterizing upstream fetches. Anything off returns null (route → 400):
 * account keys must be WildDuck ObjectIds, `skip` a bounded integer (a page can never
 * exceed WildDuck's 250-row cap), `cursor` a bounded string or null.
 */
export const decodeUnifiedCursor = (raw: string): UnifiedCursor | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, B64).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: UnifiedCursor = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[0-9a-f]{24}$/i.test(key)) return null;
    const entry = value as { cursor?: unknown; skip?: unknown; done?: unknown };
    if (entry?.done === true) {
      out[key] = { cursor: null, skip: 0, done: true };
      continue;
    }
    const cursor = entry?.cursor ?? null;
    const skip = entry?.skip;
    if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 500)) return null;
    if (!Number.isInteger(skip) || (skip as number) < 0 || (skip as number) > 250) return null;
    out[key] = { cursor: cursor as string | null, skip: skip as number };
  }
  return out;
};

// Newest first by idate; ISO-8601 compares lexicographically. Ties break by account
// id then message id so the order is deterministic — uids are small integers that
// collide across accounts, so id alone can never be the primary key here.
const newer = (
  a: { row: UnifiedRow; account: string },
  b: { row: UnifiedRow; account: string },
): boolean => {
  const ai = a.row.idate ?? "";
  const bi = b.row.idate ?? "";
  if (ai !== bi) return ai > bi;
  if (a.account !== b.account) return a.account < b.account;
  return a.row.id > b.row.id;
};

export const mergeUnifiedRound = (rounds: UnifiedRoundInput[], limit: number): UnifiedRoundResult => {
  const queues = rounds.map(round => ({
    round,
    rows: round.results.slice(round.skip),
    taken: 0,
  }));

  const results: UnifiedRoundResult["results"] = [];
  while (results.length < limit) {
    let best: { queue: typeof queues[number]; row: UnifiedRow } | null = null;
    for (const queue of queues) {
      const row = queue.rows[queue.taken];
      if (!row) continue;
      if (!best || newer({ row, account: queue.round.account }, { row: best.row, account: best.queue.round.account })) {
        best = { queue, row };
      }
    }
    if (!best) break;
    results.push({ ...best.row, account: { id: best.queue.round.account, username: best.queue.round.username } });
    best.queue.taken++;
  }

  const cursor: UnifiedCursor = {};
  let hasMore = false;
  for (const { round, taken } of queues) {
    const consumed = round.skip + taken;
    if (consumed < round.results.length) {
      // Part of this page is still unserved: same page again, larger skip.
      cursor[round.account] = { cursor: round.pageCursor, skip: consumed };
      hasMore = true;
    } else if (round.nextCursor) {
      cursor[round.account] = { cursor: round.nextCursor, skip: 0 };
      hasMore = true;
    } else {
      cursor[round.account] = { cursor: null, skip: 0, done: true };
    }
  }

  return {
    results,
    cursor,
    hasMore,
    total: rounds.reduce((sum, round) => sum + round.total, 0),
  };
};
