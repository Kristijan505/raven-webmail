import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params }) => {
  const view = params.view;
  if (view !== "inbox" && view !== "sent") throw error(404, "Not found");

  // The unified endpoints ignore ?account= by design — they always speak for the
  // whole session — so this is a plain fetch rather than the account-stamped helpers.
  const res = await fetch(`/api/unified/${view}/messages?limit=50`);
  const messages = await res.json().catch(() => null);
  if (!res.ok || !messages || messages.error) {
    throw error(res.status || 500, messages?.error?.message || "Cannot load the unified view");
  }
  return { view, messages };
};
