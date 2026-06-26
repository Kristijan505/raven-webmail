import { writable } from "svelte/store";

export type Theme = "light" | "dark" | "auto";

const KEY = "raven.theme";

const initial = (): Theme => {
  if (typeof localStorage === "undefined") return "auto";
  // localStorage access can throw (SecurityError when storage is disabled or
  // third-party storage is blocked); this runs at module import, so guard it or
  // the whole app fails to render.
  let v: string | null = null;
  try { v = localStorage.getItem(KEY); } catch (_e) { return "auto"; }
  return v === "light" || v === "dark" || v === "auto" ? v : "auto";
};

export const theme = writable<Theme>(initial());

// Persist the choice and apply it to <html data-theme> so the CSS variables in
// global.css switch. The inline script in app.html applies the saved value
// before first paint (no flash); this keeps it in sync at runtime.
export const setTheme = (t: Theme) => {
  theme.set(t);
  try { localStorage.setItem(KEY, t); } catch (_e) { /* ignore */ }
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", t);
  }
};
