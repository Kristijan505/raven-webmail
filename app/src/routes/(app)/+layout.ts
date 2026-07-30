import { getPage } from "$lib/util";
import { setTabAccount } from "$lib/account";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ fetch }) => {
  try {
    return await getPage({ fetch, path: "/api/pages/layout" });
  } catch (e) {
    // A tab pointing at an account this session no longer holds (signed out or
    // evicted elsewhere) must fall back to whatever the session still has, not
    // dead-end the whole app on a 403.
    if ((e as { status?: number })?.status === 403) {
      setTabAccount(null);
      return await getPage({ fetch, path: "/api/pages/layout" });
    }
    throw e;
  }
};
