<svelte:options accessors />

<script lang="ts">
  import { createMessageBody, crossin, crossout, kSent, kShowBcc, kShowCc } from "./compose";
  import type { Draft } from "./compose";
  import s from "html-escape";

  let tabs: Draft[] = [];
  let current: Draft | null = null;

  const hash = `#compose-${Date.now().toString(36)}`;

  $: if(!tabs.includes(current)) current = null;

  $: onCurrent(current);
  const onCurrent = (current: Draft) => {
    
    if(current && location.hash !== hash) location.hash = hash;

    if(!current && location.hash === hash) {
      history.back();
    }
  }

  onMount(() => {
    
    const hashchange = () => {
      if(current && location.hash !== hash) {
        current = null;
      }
    }

    return {
      destroy: add(window, "hashchange", hashchange),
    }
  })

  import Ripple from "$lib/Ripple.svelte";
  import Close from "~icons/mdi/close";
  import Window from "./Window.svelte";
  import { flip } from "svelte/animate";
  import { fade } from "svelte/transition";

  export const removeTab = (tab: Draft) => {
    if(current === tab) {
      current = null;
    }
    tabs = tabs.filter(t => t !== tab)
  }

  import { action, _get, _post } from "$lib/util";
  import type { FullMessage, Mailbox, User } from "$lib/types";
  import DOMPurify from "dompurify";
  import { onMount } from "svelte";
  import { add } from "$lib/actions";
  import { locale } from "$lib/locale";
	import { signature } from "$lib/signature";
	import { get } from "svelte/store";

  const sanitize = (src: string | string[] | null) => {
    if(src instanceof Array) src = src.join("");
    const div = DOMPurify.sanitize(src || "", { RETURN_DOM: true, FORBID_ATTR: ["data-raven-src"] }) as HTMLElement;
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

  // Strip fetch-capable refs from untrusted quoted reply/forward content: the
  // compose iframe is same-origin + authenticated and has no "load images" opt-in,
  // so a remote <img>/srcset/CSS url() would fetch (tracking) on open. data:/cid:
  // stay. Applied to quoted HTML only — never to the user's signature.
  const stripRemote = (html: string): string => {
    const div = DOMPurify.sanitize(html || "", { RETURN_DOM: true, FORBID_ATTR: ["data-raven-src"] }) as HTMLElement;
    for(const $el of [].slice.call(div.querySelectorAll("[srcset]")) as Element[]) $el.removeAttribute("srcset");
    for(const $img of [].slice.call(div.querySelectorAll("img, source")) as Element[]) {
      const s = ($img.getAttribute("src") || "").trim();
      if(s && !/^(data:|cid:)/i.test(s)) $img.removeAttribute("src");
    }
    for(const $el of [].slice.call(div.querySelectorAll("[style]")) as HTMLElement[]) {
      const st = $el.getAttribute("style") || "";
      const cleaned = st.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole: string, _q: string, ref: string) => {
        const u = (ref || "").trim();
        return (!u || /^(data:|cid:)/i.test(u)) ? whole : "none";
      });
      if(cleaned !== st) $el.setAttribute("style", cleaned);
    }
    return div.innerHTML;
  }

  const createBody = (action: "re" | "fwd", ref: FullMessage) => {
    const l = get(locale);
    return [
      "<br />".repeat(6),
      get(signature),
      "<br/>".repeat(2),
        "-".repeat(10) + " " + (action === "re" ? l.compose.reply_divider : l.compose.forward_divider) + " " + "-".repeat(10),
        ref.from && (`${l["From:"]} <b>${s(ref.from.name) || ""}</b> ${s("<" + ref.from.address + ">")}`),
        ref.to && ref.to.length && (`${l["To:"]} ${ref.to.map(to => s(to.address)).join(", ")}`),
        l["Subject:"] + " " + s(ref.subject),
        l["Date:"] + " " + s(new Date(ref.date).toUTCString())
      ].filter(Boolean).join("<br />") + "<br/>".repeat(4) +
      stripRemote(ref.html?.join("") || "");
  }

  export const blank = async (drafts: Mailbox) => {
    const content = `${"<br />".repeat(6)}${get(signature)}`;
    const subject = "";
    const { html, text } = sanitize(content);

    const body = createMessageBody({ subject, html, text })
    const res: any = await _post(`/api/mailboxes/${drafts.id}/messages`, body);

    await open(drafts, res.message.id);
  }

  export const reply = async (drafts: Mailbox, mailbox: Mailbox, id: number) => {
    const message: FullMessage = await _get(`/api/mailboxes/${mailbox.id}/messages/${id}`);
    const body = createBody("re", message);
    const { html, text } = sanitize(body);

    const subject = `Re: ${message.subject.trim().replace(/^re:/i, "").trim()}`;
    
    const bodyJSON = createMessageBody({
      to: message.from ? [message.from] : [],
      subject,
      html,
      text,
      reference: {
        mailbox: mailbox.id,
        id,
        action: "reply",
        attachments: false,
      }
    })

    const res: any = await _post(`/api/mailboxes/${drafts.id}/messages`, bodyJSON);

    await open(drafts, res.message.id);
  }

  export const replyAll = async (user: User, drafts: Mailbox, mailbox: Mailbox, id: number) => {
    const message: FullMessage = await _get(`/api/mailboxes/${mailbox.id}/messages/${id}`);
    const body = createBody("re", message);
    const { html, text } = sanitize(body);

    const subject = `Re: ${message.subject.trim().replace(/^re:/i, "").trim()}`;

    const to = [message.from];
    if(message.to) {
      for(const item of message.to) {
        if(item.address.toLowerCase() !== user.address?.toLowerCase()) {
          to.push(item);
        }
      }
    }

    const cc = [];
    if(message.cc) {
      for(const item of message.cc) {
        if(item.address.toLowerCase() !== user.address?.toLowerCase()) {
          cc.push(item);
        }
      }
    }

    const bodyJSON = createMessageBody({
      to,
      cc,
      subject,
      html,
      text,
      reference: {
        mailbox: mailbox.id,
        id,
        action: "replyAll",
        attachments: false,
      }
    })

    const res = await _post(`/api/mailboxes/${drafts.id}/messages`, bodyJSON);
    await open(drafts, res.message.id);
  }

  export const forward = async (drafts: Mailbox, mailbox: Mailbox, id: number) => {
    const message: FullMessage = await _get(`/api/mailboxes/${mailbox.id}/messages/${id}`);
    const body = createBody("fwd", message);
    const { html, text } = sanitize(body);

    const subject = `Fwd: ${message.subject.trim().replace(/^fw?d?:/i, "").trim()}`;

    const bodyJSON = createMessageBody({
      subject,
      html,
      text,
      reference: {
        mailbox: mailbox.id,
        id,
        action: "forward",
        attachments: true,
      }
    })
    const res: any = await _post(`/api/mailboxes/${drafts.id}/messages`, bodyJSON);
    await open(drafts, res.message.id);
  }

  export const open = async (mailbox: Mailbox, id: number) => {
    const tab = tabs.find(tab => tab.id === id);
    if(tab) {
      current = tab
    } else {
      const message: FullMessage = await _get(`/api/mailboxes/${mailbox.id}/messages/${id}`);

      const { html, text } = sanitize(message.html);

      const item: Draft = {
        key: Math.random(),
        id: message.id,
        mailbox: message.mailbox,
        bcc: message.bcc || [],
        cc: message.cc || [],
        to: message.to || [],
        subject: message.subject,
        html,
        text,
        reference: message.reference,
        files: message.files || [],
        [kShowBcc]: false,
        [kShowCc]: false,
        [kSent]: false
      }

      tabs = [item, ...tabs];
      current = item;
    }
  }
