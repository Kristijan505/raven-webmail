import DOMPurify from "dompurify";
import { EDITOR_URI_REGEXP } from "$lib/actions";

/**
 * Shared DOMPurify options for every pass over compose content.
 *
 * The scheme list matters: DOMPurify's DEFAULT allow-list (http(s), ftp, mailto, tel,
 * callto, sms, cid, xmpp, matrix) has no `attachment:`, so it drops those srcs itself
 * — before any of our own logic gets to look at them. That is why merely teaching
 * stripRemote to keep attachment: was not enough; the sanitise call INSIDE it was
 * already throwing them away. Mirror the list messageHTML uses on the read side.
 */
export const PURIFY_OPTS = {
  RETURN_DOM: true as const,
  FORBID_ATTR: ["data-raven-src"],
  ALLOWED_URI_REGEXP: EDITOR_URI_REGEXP,
  ADD_DATA_URI_TAGS: ["img"],
};

export const sanitize = (src: string | string[] | null): { html: string; text: string | null } => {
  if(src instanceof Array) src = src.join("");
  const div = DOMPurify.sanitize(src || "", PURIFY_OPTS) as HTMLElement;
  const toRemove = div.querySelectorAll("style, link, script, meta, object, head, title");
  for(let i = 0; i < toRemove.length; i++) {
    const el = toRemove[i];
    el.parentNode?.removeChild(el);
  }
  // NB: remote images are NOT stripped here. sanitize() also runs over the
  // user's OWN signature (blank(), and the signature half of createBody), which
  // may legitimately use a remote logo — stripping it would silently drop the
  // saved signature image. Untrusted QUOTED content is stripped separately via
  // stripRemote() before it's appended in createBody.
  const html = div.innerHTML;
  const text = div.textContent;
  return { html, text }
}

/**
 * The signature is inserted inside a marked wrapper so the From selector can find it
 * again. Switching the account a draft is sent from has to switch whose signature goes
 * out with it, and by the time that happens the body has been through DOMPurify, the
 * contenteditable editor and a WildDuck round-trip — a marker is the only handle that
 * survives all three. The attribute itself does: PURIFY_OPTS forbids only
 * `data-raven-src`, and nothing downstream rewrites data attributes.
 */
export const SIGNATURE_MARK = "data-raven-signature";

export const signatureBlock = (html: string): string =>
  `<div ${SIGNATURE_MARK}="">${html}</div>`;

/**
 * Swap the signature block's contents inside the LIVE editor document, leaving
 * everything the user typed alone.
 *
 * Deliberately the iframe's document and not the draft's html string: while a compose
 * window is open the iframe body is the source of truth. Editor.svelte copies the
 * draft in once, on mount, and from then on its MutationObserver copies the other way
 * — so assigning draft.html here would change nothing on screen and be overwritten by
 * the next keystroke. Editing the body instead makes that observer do the rest: it
 * writes the new html and text back into the draft, and the autosave persists them.
 *
 * `ready` must already have been through the same preparation the editor applies on
 * injection (proxyRemoteImages: sanitise, plus routing remote images through the
 * proxy) — this is a stored signature that has not passed through this build's
 * sanitiser, going into a same-origin iframe.
 *
 * Returns false when no marked block is left — a draft written before this marker
 * existed, or one whose signature the user deleted by hand. Guessing at an unmarked
 * signature would mean editing text the user owns, which is worse than leaving a stale
 * block they can see and fix.
 */
export const swapSignature = (doc: Document | null | undefined, ready: string): boolean => {
  const block = doc?.body?.querySelector(`[${SIGNATURE_MARK}]`);
  if(!block) return false;
  block.innerHTML = ready;
  return true;
};
