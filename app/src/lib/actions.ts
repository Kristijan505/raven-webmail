export const add = (target: EventTarget, event: string, fn: EventListener, options: AddEventListenerOptions = {}) => {
  target.addEventListener(event, fn, options);
  return () => {
    target.removeEventListener(event, fn, options);
  }
}

export const intersect = (node: Element) => {
  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver(entries => {
      entries[0].isIntersecting ?
        node.dispatchEvent(new CustomEvent("enter-screen")) :
        node.dispatchEvent(new CustomEvent("leave-screen"))
    })

    observer.observe(node);

    return { destroy: () => observer.disconnect() }

  } else {

    let prev: boolean;

    const fn = () => {
      const bcr = node.getBoundingClientRect();
      const is = (
        bcr.bottom > 0 &&
        bcr.right > 0 &&
        bcr.top < window.innerHeight &&
        bcr.left < window.innerWidth
      );

      if (prev !== is) {
        prev = is;
        is ?
          node.dispatchEvent(new CustomEvent("enter-screen")) :
          node.dispatchEvent(new CustomEvent("leave-screen"))

      }
    }

    fn();
    const destroy = add(window, 'scroll', fn, { passive: true });


    return { destroy }
  }
}

import { tick } from "svelte";

export const tooltip = (node: HTMLElement, _params: null | string | {tip: string}) => {

  const params: {tip: string | null} = ((typeof _params === "string" || _params == null) ? {tip: _params} : _params) as {tip: string | null};

  let el = document.createElement("div");
  el.classList.add("tooltip");
  el.textContent = params.tip;
  let timer: any;
  let on = false;

  node.appendChild(el);

  let removeScroll: (() => void) | null = null;

  const removeEnter = add(node, "mouseenter", async () => {
    if(params.tip == null) return;
    on = true;
    clearTimeout(timer);
    el.classList.remove("visible");
    const target = node.getBoundingClientRect();
    document.body.appendChild(el);
    await tick();
    el.style.left = Math.max(5, Math.min(window.innerWidth - 5, target.left + (target.width / 2) - (el.clientWidth / 2))) + "px";
    el.style.top = Math.max(5, Math.min(window.innerHeight - 5, target.top - el.clientHeight - 7)) + "px";
    el.classList.add("visible");
    removeScroll = add(window, "scroll", () => removeTooltip(), {once: true, capture: true, passive: true})
  })

  const removeTooltip = () => {
    on = false;
    el.classList.remove("visible");
    if(removeScroll) removeScroll();
    timer = setTimeout(() => {
      el.parentElement && el.parentElement.removeChild(el);
    }, 200)
  }

  const removeLeave = add(node, "mouseleave", removeTooltip);

  return {
    update(opts: string | null | {tip: string | null}) {
      if (typeof opts === "string" || opts == null) {
        opts = { tip: opts } as { tip: string | null };
      }

      params.tip = opts.tip;
      el.textContent = opts.tip;
      if(!params.tip) {
        on = false
        el.parentElement && el.parentElement.removeChild(el);
      }
    },

    destroy() {
      removeEnter();
      removeLeave();
      if(removeScroll) removeScroll();
      if (el.parentElement) el.parentElement.removeChild(el);
    }
  }
}


export const clickOut = (node: Node) => {
  return { 
    destroy: add(node.ownerDocument || document, "click", (event) => {
      let target: Element | null = (event.target as Element);
      while(target != null) {
        if(target === node) return;
        target = target.parentElement;
      }

      const e = new CustomEvent("click-out", { detail: event });
      node.dispatchEvent(e)

    }, {capture: true})
  }
}

import dompurify from "dompurify";
import type { FullMessage, Message } from "./types";

