import { writable } from "svelte/store";
import type { Locale } from "../../../server/src/i18n/locale";

export const lang = writable("en");
export const locale = writable<Locale>({} as Locale);
