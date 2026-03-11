import { getPage } from "$lib/util";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, url }) => {
  return getPage({ fetch, url });
};
