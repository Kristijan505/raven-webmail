import type { Mailbox } from "$lib/types";
import { redirect } from "@sveltejs/kit";

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
      : (json.error?.message || "Request failed");
    throw new HttpError(res.status, message);
  }
}

export const mailboxName = (mailbox: Mailbox) => {
  const l = get(locale);
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
  const res = await fetch(pathAndQuery).catch(() => {
    throw new HttpError(500, "Cannot connect to server");
  });

  const body: any = await res.json().catch(() => {
    throw new HttpError(res.status, "Invalid JSON response from server");
  });

  // Legacy page endpoint format uses JSON redirect payloads.
  if (body?.redirect) {
    throw redirect(Number(body.status) || 302, body.redirect);
  }

  if (body?.error) {
    const message = typeof body.error === "string"
      ? body.error
      : body.error?.message || "Unknown page error";
    throw new HttpError(Number(body.status) || res.status, message);
  }

  if (!res.ok) {
    throw new HttpError(res.status, `Cannot get page, invalid response status code: ${res.status}`);
  }

  return body?.props ?? body;
}


export const action = <A extends any[], T>(fn: (...args: A) => T | Promise<T>) => {
  return async (...args: A) => {
    try {
      return await fn(...args)
    } catch(e: any) {
      // @ts-ignore
      _error(e?.message || "Error");
    }
  }
}

export const _get = async (url: string) => {
  const res = await fetch(url).catch(e => {
    throw new HttpError(500, "Cannot connect to server");
  })

  const json = await res.json().catch(e => {
    throw new HttpError(res.status, "Invalid JSON response from server");
  })

  throwIfError(res, json);

  return json;
}

export const _delete = async (url: string) => {
  const res = await fetch(url, {
    method: "DELETE",
  }).catch(e => {
    throw new HttpError(500, "Cannot connect to server");
  })

  const json = await res.json().catch(e => {
    throw new HttpError(res.status, "Invalid JSON response from server");
  })

  throwIfError(res, json);

  return json;
}

export const _post = async (url: string, body: any) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).catch(e => {
    throw new HttpError(500, "Cannot connect to server");
  })

  const json = await res.json().catch(e => {
    throw new HttpError(res.status, "Invalid JSON response from server");
  })

  throwIfError(res, json);

  return json;
}

export const _put = async (url: string, body: any) => {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).catch(e => {
    throw new HttpError(500, "Cannot connect to server");
  })

  const json = await res.json().catch(e => {
    throw new HttpError(res.status, "Invalid JSON response from server");
  })

  throwIfError(res, json);

  return json;
}

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
import { locale } from "./locale";
import { intertab } from "./intertab";

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

export const watchAuth = (userId: string | null) => {
  const watcher = intertab<string | null>("intertab.auth.watch");
  watcher.set(userId);
  const unwatch = watcher.watch(value => {
    if(value === userId) return;
    if(value == null) {
      goto("/login")
    } else {
      goto("/")
    }
  });
  return unwatch;
}

const p = (n: number) => n.toString().padStart(2, "0");

export const messageDate = (d: Date | string) => {
  
  const l = get(locale);

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
