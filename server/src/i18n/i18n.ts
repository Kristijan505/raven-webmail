import { NextFunction, Request, Response, Router } from "express";
import { Config } from "../config";
import type { Locale } from "./locale";

import { parse } from "accept-language-parser"

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export type Locales = Record<string, Locale>;

// import { get } from "object-path";

import en from "./src/en";
import es from "./src/es";
import it from "./src/it";
import hr from "./src/hr";
import pc from "picocolors";

declare module "express" {
  interface Request {
    lang?: string
    locale?: Locale
  }
}

const clone = <T>(src: T): T => {
  if(src instanceof Array) {
    // @ts-ignore
    return src.map(clone);
  } 

  if(typeof src == "object" && src !== null) {
    // @ts-ignore
    const target: T = Object.create(null);
    for(const [key, value] of Object.entries(src)) {
      // @ts-ignore
      target[key] = clone(value);
    }
    return target;
  }

  return src;
}

const deepkeys = (src: any): string[] => {
  
  const keys: string[] = [];

  const add = (src: any, path: string[] = []) => {
    if(typeof src === "string") keys.push(path.join("."))
    else {
      for(const [key, value] of Object.entries(src)) {
        add(value, [...path, key]);
      }
    }
  }

  add(src);

  return keys;
}

const baseKeys = deepkeys(en);

const normalize = (code: string, src: Record<string, any>): Locale => {
  const keys = deepkeys(src);
  for(const key of keys) {
    if(!baseKeys.includes(key)) {
      console.warn(`> [WARN] Locale ${pc.yellow(code)} unknown key ${pc.yellow(key)} ignoring`)
    }
  }

  const merge = <T>(src: any, base: T, path: string[]): T  => {

    if(typeof base === "string") {
      if(typeof src === "string") {
        // @ts-ignore
        return src;
      } else {
        console.warn(`> [WARN] Locale ${pc.yellow(code)} key ${pc.yellow(path.join("."))} is not a string, setting it to default`)
        return base;
      }
    }

    if(typeof base === "object") {
      if(typeof src !== "object" || src === null) {
        console.warn(`> [WARN] Locale ${pc.yellow(code)} key ${pc.yellow(path.join("."))} is not an object, setting it to default`)
        return clone(base);
      }
    }

    if(base instanceof Array) {
      // @ts-ignore
      const target: T = [];
      for(let i = 0; i < base.length; i++) {
        // @ts-ignore
        target[i] = merge(src[i], base[i], [...path, String(i)])
      }
      return target;

    } else {
      const target: T = Object.create(null);
      // @ts-ignore
      for(const [key, value] of Object.entries(base)) {
        // @ts-ignore
        target[key] = merge(src[key], value, [...path, key])
      }

      return target;
    }
  }

  return merge(src, en, []);
}

export const loadLocales = (config: Config): Locales => {
  
  if(!config.extra_locales_dirs?.length) {
    return { en, es, it, hr };
  }

  const locales: Locales = Object.create(null);
  
  try {
    for(const dir of config.extra_locales_dirs) {
      const names = readdirSync(dir);
      for(const name of names) {
        if(!/\.json$/i.test(name)) continue;
        const code = name.replace(/\.json$/i, "");
        if(locales[code]) continue;
        const filepath = join(dir, name);
        console.log(`> loading locale ${pc.yellow(code)} from ${pc.yellow(filepath)}`)
        const source = readFileSync(filepath, "utf-8");
        const locale = JSON.parse(source);
        if(typeof locale !== "object" || locale == null) {
          throw new Error("Locale JSON is not an object");
        }

        locales[code] = normalize(code, locale);
      }
    }
  } catch(e: any) {
    console.warn(pc.red(`Error loading custom locales: ${e.message}`))
    console.error(e);
    process.exit(1);
  }

  if(locales.en == null) {
    console.log(`> adding locale ${pc.yellow("en")} from source`);
    locales.en = en;
  }

  if(locales.es == null) {
    console.log(`> adding locale ${pc.yellow("es")} from source`);
    locales.es = es;
  }

  if(locales.it == null) {
    console.log(`> adding locale ${pc.yellow("it")} from source`);
    locales.it = it;  
  }

  if(locales.hr == null) {
    console.log(`> adding locale ${pc.yellow("hr")} from source`);
    locales.hr = hr;
  }

  console.log(`> locales loaded, available locales: ${Object.keys(locales).map(s => pc.yellow(s)).join(", ")}`);

  return locales
}

export const getLocaleForAcceptLang = (acceptLang: string | null | undefined, locales: Locales): { lang: string, locale: Locale } => {
  if(acceptLang == null) return { lang: "en", locale: locales.en };
  let langs: ReturnType<typeof parse>;
  try {
    langs = parse(acceptLang);
  } catch(_e) {
    return { lang: "en", locale: locales.en };
  }
  for(const lang of langs) {
    if(lang.region) {
      const key = `${lang.code}-${lang.region}`;
      if(locales[key] != null) return { lang: key, locale: locales[key] };
    }

    if(locales[lang.code] != null) return { lang: lang.code, locale: locales[lang.code] };
  }
  
  return { lang: "en", locale: locales.en }
}

// The webmail persists the chosen language in a `raven.lang` cookie (mirrored
// from localStorage) so that EVERY API request — not only the /api/locale fetch
// that carries ?accept-language= — is tagged with the user's choice. Without it,
// server-side error messages would fall back to the browser's Accept-Language,
// which can differ from the in-app selection. Parsed by hand to avoid pulling in
// cookie-parser for a single value.
const LANG_COOKIE = "raven.lang";
const readLangCookie = (req: Request): string | undefined => {
  const header = req.headers.cookie;
  if(!header) return undefined;
  for(const part of header.split(";")) {
    const eq = part.indexOf("=");
    if(eq === -1) continue;
    if(part.slice(0, eq).trim() === LANG_COOKIE) {
      const raw = part.slice(eq + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return undefined;
};

export const middleware = (config: Config) => {

  const locales = loadLocales(config);

  const i18n = Router();

  i18n.use((req: Request, res: Response, next: NextFunction) => {
    // Priority: explicit ?accept-language= query (the /api/locale fetch) > the
    // raven.lang cookie (in-app choice, sent on every request) > Accept-Language
    // header (browser default) > en (the getLocaleForAcceptLang fallback).
    let acceptLanguage = String(req.query["accept-language"] || "");
    if(!acceptLanguage) {
      acceptLanguage = readLangCookie(req) || "";
    }
    if(!acceptLanguage) {
      const header = req.headers["accept-language"] as string | string[] | undefined;
      if(typeof header === "string") {
        acceptLanguage = header;
      } else if(Array.isArray(header)) {
        acceptLanguage = header.join(",");
      }
    }
    const { lang, locale } = getLocaleForAcceptLang(acceptLanguage, locales);
    req.lang = lang;
    req.locale = locale;
    next();
  })

  i18n.get("/locale", async (req: Request, res: Response) => {
    const { lang, locale } = req;
    res.json({ lang, locale });
  })

  // Expose the available locale codes so the language menu can offer custom
  // locales loaded from extra_locales_dirs, not just the four built-ins.
  i18n.get("/locales", (_req: Request, res: Response) => {
    res.json({ codes: Object.keys(locales) });
  })

  return i18n;
}
