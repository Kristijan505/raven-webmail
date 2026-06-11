import type { LayoutLoad } from "./$types";

export const ssr = false;
export const trailingSlash = "never";

export const load: LayoutLoad = async ({ fetch }) => {
  // Honor a manually chosen language (set by the navbar switcher) via the
  // server's ?accept-language override; otherwise the server falls back to the
  // browser's Accept-Language header. Runs client-side (ssr=false).
  let query = "";
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem("raven.lang");
    if (saved) query = `?accept-language=${encodeURIComponent(saved)}`;
  }
  const response = await fetch(`/api/locale${query}`);
  if (!response.ok) {
    throw new Error(`Cannot get session, invalid response status code: ${response.status}`);
  }

  const { lang, locale } = await response.json();
  return { lang, locale };
};
