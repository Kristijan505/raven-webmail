<script lang="ts">
  export let mailbox: Mailbox;
  export let messages: Messages;
  export let selection: Message[];
  export let scrolled = false;
  export let loadingMore: boolean;
  let clearMenuOpen = false;
  let clearOpen = false;

  import type { Mailbox, Messages, Message } from "$lib/types";

  import Refresh from "~icons/mdi/refresh";
  import Delete from "~icons/mdi/delete-outline";
  import MarkUnSeen from "~icons/mdi/email-outline";
  import MarkSeen from "~icons/mdi/email-open-outline";
  import MarkSpam from "~icons/mdi/alert-decagram-outline";
  import UnMarkSpam from "~icons/mdi/email-check-outline";
  import CheckAll from "~icons/mdi/checkbox-marked";
  import CheckNone from "~icons/mdi/checkbox-blank-outline";
  import CheckSome from "~icons/mdi/checkbox-intermediate";
  import Check from "~icons/mdi/check";
  import Ripple from "$lib/Ripple.svelte";
  import { tooltip, clickable } from "$lib/actions";
  import { fade } from "svelte/transition";
  import { action, isDrafts, isInbox, isJunk, isSent, isTrash, mailboxName, plural, _delete, _put } from "$lib/util";

  import MoveTo from "$lib/MoveTo.svelte";
  import { getContext } from "svelte";

  import type { DashContext } from "../Dashboard/Dashboard.svelte";
  import type { MailboxContext } from "../Mailbox/Mailbox.svelte";
  import TabTop from "$lib/Tab/TabTop.svelte";
  import Dialog from "$lib/Dialog.svelte";
  import DotsVertical from "~icons/mdi/dots-vertical";
  import PortalPopup from "$lib/PortalPopup.svelte";
  import Menu from "$lib/Menu/Menu.svelte";
  import MenuItem from "$lib/Menu/MenuItem.svelte";
import { _error, _message } from "$lib/Notify/notify";
import { locale } from "$lib/locale";
  
  const { mailboxes } = getContext("dash") as DashContext;
  const { prev, next } = getContext("mailbox") as MailboxContext;

  let reloadTimes = 0;
  const reload = () => {
    reloadTimes++;
    prev();
  }

  const markAsSeen = action(async (v: boolean) => {
    const ids = selection.map(s => s.id);

    await _put(`/api/mailboxes/${mailbox.id}/messages`, {
      message: ids.join(","),
      seen: v
    })
  
    for(const item of selection) {
      item.seen = v;
    }

    messages = {...messages};
    selection = [...selection]; 
  })

  // These lookups used to assert non-null. They are the ONLY route to spam and delete
  // now that the move menu no longer lists Spam and Trash, so an account missing one of
  // those folders would leave the button dead with a generic failure. Say what is wrong
  // instead — action() surfaces a thrown message to the user.
  const spam = action(async () => {
    const to = isJunk(mailbox) ? $mailboxes.find(isInbox) : $mailboxes.find(isJunk);
    if(!to) throw new Error($locale.Folder_not_available);
    await move(to);
  })

  const del = action(async () => {
    // Junk deliberately NOT permanent here. The tooltip in Junk reads "Delete", not
    // "Delete permanently" (that wording is reserved for Trash), and Clear-folder in
    // Junk moves everything to Trash rather than erasing it — so a single Delete that
    // erased outright contradicted both its own label and the button beside it. It is
    // also the only non-destructive way out of Junk now that the move menu leaves
    // Trash to the dedicated button. Permanent deletion stays where the label says so.
    if(isTrash(mailbox)) {
      await Promise.all(selection.map(async item => {
        await _delete(`/api/mailboxes/${mailbox.id}/messages/${item.id}`);
      }))
      removeSelection();
    } else {
      const trash = $mailboxes.find(isTrash);
      if(!trash) throw new Error($locale.Folder_not_available);
      move(trash);
    }
  })

  const clear = action(async () => {
    if(isTrash(mailbox) || isDrafts(mailbox)) {
      _delete(`/api/mailboxes/${mailbox.id}/messages`)
        .then(() => {
          _message($locale.notifier.All_messages_deleted);
        }).catch(e =>  {
          _error(e?.message)
        })
    } else {
      const trash = $mailboxes.find(isTrash);
      if(!trash) throw new Error($locale.Folder_not_available);
      _put(`/api/mailboxes/${mailbox.id}/messages`, {
        message: `1:${Number.MAX_SAFE_INTEGER}`,
        moveTo: trash.id,
      }).then(() => {
        _message("All messages deleted");
      }).catch(e => {
        _error(e?.message);
      })
    }
    clearOpen = false;
    if(mailbox.total > 50) _message($locale.notifier.Deleting_process);
  })

  const toggleAll = () => {
    if(selection.length === messages.results.length) {
      selection = [];
    } else {
      selection = messages.results.slice();
    }
  }

  const removeSelection = () => {
    const ids = selection.map(item => item.id);
    
    messages = {
      ...messages,
      results: messages.results.filter(item => !ids.includes(item.id))
    }

    if(messages.results.length < 15 && messages.nextCursor) {
      loadingMore = true;
      setTimeout(next, 10);
    }  
    
    selection = [];
  }

  const move = action(async (to: Mailbox) => {
    if(mailbox.id === to.id) return;
    if(selection.length === 0) return;
    await _put(`/api/mailboxes/${mailbox.id}/messages`, {
      message: selection.map(m => m.id).join(","),
      moveTo: to.id,
    })
    removeSelection();
  })