</script>

<style>
  .tabs {
    display: flex;
    flex-wrap: wrap-reverse;
    flex-direction: row-reverse;
    position: fixed;
    z-index: calc(var(--z-compose) + 1);
    bottom: 0;
    right: 2.5rem;
  }

  .tab-holder {
    width: 10rem;
    height: 2rem;
    margin: var(--space-2) var(--space-1) 0 var(--space-1);
  }

  .tab {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 10rem;
    height: 2rem;
    box-sizing: border-box;
    padding: 0 0 0 var(--space-2);
    border-radius: var(--radius) var(--radius) 0 0;
    background: #333; /* intentional dark compose chrome (white text), like the navbar */
    user-select: none;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #fff;
    font-size: 0.9rem;
    position: relative;
  }

  .tab-sender {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    opacity: 0;
    z-index: var(--z-below);
  }

  .tab-remove {
    display: flex;
    border-radius: var(--radius-sm);
    margin-inline-start: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 2rem;
    font-size: 1rem;
    padding: 0 var(--space-2) 0 var(--space-2);
    box-sizing: border-box;
  }

  .overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: var(--overlay-bg);
    z-index: var(--z-compose);

  }

</style>

{#if tabs.length}
  <div class="tabs">
    {#each tabs as tab (tab)}
      <div class="tab-holder" animate:flip={{duration: 250}}>
        {#if tab !== current}
          <div class="tab" transition:fade={{duration: 300}} on:click={event => event.ctrlKey ? removeTab(tab) : current = tab} on:auxclick={() => removeTab(tab)}>
            {$locale.New_message}
            <div class="btn-light tab-remove" on:click|stopPropagation={() => removeTab(tab)}>
              <Close />
              <Ripple />
            </div>
            <div class="tab-sender" in:crossin={{key: tab}} out:crossout={{key: tab}}></div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if current}
  <div class="overlay" transition:fade|local={{duration: 300}} on:click={() => current = null}></div>
  {#key current.key}
    <Window bind:current onMinimize={() => current = null} onRemove={() => removeTab(current)} />
  {/key}
{/if}
