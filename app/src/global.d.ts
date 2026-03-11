/// <reference types="@sveltejs/kit" />
/// <reference types="unplugin-icons/types/svelte" />

import type { Locale } from "../../server/src/i18n/locale";

interface SessionData {
  lang: string
  locale: Locale
}