</script>

<style>
  .only-when-selection {
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .reload-inner {
    display: flex;
    transition: transform var(--duration) ease;
  }

  .select {
    margin-inline-start: 0.525rem;
  }

  @media screen and (max-width: 650px) {
    .select {
      margin-inline-start: 0.1rem;
    }
  }

  .selection-info {
    display: flex;
    flex: none;
    flex-direction: row-reverse;
    align-items: center;
    margin-inline-start: auto;
    margin-inline-end: var(--space-4);
    background: var(--selected-bg);
    padding: 0.4em 0.5em;
    border-radius: 100px;
    color: var(--text);
  }

  .selection-info > :global(svg) {
    font-size: 1.1em;
  }

  .selection-info > span {
    font-size: 0.8em;
    margin: 0 0.5em;
  }

  .clear-body {
    display: flex;
    flex-direction: column;
  }

  .clear-label {
    margin-bottom: var(--space-6);
  }

  .clear-confirm {
    margin-inline-start: auto;
  }

  .clear-btn-wrap {
    position: relative;
  }

  .clear-anchor {
    position: absolute;
    bottom: 0;
    left: 0;
  }

  .total {
    margin-inline-start: auto;
    margin-inline-end: var(--space-4);
    font-size: 0.8rem;
    padding: var(--space-2) var(--space-4);
    border-radius: 100px;
    background: var(--surface-2);
    color: var(--text-muted);
  }
</style>

<TabTop {scrolled}>
 <div class="action-group select">
    <div class="action btn-dark" use:clickable on:click={toggleAll}>
      {#if selection.length === 0}
        <CheckNone />
      {:else if selection.length === messages.results.length}
        <CheckAll />
      {:else}
        <CheckSome />
      {/if}
      <Ripple />
    </div>

    <div class="action btn-dark reload" use:clickable use:tooltip={$locale.Reload} on:click={reload}>
      <div class="reload-inner" style="transform: rotate({360 * reloadTimes}deg);">
        <Refresh />
      </div>
      <Ripple />
    </div>
  </div>

  {#if selection.length === 0 && messages.results.length !== 0}
    <div class="action-group" in:fade|local={{ duration: 200 }}>
      <div class="clear-btn-wrap">
        <div class="action btn-dark" use:clickable class:hover={clearMenuOpen} on:click={() => clearMenuOpen = true}>
          <DotsVertical />
          <Ripple />
        </div>
        <div class="clear-anchor">
          <PortalPopup anchor="top-left" bind:open={clearMenuOpen}>
            <Menu>
              <MenuItem icon={Delete} on:click={() => clearOpen = true}>{$locale.Delete_all_messages}</MenuItem>
            </Menu>
          </PortalPopup>
        </div>
      </div> 
    </div>

    <div class="total">
      {mailbox.total} {plural(mailbox.total, $locale.message_count)}
    </div>
  {:else if selection.length !== 0}
    <div class="only-when-selection" in:fade|local={{ duration: 200 }}>
      <div class="action-group">
        {#if !selection.every(m => m.seen)}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Mark_as_seen} on:click={() => markAsSeen(true)}>
            <MarkSeen />
            <Ripple />
          </div>
        {:else}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Mark_as_not_seen} on:click={() => markAsSeen(false)}>
            <MarkUnSeen />
            <Ripple />
          </div>
        {/if}

        {#if isJunk(mailbox)}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.This_is_not_spam} on:click={spam}> 
            <UnMarkSpam />
            <Ripple />
          </div>
        {:else if !isDrafts(mailbox) && !isSent(mailbox) && !isTrash(mailbox)}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Mark_as_spam} on:click={spam}> 
            <MarkSpam />
            <Ripple />
          </div>
        {/if}

        <div class="action btn-dark" use:clickable use:tooltip={isTrash(mailbox) ? $locale.Delete_permanently : isDrafts(mailbox) ? $locale.Discard_drafts : $locale.Delete} on:click={del}>
          <Delete />
          <Ripple />
        </div>
      </div>

      <div class="action-group">
        <MoveTo {mailbox} messages={selection} onMove={move} />
      </div>

      <div class="selection-info">
        <Check />
        <span>
          {selection.length} {plural(selection.length, $locale.message_count)}
        </span>
      </div>
    </div>
  {/if}
</TabTop>

{#if clearOpen}
  <Dialog title="{$locale.Delete_all_messages} {$locale.of} {mailboxName(mailbox, $locale)}" width="550px" onClose={() => clearOpen = false}>
    <div class="clear-body">
      <div class="clear-label">
        {$locale.This_action_will_delete_all_messages_in_the_folder}
      </div>
      <button class="clear-confirm btn-light btn-primary elev2" on:click={clear}>
        {$locale.Delete_all_messages}
      </button>
    </div>
  </Dialog>
{/if}