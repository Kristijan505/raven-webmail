import { writable } from "svelte/store";
import type { Locale } from "../../../server/src/i18n/locale";

export const lang = writable("en");
export const locale = writable<Locale>({} as Locale);

export const LANG_KEY = "raven.lang";

// Persist the chosen language in BOTH localStorage and a cookie. localStorage
// drives the client (read by +layout.ts on load to request the right locale);
// the cookie mirrors it so the browser attaches the choice to every API request,
// letting the server render error messages (429, session-expired, bad-gateway…)
// in the user's language instead of the browser's Accept-Language. SameSite=Lax,
// 1-year, non-secret value.
export const persistLang = (code: string): void => {
  try { localStorage.setItem(LANG_KEY, code); } catch (_e) { /* ignore */ }
  try {
    document.cookie = `${LANG_KEY}=${encodeURIComponent(code)}; path=/; max-age=31536000; SameSite=Lax`;
  } catch (_e) { /* ignore */ }
};

export const readSavedLang = (): string | null => {
  if (typeof localStorage === "undefined") return null;
  try { return localStorage.getItem(LANG_KEY); } catch (_e) { return null; }
};
