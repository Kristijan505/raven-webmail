import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params }) => {
  const view = params.view;
  if (view !== "inbox" && view !== "sent") throw error(404, "Not found");

  // The unified endpoints ignore ?account= by design — they always speak for the
  // whole session — so this is a plain fetch rather than the account-stamped helpers.
  const read = async () => {
    const res = await fetch(`/api/unified/${view}/messages?limit=50`);
    const messages = await res.json().catch(() => null);
    if (!res.ok || !messages || messages.error) {
      throw error(res.status || 500, messages?.error?.message || "Cannot load the unified view");
    }
    return messages;
  };

  // `partial` means an account is missing from these rows. The refresh paths keep what
  // is already on screen when that happens, but a FIRST load has nothing to keep: it
  // would render the accounts that answered as if they were the whole view — and if
  // those happen to be empty, as an empty inbox, with the missing account's mail
  // nowhere and nothing to say so. One retry, because most of these are a blink; still
  // partial after that is an error the reader can see and retry, not a quiet lie.
  let messages = await read();
  if (messages.partial) messages = await read();
  if (messages.partial) {
    throw error(502, "Cannot reach every account right now");
  }
  return { view, messages };
};
