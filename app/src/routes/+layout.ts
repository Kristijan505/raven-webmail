import type { LayoutLoad } from "./$types";

export const ssr = false;
export const trailingSlash = "never";

export const load: LayoutLoad = async ({ fetch }) => {
  const response = await fetch("/api/locale");
  if (!response.ok) {
    throw new Error(`Cannot get session, invalid response status code: ${response.status}`);
  }

  const { lang, locale } = await response.json();
  return { lang, locale };
};
