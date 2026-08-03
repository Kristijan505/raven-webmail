import { RequestHandler } from "express";
import { Authentication, SessionAccount } from "./client";
import { Config } from "./config";
import { Locales } from "./i18n/i18n";

declare module "express-session" {
  interface SessionData {
    // Legacy single-account field, now a MIRROR of the first usable entry in
    // `accounts`. Kept written so a rollback to a pre-multi-account build still
    // finds a working session instead of logging everyone out.
    authentication?: Authentication | null
    // Every account signed into this browser session. Read through accountsOf()
    // (session.ts), which shims sessions created before this field existed.
    accounts?: SessionAccount[] | null
    // Rate-limit identity for this BROWSER, carried across session rotation.
    // See throttleKey() in session.ts for why the session id could not be it.
    throttleKey?: string
  }
}

export type Kit = {
  assetsMiddleware: RequestHandler,
  kitMiddleware: RequestHandler,
  prerenderedMiddleware: RequestHandler
}

declare global {
  const __RAVEN__: { config: Config }
  const __RAVEN_IMPORT_SVELTEKIT__: () => Promise<Kit>
}