import type { Options, Store, ClientRateLimitInfo } from "express-rate-limit";
import { sharedCollection } from "./session";
import { logger } from "./logger";

const COLLECTION = "rate-limits";

/**
 * The update behind one hit, built pure so the window arithmetic is pinned by tests.
 *
 * A pipeline rather than `$inc`, because a counter and its window have to move together:
 * read-then-write lets two requests both see an expired window and both start a fresh
 * one, and `$inc` alone would keep counting into a window that ended hours ago. The
 * condition is evaluated by Mongo against the stored document, so the decision "same
 * window or a new one" happens exactly once per hit.
 *
 * On an upsert `$expiresAt` is missing, `$gt` against it is false, and the document is
 * born with one hit and a fresh window — which is what a first hit is.
 */
export const hitUpdate = (now: Date, windowMs: number) => [
  {
    $set: {
      hits: { $cond: [{ $gt: ["$expiresAt", now] }, { $add: [{ $ifNull: ["$hits", 0] }, 1] }, 1] },
      expiresAt: {
        $cond: [{ $gt: ["$expiresAt", now] }, "$expiresAt", new Date(now.getTime() + windowMs)],
      },
    },
  },
];

/**
 * ═══ A rate-limit store every instance shares. ═══
 *
 * express-rate-limit's default store counts in process memory, so N instances hand out N
 * times the budget — N times the password guesses, N times the sends. Sessions already
 * live in Mongo, so this adds no dependency and no new failure mode: an instance that
 * cannot reach Mongo cannot serve a session either.
 *
 * A FAILED QUERY is not caught. A limiter that answers "sure, go ahead" when its store
 * is unreachable is one an attacker can remove by making the store unreachable, so the
 * rejection propagates and express-rate-limit fails the request — the same thing that
 * happens to every other request on an instance whose database is gone.
 *
 * There is exactly one permissive case, and it is not that one: this is constructed at
 * module scope and the session store may not exist yet, so until it does there is no
 * collection to ask and a hit counts as the first. That is a cold-start window measured
 * in milliseconds, it is logged once per limiter, and the alternative — refusing every
 * request before the process can serve anything — is worse.
 */
export class SharedRateLimitStore implements Store {
  // Tells express-rate-limit's double-count check that keys here are NOT process-local.
  localKeys = false;
  prefix: string;
  private windowMs = 0;
  private indexed: Promise<void> | null = null;
  private warned = false;

  constructor(name: string) {
    this.prefix = `${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private collection(): any | null {
    const col = sharedCollection(COLLECTION);
    if (!col) {
      if (!this.warned) {
        this.warned = true;
        logger.warn({ limiter: this.prefix }, "rate limit store not ready; this instance is counting nothing yet");
      }
      return null;
    }
    // Expiry is Mongo's job, once per process. A failure here is not fatal — the window
    // logic does not depend on the sweep, only the collection's size does.
    if (!this.indexed) {
      this.indexed = col
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
        .then(() => undefined)
        .catch((e: any) => {
          this.indexed = null;
          logger.warn({ detail: String(e?.message) }, "could not create the rate-limit TTL index");
        });
    }
    return col;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const col = this.collection();
    const now = new Date();
    if (!col) return { totalHits: 1, resetTime: new Date(now.getTime() + this.windowMs) };
    const doc = await col.findOneAndUpdate(
      { _id: this.prefix + key },
      hitUpdate(now, this.windowMs),
      { upsert: true, returnDocument: "after" },
    );
    // Driver versions differ on whether the document comes back wrapped in `value`.
    const after = (doc && typeof doc === "object" && "value" in doc) ? (doc as any).value : doc;
    return {
      totalHits: Number(after?.hits) || 1,
      resetTime: after?.expiresAt instanceof Date ? after.expiresAt : new Date(now.getTime() + this.windowMs),
    };
  }

  async decrement(key: string): Promise<void> {
    const col = this.collection();
    if (!col) return;
    // Only within the live window: giving a hit back to a window that has already rolled
    // over would push the new one below zero.
    await col.updateOne(
      { _id: this.prefix + key, expiresAt: { $gt: new Date() } },
      { $inc: { hits: -1 } },
    );
  }

  async resetKey(key: string): Promise<void> {
    const col = this.collection();
    if (!col) return;
    await col.deleteOne({ _id: this.prefix + key });
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const col = this.collection();
    if (!col) return undefined;
    const doc = await col.findOne({ _id: this.prefix + key });
    if (!doc || !(doc.expiresAt instanceof Date) || doc.expiresAt <= new Date()) return undefined;
    return { totalHits: Number(doc.hits) || 0, resetTime: doc.expiresAt };
  }
}
