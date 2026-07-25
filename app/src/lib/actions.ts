export const add = (target: EventTarget, event: string, fn: EventListener, options: AddEventListenerOptions = {}) => {
  target.addEventListener(event, fn, options);
  return () => {
    target.removeEventListener(event, fn, options);
  }
}

// Make a non-semantic clickable element keyboard-operable for assistive tech:
// adds role="button", makes it focusable (tabindex), and activates the existing
// on:click on Enter/Space. An optional string sets an aria-label.
export const clickable = (node: HTMLElement, label?: string) => {
  if(!node.hasAttribute("role")) node.setAttribute("role", "button");
  if(!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
  if(label) node.setAttribute("aria-label", label);
  const onKeydown = (event: KeyboardEvent) => {
    if(event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      node.click();
    }
  };
  node.addEventListener("keydown", onKeydown);
  return {
    update(newLabel?: string) {
      if(newLabel) node.setAttribute("aria-label", newLabel);
    },
    destroy() {
      node.removeEventListener("keydown", onKeydown);
    },
  };
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

// Sanitize editor HTML and route any remote <img> (e.g. a signature's remote
// logo) through the same-origin SSRF-guarded proxy, so it RENDERS under the
// editor iframe's INHERITED CSP (img-src 'self' — a raw https logo would be
// blocked). This is render-only: the original URL is stashed in data-raven-src
// and restored by serializeEditorBody() before the body is copied back into the
// draft, so saved/sent mail keeps the public URL (recipients can't load our
// /api/proxy-image path). cid:/data:/attachment: srcs are left untouched.
// Schemes mail content may carry. `cid:` and `attachment:` are how WildDuck refers to
// inline parts; neither is fetchable by a browser. Deliberately narrower than
// DOMPurify's default in the other direction — mail has no business carrying
// ftp/sms/callto/xmpp/matrix. Shared by every pass that touches message or draft HTML.
export const EDITOR_URI_REGEXP = /^(mailto|https?|cid|tel|attachment):/i;

export const proxyRemoteImages = (html: string): string => {
  // FORBID data-raven-src on input: an attacker could embed <img src="cid:x"
  // data-raven-src="https://tracker"> in a sent message; without this, serialize
  // would later promote that marker into src and re-introduce the tracker the
  // stripping path removed. Only markers Raven adds below (post-sanitize) survive.
  // ALLOWED_URI_REGEXP is not optional here. DOMPurify's default scheme list has no
  // `attachment:` — the form WildDuck uses for an inline part — and this function runs
  // on the way INTO the editor iframe. Left at the default it silently dropped those
  // srcs, and because the editor writes its DOM back out through serializeEditorBody(),
  // the loss became permanent the moment the user typed anything in the body: the
  // forward was created correctly and then re-saved without its inline images. Same
  // list as messageHTML uses on the read side.
  const div = dompurify.sanitize(html || "", {
    RETURN_DOM: true,
    ALLOWED_URI_REGEXP: EDITOR_URI_REGEXP,
    ADD_DATA_URI_TAGS: ["img"],
    FORBID_ATTR: ["data-raven-src"],
  }) as HTMLElement;
  for(const $img of [].slice.call(div.querySelectorAll("img")) as HTMLImageElement[]) {
    const src = ($img.getAttribute("src") || "").trim();
    if(/^(https?:)?\/\//i.test(src)) {
      const abs = src.startsWith("//") ? "https:" + src : src;
      $img.setAttribute("data-raven-src", src);   // original, restored on serialize
      $img.setAttribute("src", `/api/proxy-image?url=${encodeURIComponent(abs)}`);
    }
  }
  return div.innerHTML;
};

// Serialize an editor body for storage, undoing proxyRemoteImages(): restore the
// original remote src and drop the proxy URL + marker so the saved/sent HTML
// carries the public URL, not our same-origin proxy path.
export const serializeEditorBody = (body: HTMLElement): string => {
  const clone = body.cloneNode(true) as HTMLElement;
  for(const $img of [].slice.call(clone.querySelectorAll("img[data-raven-src]")) as HTMLImageElement[]) {
    $img.setAttribute("src", $img.getAttribute("data-raven-src") || "");
    $img.removeAttribute("data-raven-src");
  }
  return clone.innerHTML;
};

export const messageHTML = (node: HTMLElement, opts: string | { html: string, message: FullMessage, loadRemote?: boolean }) => {

  let html = typeof opts === "string" ? opts : opts?.html || "";
  html = html.trim();

  const message = typeof opts === "string" ? null : opts.message;
  const loadRemote = typeof opts === "string" ? false : !!opts.loadRemote;

  const fragment = dompurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_URI_REGEXP: EDITOR_URI_REGEXP,
    // Allow data: URIs ONLY on <img> so embedded base64 images (common in
    // newsletters) render. Safe: an <img> never executes script, and the body
    // is in a no-allow-scripts sandboxed iframe regardless.
    ADD_DATA_URI_TAGS: ["img"],
  });

  for(const $a of [].slice.call(fragment.querySelectorAll("a"))) {
    const a = $a as HTMLAnchorElement;
    a.target = "_blank";
    a.rel = "noopener noreferrer external nofollow";
  }

  // Drop <link> so no remote stylesheet is fetched.
  for(const $el of [].slice.call(fragment.querySelectorAll("link, script, meta, object, head, title")) as HTMLElement[]) {
    $el.remove();
  }

  // Neutralize any reference to OUR OWN same-origin image proxy that an attacker
  // planted in a fetch-capable attribute the rewrites below don't visit — e.g.
  // <svg><image href="/api/proxy-image?url=…">, an xlink:href, or an exotic
  // attribute. The iframe CSP is img-src 'self', so the browser WOULD fetch a
  // same-origin proxy URL, contacting the sender before the user clicks "Load
  // images". Email never legitimately points at our /api/proxy-image; strip it from
  // every attribute up front (resolved against our origin so off-origin URLs that
  // merely contain "/api/proxy-image" in their path are left for the gated rewrite).
  // Our own proxy/attachment URLs are added by the rewrites that run AFTER this.
  const isSelfProxy = (v: string): boolean => {
    try {
      const u = new URL((v || "").trim(), location.origin);
      return u.host === location.host && /^\/api\/proxy-image\b/i.test(u.pathname);
    } catch { return false; }
  };
  for(const $el of [].slice.call(fragment.querySelectorAll("*")) as Element[]) {
    for(const attr of [].slice.call($el.attributes) as Attr[]) {
      if(isSelfProxy(attr.value)) $el.removeAttribute(attr.name);
    }
  }

  // <style> is kept (email layout often depends on it, and it's inert in the
  // no-allow-scripts iframe), but its CSS can still fetch remote assets via
  // url() / @import — bypassing the image opt-in and leaking a "message opened"
  // tracking signal. Strip @import outright; for url() keep data:/cid:, route
  // http(s) refs through the proxy when images are opted in, neutralize otherwise.
  // Rewrite url() refs in CSS — keep data:/cid:, route http(s)/app-absolute
  // through the proxy when opted in, neutralize otherwise. Used for both <style>
  // blocks and inline style="" attributes (@import only appears in blocks).
  // Protocol-relative URLs (//cdn/p.png) carry no scheme, so new URL() on the
  // proxy server rejects them and the image never loads after opt-in — give them
  // an explicit scheme before proxying.
  const toFetchable = (u: string): string => u.startsWith("//") ? "https:" + u : u;

  const rewriteCssUrls = (css: string): string =>
    // image-set()/-webkit-image-set() can name remote OR same-origin-proxy URLs
    // that CSP 'self' would still fetch, and a multi-candidate set isn't worth
    // proxying — drop them wholesale (rare in mail). Then gate plain url() refs.
    css
    .replace(/(-webkit-)?image-set\([^)]*\)/gi, "none")
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole: string, _q: string, ref: string) => {
      const u = (ref || "").trim();
      if(!u || /^(data:|cid:)/i.test(u)) return whole;        // inline / attachment — safe
      if(/^(https?:)?\/\//i.test(u) || u.startsWith("/")) {   // remote or app-absolute
        return loadRemote ? `url("/api/proxy-image?url=${encodeURIComponent(toFetchable(u))}")` : "none";
      }
      return whole;                                            // bare relative — inert in the iframe
    });

  for(const $style of [].slice.call(fragment.querySelectorAll("style")) as HTMLStyleElement[]) {
    $style.textContent = rewriteCssUrls(($style.textContent || "").replace(/@import\b[^;]*;?/gi, ""));
  }

  // Inline style="" attributes (DOMPurify keeps these) carry the same url()
  // vector — e.g. <div style="background:url(https://tracker/p.png)"> fetches the
  // moment the iframe renders, even with images hidden. Rewrite them too.
  for(const $el of [].slice.call(fragment.querySelectorAll("[style]")) as HTMLElement[]) {
    const style = $el.getAttribute("style") || "";
    const cleaned = rewriteCssUrls(style);
    if(cleaned !== style) $el.setAttribute("style", cleaned);
  }

  // srcset (on <img> and <picture>/<video> <source>) is fetch-capable but was
  // never gated — browsers could load a remote candidate pre-opt-in or prefer it
  // over the proxied src. Strip every srcset; the src below stays gated.
  for(const $el of [].slice.call(fragment.querySelectorAll("[srcset]")) as HTMLElement[]) {
    $el.removeAttribute("srcset");
  }

  for(const $img of [].slice.call(fragment.querySelectorAll("img, source")) as HTMLElement[]) {
    const src = ($img.getAttribute("src") || "").trim();
    const m = src.match(/^(cid|attachment):(.+)/i);
    if(m) {
      // Inline attachment image -> same-origin attachment proxy.
      $img.removeAttribute("src");
      const cid = m[2];
      const att = message?.attachments?.find(att => att.id === cid);
      if(att) $img.setAttribute("src", `/api/mailboxes/${message!.mailbox}/messages/${message!.id}/attachments/${att.id}`);
    } else if(/^data:/i.test(src)) {
      // Embedded base64 image — no network, no tracking; render as-is.
    } else if(src) {
      if(loadRemote) {
        // Routed through our SSRF-guarded server proxy: the sender sees the
        // server's IP, not the user's, and it loads from our own origin.
        $img.setAttribute("src", `/api/proxy-image?url=${encodeURIComponent(toFetchable(src))}`);
      } else {
        // Hidden by default (no broken-image glyph); user opts in via "Load images".
        $img.removeAttribute("src");
        $img.style.display = "none";
      }
    }
  }

  // Legacy `background` attribute (e.g. <td background="https://...">) fetches an
  // image just like <img src> and DOMPurify keeps it — gate it the same way.
  for(const $el of [].slice.call(fragment.querySelectorAll("[background]")) as HTMLElement[]) {
    const bg = ($el.getAttribute("background") || "").trim();
    const m = bg.match(/^(cid|attachment):(.+)/i);
    if(m) {
      $el.removeAttribute("background");
      const att = message?.attachments?.find(att => att.id === m[2]);
      if(att) $el.setAttribute("background", `/api/mailboxes/${message!.mailbox}/messages/${message!.id}/attachments/${att.id}`);
    } else if(/^data:/i.test(bg)) {
      // inline — keep
    } else if(bg) {
      if(loadRemote) $el.setAttribute("background", `/api/proxy-image?url=${encodeURIComponent(toFetchable(bg))}`);
      else $el.removeAttribute("background");
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
  // Email HTML is authored for a white canvas; without this the transparent
  // iframe shows the dark app background behind it in dark mode.
  iframe.style.background = "#fff";
  iframe.style.colorScheme = "light";
  // Defense-in-depth CSP for the email document, enforced by the BROWSER rather
  // than the regex above (CSS can fetch via image-set(), -webkit-image-set(),
  // cursor:url(), … which a regex can't fully cover). img-src is 'self' in BOTH
  // states: 'self' covers inline cid: attachment images (always safe — already
  // downloaded with the mail) and, once opted in, the same-origin proxy. Off-origin
  // (remote) fetches are always blocked; when not opted in, the DOM/CSS rewriting
  // strips every proxy URL too, so the only thing 'self' can still load is a cid
  // attachment. style-src 'unsafe-inline' keeps layout CSS; default-src 'none'
  // blocks script/connect/frame/object. Set via <meta> at parse time so it covers
  // the fragment appended on load; link navigation is unaffected.
  const csp = `default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:`;
  iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`;
  iframe.onload = () => {
    const doc = iframe.contentDocument;
    if(!doc) return;
    doc.body.style.margin = "0";
    // Constrain wide media to the message column: big newsletter images/tables
    // were rendering at natural size and overflowing the viewport.
    const baseStyle = doc.createElement("style");
    baseStyle.textContent =
      "html,body{background:#fff;color:#202124}img,video{max-width:100%!important;height:auto}table{max-width:100%}body{overflow-x:hidden}";
    doc.head.appendChild(baseStyle);
    doc.body.appendChild(fragment);

    // Fit the iframe to the email's OWN intended width and center it, instead of
    // stretching the full pane. Most HTML emails use a fixed-width container
    // (~600px is the de-facto standard; some go to ~700px); we measure that
    // intrinsic width via max-content and cap it. Fluid/plain emails whose
    // content has no fixed width fall back to the full column.
    const MAX_W = 1024;
    const fitWidth = () => {
      doc.body.style.width = "max-content";
      doc.body.style.maxWidth = MAX_W + "px";
      const natural = Math.ceil(doc.body.getBoundingClientRect().width);
      doc.body.style.width = "";
      doc.body.style.maxWidth = "";
      iframe.style.maxWidth = Math.min(Math.max(natural, 360), MAX_W) + "px";
      iframe.style.marginInline = "auto";
    };

    const resize = () => {
      iframe.style.height = `${doc.documentElement.scrollHeight}px`;
    };

    fitWidth();
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
    ALLOWED_URI_REGEXP: EDITOR_URI_REGEXP,
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