export const messageHTML = (node: HTMLElement, opts: string | { html: string, message: FullMessage }) => {
  
  let html = typeof opts === "string" ? opts : opts?.html || "";
  html = html.trim();

  const message = typeof opts === "string" ? null : opts.message;

  const fragment = dompurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_URI_REGEXP: /^(mailto|https?|cid|tel|attachment):/i,
  });

  for(const $a of [].slice.call(fragment.querySelectorAll("a"))) {
    const a = $a as HTMLAnchorElement;
    a.target = "_blank";
    a.rel = "noopener noreferrer external nofollow";
  }

  // Keep <style> (it's inert in a no-allow-scripts iframe and email layout
  // often depends on it); drop <link> so no remote stylesheet is fetched.
  for(const $el of [].slice.call(fragment.querySelectorAll("link, script, meta, object, head, title")) as HTMLElement[]) {
    $el.remove();
  }

  for(const $img of [].slice.call(fragment.querySelectorAll("img")) as HTMLImageElement[]) {
    const src = ($img.getAttribute("src") || "").trim();
    const m = src.match(/^(cid|attachment):(.+)/i);
    if(m) {
      // Inline attachment image -> same-origin attachment proxy.
      $img.removeAttribute("src");
      const cid = m[2];
      const att = message?.attachments?.find(att => att.id === cid);
      if(att) $img.setAttribute("src", `/api/mailboxes/${message!.mailbox}/messages/${message!.id}/attachments/${att.id}`);
    } else if(src) {
      // Remote image -> blocked by default (defeats tracking pixels / IP leak).
      $img.removeAttribute("src");
    }
  }

  // Render the untrusted email body inside a sandboxed iframe WITHOUT
  // allow-scripts: even if DOMPurify is ever bypassed, scripts cannot run and
  // the email's CSS cannot clickjack the real app UI. allow-same-origin lets us
  // inject the fragment and measure height; allow-popups (+ escape-sandbox) lets
  // target="_blank" links actually open. None of these enable script execution.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  iframe.style.width = "100%";
  iframe.style.border = "none";
  iframe.style.display = "block";
  iframe.srcdoc = "";
  iframe.onload = () => {
    const doc = iframe.contentDocument;
    if(!doc) return;
    doc.body.style.margin = "0";
    doc.body.appendChild(fragment);

    const resize = () => {
      iframe.style.height = `${doc.documentElement.scrollHeight}px`;
    };

    resize();
    iframe.contentWindow?.addEventListener("resize", resize);
    for(const $img of [].slice.call(doc.images) as HTMLImageElement[]) {
      $img.addEventListener("load", resize);
      $img.addEventListener("error", resize);
    }
  }

  node.appendChild(iframe);

  return {
    destroy: () => iframe.remove()
  }
}

export const purify = (node: HTMLElement, opts?: string | { html: string, message: FullMessage }) => {
  
  let html = typeof opts === "string" ? opts : opts?.html || "";
  html = html.trim();

  const message = typeof opts === "string" ? null : opts.message;

  const fragment = dompurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_URI_REGEXP: /^(mailto|https?|tel|cid|attachment):/i,
  });
  
  for(const $a of [].slice.call(fragment.querySelectorAll("a"))) {
    const a = $a as HTMLAnchorElement;
    a.target = "_blank";
    a.rel = "noopener noreferrer external nofollow";
  }

  for(const $el of [].slice.call(fragment.querySelectorAll("style, link, script, meta, object, head, title")) as HTMLElement[]) {
    $el.parentNode?.removeChild($el);
  }

  for(const $img of [].slice.call(fragment.querySelectorAll("img")) as HTMLImageElement[]) {
    const src = ($img.getAttribute("src") || "").trim();
    const m = src.match(/^(cid|attachment):(.+)/i);
    if(m) {
      $img.removeAttribute("src");
      const cid = m[2];
      const att = message?.attachments?.find(att => att.id === cid);
      if(att) $img.setAttribute("src", `/api/mailboxes/${message!.mailbox}/messages/${message!.id}/attachments/${att.id}`);
    } else if(src) {
      // Remote image -> blocked by default (tracking-pixel / IP-leak defense).
      $img.removeAttribute("src");
    }
  }

  node.appendChild(fragment);
}


export const portal = (node: HTMLElement) => {
  document.body.appendChild(node);
  return {
    destroy() {
      node.parentElement?.removeChild(node);
    }
  }
}