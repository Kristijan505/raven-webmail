import type { Mailbox } from "$lib/types";
import type { Locale } from "../../../server/src/i18n/locale";
import { redirect } from "@sveltejs/kit";

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Network/transport errors thrown by the fetch helpers surface as toasts, so
// resolve them from the locale (English fallback for the brief window before the
// locale store has loaded).
const netErr = (
  k: "request_failed" | "cannot_connect" | "invalid_response" | "unknown_error",
  fallback: string,
): string => get(locale).errors?.[k] ?? fallback;

// Normalize the various server error shapes into one thrown HttpError:
// handler() returns { error: { status, message } }, pageHandler() returns
// { error: "<string>" } or { status, redirect }. The old code assumed
// json.error.message always existed, so string-shaped errors surfaced as a
// blank toast. Also follows an explicit server redirect (e.g. expired session).
const throwIfError = (res: Response, json: any): void => {
  if(json?.redirect) {
    goto(json.redirect);
    throw new HttpError(res.status, "Redirecting");
  }
  if(json?.error) {
    const message = typeof json.error === "string"
      ? json.error
      : (json.error?.message || netErr("request_failed", "Request failed"));
    throw new HttpError(res.status, message);
  }
}

export const mailboxName = (mailbox: Mailbox, l: Locale = get(locale)) => {
  if(mailbox.path === "INBOX") return l.mailboxes.Inbox;
  if(mailbox.specialUse === "\\Junk") return l.mailboxes.Spam;
  if(mailbox.specialUse === "\\Sent") return l.mailboxes.Sent;
  if(mailbox.specialUse === "\\Drafts") return l.mailboxes.Drafts;
  if(mailbox.specialUse === "\\Trash") return l.mailboxes.Trash;
  return mailbox.name;
}

import Inbox from "~icons/mdi/inbox-outline";
import Trash from "~icons/mdi/delete-outline";
import Sent from "~icons/mdi/send-outline";
import Junk from "~icons/mdi/alert-decagram-outline";
import Drafts from "~icons/mdi/file-document-edit-outline";
import Other from "~icons/mdi/folder-outline";

export const mailboxIcon = (mailbox: Mailbox) => {
  if(mailbox.path === "INBOX") return Inbox;
  if(mailbox.specialUse === "\\Junk") return Junk;
  if(mailbox.specialUse === "\\Sent") return Sent;
  if(mailbox.specialUse === "\\Drafts") return Drafts;
  if(mailbox.specialUse === "\\Trash") return Trash;
  return Other;
}

export const mailboxIsDeletable = (mailbox: Mailbox) => {
  if(mailbox.path === "INBOX") return false;
  if(mailbox.specialUse != null) return false;
  return true;
}

export const isInbox = (mailbox: Mailbox) => mailbox.path === "INBOX";
export const isJunk = (mailbox: Mailbox) => mailbox.specialUse === "\\Junk";
export const isSent = (mailbox: Mailbox) => mailbox.specialUse === "\\Sent";
export const isDrafts = (mailbox: Mailbox) => mailbox.specialUse === "\\Drafts";
export const isTrash = (mailbox: Mailbox) => mailbox.specialUse === "\\Trash";

export const sortMailboxes = (mailboxes: Mailbox[] = []): Mailbox[] => {
  const all = Array.isArray(mailboxes) ? mailboxes : [];

  const inbox = all.find(isInbox);
  const drafts = all.find(isDrafts);
  const sent = all.find(isSent);
  const junk = all.find(isJunk);
  const trash = all.find(isTrash);

  const folders = all.filter(item => !isInbox(item) && item.specialUse == null);

  const res: Mailbox[] = [
    inbox,
    ...folders,
    drafts,
    sent,
    junk,
    trash,
  ].filter((item): item is Mailbox => Boolean(item));

  for (const item of all) {
    if (!res.includes(item)) res.push(item);
  }

  return res;
}


type GetPageOptions = {
  fetch: typeof globalThis.fetch;
  path?: string;
  url?: URL;
};

