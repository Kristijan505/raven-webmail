import type { LayoutLoad } from "./$types";
import { readSavedLang, persistLang } from "$lib/locale";

export const ssr = false;
export const trailingSlash = "never";

export const load: LayoutLoad = async ({ fetch }) => {
  // Honor a manually chosen language (set by the navbar switcher) via the
  // server's ?accept-language override; otherwise the server falls back to the
  // browser's Accept-Language header. Runs client-side (ssr=false).
  let query = "";
  const saved = readSavedLang();
  if (saved) {
    query = `?accept-language=${encodeURIComponent(saved)}`;
    // Re-assert the cookie on every load so users who chose a language before
    // the cookie existed (localStorage only) start tagging their API requests.
    persistLang(saved);
  }
  const response = await fetch(`/api/locale${query}`);
  if (!response.ok) {
    throw new Error(`Cannot get session, invalid response status code: ${response.status}`);
  }

  const { lang, locale } = await response.json();
  return { lang, locale };
};
