import { get } from "svelte/store";
import { invalidateAll } from "$app/navigation";
import { setTabAccount, tabAccount } from "$lib/account";
import { flushDrafts } from "$lib/Compose/compose";
import { intertab } from "$lib/intertab";

/**
 * Handing this tab over to another account, without dropping what is being written.
 *
 * Everything here replaces the document, and replacing the document destroys the global
 * composer: Dashboard's teardown unmounts it, and the compose window's own save is fire
 * and forget — nobody waits for it, nobody hears it fail, and by then the component
 * holding the text is gone. Autosave is debounced by 1.5s, so anything typed in the last
 * second and a half is what is at stake. Every path through here flushes first.
 *
 * These lived as four identical copies in the route guards plus one in util.ts. A review
 * found the missing flush in one of the four, which is the argument for one copy.
 */

/**
 * Point this tab at the account that owns what is on screen, then rebuild.
 *
 * A full document load is the clean way to come back as the owner — the layout, sidebar
 * and every cache on screen belong to the previous account, and the (app) layout's load
 * declares no dependency on the route, so what a client-side navigation rebuilds is not
 * something to rely on. But it is only taken when nothing unsaved would go with it: a
 * flush that failed, or a pin that could not be stored, falls back to invalidating in
 * place. That corrects the same data and keeps the writing on screen.
 *
 * The pin is set either way. Unlike the account switcher, this is not a request to go
 * somewhere — the page ALREADY belongs to the other account, and leaving the tab
 * stamping requests for the previous one is what the guard exists to stop.
 */
let handingOver = false;
export const repinTab = async (id: string): Promise<void> => {
  // The guard fires from a reactive statement, so it can run again while the flush is
  // still in flight. Once is enough; twice means two flushes racing one reload.
  if (handingOver) return;
  handingOver = true;
  try {
    const flushed = await flushDrafts();
    const persisted = setTabAccount(id);
    if (flushed && persisted) location.reload();
    else void invalidateAll();
  } finally {
    handingOver = false;
  }
};

/** Is this tab's pinned account still in the signature another tab just published? */
const stillSignedIn = (signature: string, pinned: string | null): boolean =>
  !pinned || signature.split(",").some(entry => entry.replace(/!$/, "") === pinned);

/**
 * Resync this tab when the set of signed-in accounts changes in another one.
 *
 * Dropping the pin first is the part that matters. It is stamped onto every request as
 * ?account=, and when it names an account that was just signed out elsewhere the tab
 * cannot heal itself: the layout route is lenient and answers 200 as some other
 * account, but the mailbox page under it 404s, and that error renders ABOVE the (app)
 * layout — so the component whose job is to re-pin the tab to whoever answered never
 * mounts. The tab sits on an error screen, still holding a dead account id, through
 * any number of reloads. Only a pin that is genuinely gone is cleared: a tab
 * deliberately looking at one mailbox must not be dragged to another because a third
 * account was added in some other tab.
 *
 * The reload itself is a full document load rather than goto() for the reason above.
 * The flush before it is best-effort, and deliberately so: unlike a switch the user
 * asked for, this tab cannot decline. The account set HAS changed, the pin may name
 * something that no longer exists, and staying put to protect a draft would leave the
 * tab broken and still not save it. So wait for the saves, then resync regardless —
 * waiting is what turns an aborted save into a completed one in the common case.
 */
export const watchAuth = (userId: string | null) => {
  const watcher = intertab<string | null>("intertab.auth.watch");
  watcher.set(userId);
  const unwatch = watcher.watch(value => {
    if (value === userId) return;
    void (async () => {
      await flushDrafts();
      if (value == null) {
        setTabAccount(null);
        location.assign("/login");
        return;
      }
      if (!stillSignedIn(value, get(tabAccount))) setTabAccount(null);
      location.assign("/");
    })();
  });
  return unwatch;
};