export const getPage = async ({ fetch, path, url }: GetPageOptions) => {
  const pathAndQuery = path || (url ? `/api/pages${url.pathname}${url.search}` : "");
  const res = await fetch(withAccount(pathAndQuery)).catch(() => {
    throw new HttpError(500, netErr("cannot_connect", "Cannot connect to the server"));
  });

  const body: any = await res.json().catch(() => {
    throw new HttpError(res.status, netErr("invalid_response", "Invalid response from the server"));
  });

  // Legacy page endpoint format uses JSON redirect payloads.
  if (body?.redirect) {
    throw redirect(Number(body.status) || 302, body.redirect);
  }

  if (body?.error) {
    const message = typeof body.error === "string"
      ? body.error
      : body.error?.message || netErr("unknown_error", "Something went wrong");
    throw new HttpError(Number(body.status) || res.status, message);
  }

  if (!res.ok) {
    throw new HttpError(res.status, `${netErr("invalid_response", "Invalid response from the server")} (${res.status})`);
  }

  return body?.props ?? body;
}


export const action = <A extends any[], T>(fn: (...args: A) => T | Promise<T>) => {
  return async (...args: A) => {
    try {
      return await fn(...args)
    } catch(e: any) {
      // @ts-ignore
      _error(e?.message || netErr("unknown_error", "Something went wrong"));
    }
  }
}

/**
 * Every /api call goes through here.
 *
 * The four verbs below used to be four copies of this body, differing only in method
 * and payload — so each was its own place to forget a change. The account stamp
 * (withAccount), the two shapes a fetch can fail in, and the server's several error
 * envelopes (throwIfError) are each one decision, made once.
 */
const request = async (url: string, init?: RequestInit) => {
  const res = await fetch(withAccount(url), init).catch(() => {
    throw new HttpError(500, netErr("cannot_connect", "Cannot connect to the server"));
  })

  const json = await res.json().catch(() => {
    throw new HttpError(res.status, netErr("invalid_response", "Invalid response from the server"));
  })

  throwIfError(res, json);

  return json;
}

const jsonBody = (method: "POST" | "PUT", body: any): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const _get = (url: string) => request(url);
export const _delete = (url: string) => request(url, { method: "DELETE" });
export const _post = (url: string, body: any) => request(url, jsonBody("POST", body));
export const _put = (url: string, body: any) => request(url, jsonBody("PUT", body));

export const isMail = (str: string): boolean => /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i.test(str);

import { add } from "./actions";

const currentUid = () => `${Number(history.state?.id) || 0}-${location.pathname}${location.search}`;

export const ScrollRestoration = () => {
  
  const map = new Map<string, {x: number, y: number}>();

  return (node: HTMLElement) => {
    const key = currentUid();
    const scroll = map.get(key);
    if(scroll) {
      node.scrollTop = scroll.y;
      node.scrollLeft = scroll.x;
    }
    
    let x = node.scrollLeft;
    let y = node.scrollTop;
  
    const remove = add(node, "scroll", () => {
      x = node.scrollLeft;
      y = node.scrollTop;
      map.set(currentUid(), { x, y });
    }, { passive: true })

    return {
      destroy() {
        remove();
      }
    }
  }
}

export const isNarrow = () => {
  return window.matchMedia("(max-width: 800px)").matches;
}

export const isWide = () => {
  return window.matchMedia("not all and (max-width: 800px)").matches;
}

import { goto } from "$app/navigation";
import { _error } from "./Notify/notify";
import { get } from "svelte/store";
import { lang, locale } from "./locale";

// Pick the grammatically correct plural form for `count` in the active language
// using the platform CLDR rules (Croatian: 1 -> one, 2-4 -> few, else other;
// English/Spanish/Italian: 1 -> one, else other).
export const plural = (count: number, forms: { one: string; few: string; other: string }): string => {
  let category: string;
  try {
    category = new Intl.PluralRules(get(lang)).select(count);
  } catch {
    category = count === 1 ? "one" : "other";
  }
  return (forms as Record<string, string | undefined>)[category] ?? forms.other;
};
import { intertab } from "./intertab";
// Every /api request carries the tab's account (see account.ts) — the one funnel
// that keeps multi-account tabs honest without touching call sites.
import { setTabAccount, tabAccount, withAccount } from "./account";

