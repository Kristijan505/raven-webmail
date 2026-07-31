import { get as getStore, writable } from "svelte/store";

export type AccountEntry = { id: string; username: string; needsReauth: boolean };

/** Accounts signed into the SESSION, from the layout payload. */
export const accounts = writable<AccountEntry[]>([]);

/**
 * Which account owns which mailbox, from the layout payload. Only populated once a
 * second account exists — with one account there is nothing to disambiguate. Lets a
 * deep link into another account's folder switch the tab rather than render that
 * folder under the wrong sidebar.
 */
export const mailboxAccounts = writable<Record<string, string>>({});

/**
 * The account THIS TAB is looking at.
 *
 * Deliberately tab state, not session state: requests carry it explicitly
 * (?account=), so two tabs can sit on two accounts at once without fighting over a
 * server-side "active" pointer — mailbox-scoped requests are account-agnostic anyway
 * (the path mailbox binds harder on the server). sessionStorage keeps the choice per
 * tab; localStorage seeds new tabs with the last choice. Both guarded like theme.ts:
 * storage access can throw where it is disabled, and this runs at module import.
 */
const TAB_KEY = "raven.tabAccount";
const SEED_KEY = "raven.lastAccount";

const stored = (): string | null => {
  if (typeof sessionStorage === "undefined") return null;
  try { return sessionStorage.getItem(TAB_KEY) ?? localStorage.getItem(SEED_KEY); } catch { return null; }
};

export const tabAccount = writable<string | null>(stored());

export const setTabAccount = (id: string | null): void => {
  tabAccount.set(id);
  try {
    if (id) {
      sessionStorage.setItem(TAB_KEY, id);
      localStorage.setItem(SEED_KEY, id);
    } else {
      sessionStorage.removeItem(TAB_KEY);
      // The seed goes as well: leaving it lets the next tab revive an account this
      // one has just signed out of or been evicted from.
      localStorage.removeItem(SEED_KEY);
    }
  } catch { /* the choice still holds for this tab's lifetime */ }
};

/**
 * Append ?account= to an /api request so the server knows which account this tab
 * speaks for. A URL that already names an account wins, mailbox-scoped routes ignore
 * it (their path mailbox binds harder), and non-API URLs pass through untouched.
 */
export const withAccount = (url: string): string => {
  const id = getStore(tabAccount);
  if (!id || !url.startsWith("/api/") || /[?&]account=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "account=" + encodeURIComponent(id);
};

/**
 * One value naming the SET of signed-in accounts, for the inter-tab auth broadcast.
 * Switching the active account must not bounce other tabs (the set is unchanged),
 * while login/logout/eviction changes the set and resyncs them.
 */
export const accountsSignature = (list: AccountEntry[]): string =>
  // needsReauth is part of the signature: an account being stubbed elsewhere changes
  // what this browser can do, so other tabs have to resync — an id-only signature
  // would call the set unchanged and leave them showing a live account that is not.
  list.map(a => `${a.id}${a.needsReauth ? "!" : ""}`).sort().join(",");
