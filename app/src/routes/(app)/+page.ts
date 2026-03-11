import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ parent }) => {
  const { mailboxes } = await parent();
  const inbox = mailboxes?.[0];
  if (inbox) {
    throw redirect(302, `/mailbox/${inbox.id}`);
  }

  return {};
};