/*
export const watchAuth = (username: string | null) => {
  const stream = new EventSource("/api/auth");
  stream.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if(data.username !== username) {
      username = data.username;
      if(username == null) {
        goto("/login");
      } else {
        goto("/");
      }
    }
  }

  return () => stream.close();
}
*/

/** Is this tab's pinned account still in the signature another tab just published? */
const stillSignedIn = (signature: string, pinned: string | null): boolean =>
  !pinned || signature.split(",").some(entry => entry.replace(/!$/, "") === pinned);

/**
 * Resync this tab when the set of signed-in accounts changes in another one.
 *
 * Dropping the pin first is the part that matters. It is stamped onto every request as
 * ?account=, and when it names an account that was just signed out elsewhere the tab
 * cannot heal itself: the layout route is lenient and answers 200 as some other
 * account, but the mailbox page under it 404s, and that error renders ABOVE the (app)
 * layout — so the component whose job is to re-pin the tab to whoever answered never
 * mounts. The tab sits on an error screen, still holding a dead account id, through
 * any number of reloads. Only a pin that is genuinely gone is cleared: a tab
 * deliberately looking at one mailbox must not be dragged to another because a third
 * account was added in some other tab.
 *
 * The reload itself is a full document load rather than goto() because the (app)
 * layout's load declares no dependency on the route, so what a client-side navigation
 * rebuilds is not something to rely on.
 */
export const watchAuth = (userId: string | null) => {
  const watcher = intertab<string | null>("intertab.auth.watch");
  watcher.set(userId);
  const unwatch = watcher.watch(value => {
    if(value === userId) return;
    if(value == null) {
      setTabAccount(null);
      location.assign("/login");
      return;
    }
    if(!stillSignedIn(value, get(tabAccount))) setTabAccount(null);
    location.assign("/");
  });
  return unwatch;
}

const p = (n: number) => n.toString().padStart(2, "0");

export const messageDate = (d: Date | string, l: Locale = get(locale)) => {

  const now = new Date();
  const date = new Date(d);

  if(now.getFullYear() !== date.getFullYear())
    return `${l.month[date.getMonth()]} ${date.getFullYear()}`
  
  if(now.getMonth() !== date.getMonth())
    return `${date.getDate()} ${l.month[date.getMonth()]}`;

  if(now.getDate() !== date.getDate()){
    return `${l.week[date.getDay()]} ${date.getDate()}`;
  }

  return `${date.getHours()}:${p(date.getMinutes())}`;
}


export const clone = <T>(src: T): T => {
  
  // @ts-ignore
  if(src instanceof Date) return new Date(src); 

  if(src instanceof Array) {
    // @ts-ignore
    return src.map(clone);
  }

  if(typeof src === "object" && src !== null) {
    const target = {};
    for(const key of Object.keys(src)) {
      // @ts-ignore
      target[key] = clone(src[key]);
    }

    // @ts-ignore
    return target;
  }

  return src;
}


export const equals = (src: any, target: any): boolean => {
  
  if(src instanceof Date && target instanceof Date) {
    return +src === +target;
  }

  if(src instanceof Array) {
    
    if(!(target instanceof Array)) return false;
    
    if(src.length !== target.length) return false;
    
    for(let i = 0; i < src.length; i++) {
      if(!equals(src[i], target[i])) return false;
    }
    
    return true;
  }

  if(typeof src === "object" && src !== null) {
    
    if(!(typeof target === "object" && target !== null)) return false;
    
    if(Object.keys(src).length !== Object.keys(target).length) return false;
    
    for(const key of Object.keys(src)) {
      if(!equals(src[key], target[key])) return false;
    }
    
    return true;
  }

  return src === target;
}
