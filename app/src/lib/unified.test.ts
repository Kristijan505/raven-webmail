import { describe, expect, it } from "vitest";
import { sortUnified } from "./unified";

const A = "615c1f2e4a3b9c0d7e8f1a2b";
const B = "715c1f2e4a3b9c0d7e8f1a2b";
const row = (id: number, idate: string | null, account: string) => ({ id, idate, account: { id: account } });
const ids = (rows: ReturnType<typeof row>[]) => rows.map(r => `${r.account.id.slice(0, 4)}:${r.id}`);

describe("sortUnified", () => {
  it("puts a late-arriving newer row where it belongs", () => {
    // The failure this exists for: account A's page was unavailable, so the first
    // unified page came from B alone; A's 11:00 arrives a round later and must not be
    // stranded under B's 10:00 just because it was fetched second.
    const shown = [row(9, "2026-07-30T10:00:00Z", B)];
    const appended = [row(2, "2026-07-30T11:00:00Z", A)];
    expect(ids(sortUnified([...shown, ...appended]))).toEqual(["615c:2", "715c:9"]);
  });

  it("leaves a correctly merged page untouched", () => {
    const page = [
      row(2, "2026-07-30T12:00:00Z", A),
      row(9, "2026-07-30T11:00:00Z", B),
      row(1, "2026-07-30T10:00:00Z", A),
    ];
    expect(ids(sortUnified(page))).toEqual(ids(page));
  });

  it("breaks ties exactly as the server merge does — account, then id descending", () => {
    // server/src/unified.ts `newer`: equal idate -> lower account id first, then the
    // higher message id. Diverging here would make rows jump on every append.
    const at = "2026-07-30T09:00:00Z";
    const rows = [row(4, at, B), row(1, at, A), row(7, at, B), row(3, at, A)];
    expect(ids(sortUnified(rows))).toEqual(["615c:3", "615c:1", "715c:7", "715c:4"]);
  });

  it("sorts a missing idate last instead of throwing", () => {
    const rows = [row(1, null, A), row(2, "2026-07-30T09:00:00Z", B)];
    expect(ids(sortUnified(rows))).toEqual(["715c:2", "615c:1"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [row(1, "2026-07-30T09:00:00Z", A), row(2, "2026-07-30T11:00:00Z", B)];
    const before = ids(rows);
    sortUnified(rows);
    expect(ids(rows)).toEqual(before);
  });
});
