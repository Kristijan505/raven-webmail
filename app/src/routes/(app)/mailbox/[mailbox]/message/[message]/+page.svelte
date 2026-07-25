<script lang="ts">
  import type { FullMessage, Mailbox } from "$lib/types";
  export let data: { mailbox: Mailbox; message: FullMessage };
  let mailbox: Mailbox;
  let message: FullMessage;

  $: ({ mailbox, message } = data);
  
  import { action, isDrafts, isInbox, isJunk, isSent, isTrash, mailboxName, _delete, _put } from "$lib/util";
  
  import { messageHTML, tooltip, clickable } from "$lib/actions";
  import TabTop from "$lib/Tab/TabTop.svelte";
  
  import Delete from "~icons/mdi/delete-outline";
  import MarkUnseen from "~icons/mdi/email-outline";
  import MarkSeen from "~icons/mdi/email-open-outline";
  import MarkSpam from "~icons/mdi/alert-decagram-outline";
  import UnMarkSpam from "~icons/mdi/email-check-outline";
  import Resend from "~icons/mdi/email-send-outline";
  import Reply from "~icons/mdi/email-receive-outline";
  import GoBack from "~icons/mdi/arrow-left";
  import Ripple from "$lib/Ripple.svelte";
  import { goto } from "$app/navigation";
  import { getContext } from "svelte";
  import MoveTo from "$lib/MoveTo.svelte";
  import MessageSecurity from "$lib/Message/MessageSecurity.svelte";

  $: html = message.html?.join("").trim();

  let loadRemote = false;
  let shownKey = `${data.message.mailbox}-${data.message.id}`;
  // Reset the "load remote images" opt-in when switching to another message.
  $: {
    const key = `${message.mailbox}-${message.id}`;
    if (key !== shownKey) { shownKey = key; loadRemote = false; }
  }
  // Detect every remote vector messageHTML neutralizes — otherwise the warning +
  // "Load images" button won't render while the images are still hidden, leaving
  // them broken with no way to opt in. Covers <img>/<source> src or srcset to an
  // http(s)/protocol-relative URL, CSS url() backgrounds, and @import.
  $: hasRemoteImages = (() => {
    const h = html || "";
    return /<(?:img|source)\b[^>]*\b(?:src|srcset)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(h)
      || /\bbackground\s*=\s*["']?\s*(?:https?:)?\/\//i.test(h)
      || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(h)
      || /@import\b/i.test(h);
  })();

  let scrolled = false;
  const onScroll = (event: Event) => {
    let target = event.target as HTMLElement;
    scrolled = target.scrollTop !== 0;
  }

  import type { DashContext } from "$lib/Dashboard/Dashboard.svelte";
  import Attachments from "$lib/Attachments.svelte";
  import { fly } from "svelte/transition";
  import { _forward, _replyAll } from "$lib/Compose/compose";
  import { locale } from "$lib/locale";
  const { user, mailboxes } = getContext("dash") as DashContext;

  const seen = action(async () => {
    try {
      message.seen = !message.seen;
      await _put(`/api/mailboxes/${mailbox.id}/messages`, {
        message: String(message.id),
        seen: message.seen,
      })
    } catch(e) {
      message.seen = !message.seen;
      throw e;
    }
  })

  // Same reasoning as Top.svelte: with Spam and Trash gone from the move menu, these
  // buttons are the only route, so a missing folder has to be reported, not asserted.
  const spam = action(async () => {
    const to = isJunk(mailbox) ? $mailboxes.find(isInbox) : $mailboxes.find(isJunk);
    if(!to) throw new Error($locale.Folder_not_available);
    await move(to);
  })

  const del = action(async () => {
    if(isTrash(mailbox) || isJunk(mailbox)) {
      await _delete(`/api/mailboxes/${mailbox.id}/messages/${message.id}`);
      await goto(`/mailbox/${mailbox.id}`);
    } else {
      const trash = $mailboxes.find(isTrash);
      if(!trash) throw new Error($locale.Folder_not_available);
      await move(trash);
    }
  })

  const move = action(async (to: Mailbox) => {
    if(mailbox.id === to.id) return;
    await _put(`/api/mailboxes/${mailbox.id}/messages`, {
      message: String(message.id),
      moveTo: to.id,
    })
    await goto(`/mailbox/${mailbox.id}`);
  })

  const reply = action(async () => {
    const drafts = $mailboxes.find(isDrafts)!;
    await _replyAll($user, drafts, mailbox, message.id);
  })

  const forward = action(async () => {
    const drafts = $mailboxes.find(isDrafts)!;
    await _forward(drafts, mailbox, message.id);
  })
</script>

<style>

  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .first-action {
    margin-inline-start: var(--space-2);
  }

  .message {
    flex: 1;
    overflow: auto;
  }

  .body {
    padding: var(--space-8);
    max-width: 64rem;
    margin-inline: auto;
    box-sizing: border-box;
  }

  .text {
    white-space: pre-wrap;
  }

  .detail {
    padding: var(--space-8);
    max-width: 64rem;
    margin-inline: auto;
    box-sizing: border-box;
  }

  .subject {
    font-size: 1.65rem;
    font-weight: 500;
    margin-bottom: var(--space-5);
  }

  .info {
    font-size: 1rem;
  }

  .info > div {
    margin-bottom: var(--space-3);
  }

  .from-name, .from-only-address, .to-address {
    font-weight: 500;
  }

  .remote-images {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    background: var(--warning-bg);
    border: 1px solid var(--warning-border);
    border-radius: 6px;
    padding: 0.6rem var(--space-4);
    margin-bottom: var(--space-4);
    font-size: 0.9rem;
    color: var(--warning-text);
  }

  .remote-images > button {
    margin-inline-start: auto;
    flex: none;
  }

  /*
  .html {
    display: flex;
  }

  .html > :global(iframe) {
    flex: 1;
    border: none;
  }
  */
</style>

<svelte:head>
  <title>{message.subject}</title>
</svelte:head>

{#key `${message.mailbox}-${message.id}`}
  <div class="page">

    <TabTop {scrolled}>
      <div class="action-group first-action">
        <a class="na action btn-dark" href="/mailbox/{mailbox.id}" use:tooltip={`${$locale.Back_to} ${mailboxName(mailbox, $locale)}`}>
          <GoBack />
          <Ripple />
        </a>
      </div>

      <div class="action-group">
        <div class="action btn-dark"
          use:clickable use:tooltip={message.seen ? $locale.Mark_as_not_seen : $locale.Mark_as_seen}
          on:click={seen}
        >
          {#if message.seen}
            <MarkUnseen />
          {:else}
            <MarkSeen />
          {/if}
          <Ripple />
        </div>

        {#if isJunk(mailbox)}
          <div 
            class="action btn-dark" 
            use:clickable use:tooltip={$locale.This_is_not_spam}
            on:click={spam}  
          >
            <UnMarkSpam />
            <Ripple />
          </div>
        {:else if !isDrafts(mailbox) && !isSent(mailbox) && !isTrash(mailbox)}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Mark_as_spam}
            on:click={spam}
          >
            <MarkSpam />
            <Ripple />
          </div>
        {/if}

        <div class="action btn-dark" use:clickable use:tooltip={
            isTrash(mailbox) ? $locale.Delete_permanently :
            isDrafts(mailbox) ? $locale.Discard_drafts :
            $locale.Delete}
          on:click={del}  
        >
          <Delete />
          <Ripple />
        </div>
      </div>

      <div class="action-group">

        <div class="action-group">
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Forward} on:click={forward}>
            <Resend />
            <Ripple />
          </div>

          {#if !isDrafts(mailbox) && !isSent(mailbox)}
            <div class="action btn-dark" use:clickable use:tooltip={$locale.Reply} on:click={reply}>
              <Reply />
              <Ripple />
            </div>
          {/if}
        </div>
      </div>

      <MoveTo {mailbox} messages={[message]} onMove={move} />
        
      <Attachments {mailbox} {message} />

    </TabTop>

    <div class="message" on:scroll={onScroll} in:fly={{duration: 150, x: -20}}>

      <div class="detail">
        <div class="subject">{message.subject}</div>
        <div class="info">
          {#if message.from}
            <div class="from">
              {#if message.from.name}
                {$locale["From:"]} <span class="from-name">{message.from.name}</span> {"<"}{message.from.address}{">"}
              {:else}
                {$locale["From:"]} <span class="from-only-address">{message.from.address}</span>
              {/if}
            </div>
          {/if}
            
          {#if message.to}
            <div class="to">
              {$locale["To:"]}
              {#each message.to as to, i}
                {#if i !== 0}, {/if}
                <span class="to-address">{to.address}</span>
              {/each}
            </div>
          {/if}
            
          {#if message.date}
            <div class="date">
              {$locale["Sent:"]} {new Date(message.date).toLocaleString()}
            </div>
          {/if}

          <!-- Only inbound mail carries SPF/DKIM/DMARC results. Sent/Drafts (and
               any message without verificationResults) would otherwise render as
               "Sender NOT verified", making the user's own mail look spoofed. -->
          {#if message.verificationResults}
            <MessageSecurity {message} {mailbox} />
          {/if}
        </div>
      </div>

      <div class="body">
        {#if !html}
          <div class="text">
            {message.text || ""}
          </div>
        {:else}
          {#if hasRemoteImages && !loadRemote}
            <div class="remote-images">
              <span>{$locale.Remote_images_hidden}</span>
              <button class="btn-light" on:click={() => loadRemote = true}>{$locale.Load_images}</button>
            </div>
          {/if}
          {#key loadRemote}
            <div class="html" use:messageHTML={{ html, message, loadRemote }}></div>
          {/key}
        {/if}
      </div>
    </div>
  </div>

{/key}
