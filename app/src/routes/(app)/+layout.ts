import { getPage } from "$lib/util";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ fetch }) => {
  return getPage({ fetch, path: "/api/pages/layout" });
};
