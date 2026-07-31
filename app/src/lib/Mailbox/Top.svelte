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
  import { action, isDrafts, isInbox, isJunk, isSent, isTrash, mailboxName, plural, _delete, _get, _put } from "$lib/util";
  import { activeDirection, direction, mixesDirections, toggleDirection } from "$lib/direction";
  import { UNIFIED_IDS, isUnifiedMailbox, unifiedTotals } from "$lib/unified";
  import Down from "~icons/mdi/tray-arrow-down";
  import Up from "~icons/mdi/tray-arrow-up";

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

  $: unified = isUnifiedMailbox(mailbox);

  // A unified selection can span accounts. Trash/spam go through the unified bulk
  // endpoint (each message's OWN account's folder is resolved server-side). MoveTo
  // appears only when the whole selection lives in one account — Kristijan's call —
  // with that account's folders fetched on demand.
  $: selAccountId = unified && selection.length && selection.every(m => m.account?.id && m.account.id === selection[0].account?.id)
    ? selection[0].account?.id ?? null
    : null;

  let unifiedFolders: Mailbox[] | null = null;
  let unifiedFoldersFor: string | null = null;
  $: if (unified) syncUnifiedFolders(selAccountId);
  const syncUnifiedFolders = async (acc: string | null) => {
    if (!acc) { unifiedFolders = null; unifiedFoldersFor = null; return; }
    if (unifiedFoldersFor === acc) return;
    unifiedFoldersFor = acc;
    const json = await _get(`/api/mailboxes?account=${encodeURIComponent(acc)}`).catch(() => null);
    if (unifiedFoldersFor !== acc) return; // superseded by a newer selection
    unifiedFolders = json?.results ?? null;
  };

  // The REAL source folder of the selection: a single-account selection in a unified
  // view shares one mailbox (that account's INBOX or Sent), and handing that to the
  // move menu is what lets the ordinary moveDestinations rules apply unchanged.
  $: unifiedSource = unified && selAccountId && unifiedFolders
    ? unifiedFolders.find(b => b.id === (selection[0]?.mailbox ?? "")) ?? null
    : null;

  const unifiedBulk = action(async (act: "trash" | "spam") => {
    await _put("/api/unified/messages", {
      action: act,
      items: selection.map(m => ({ mailbox: m.mailbox ?? mailbox.id, message: m.id })),
    });
    removeSelection();
  });

  const moveUnified = action(async (to: Mailbox) => {
    if (selection.length === 0) return;
    // One source mailbox (see unifiedSource), one bulk PUT; the server checks the
    // destination belongs to the same account as the source.
    await _put(`/api/mailboxes/${selection[0].mailbox}/messages`, {
      message: selection.map(m => m.id).join(","),
      moveTo: to.id,
    });
    removeSelection();
  });

  let reloadTimes = 0;
  const reload = () => {
    reloadTimes++;
    prev();
  }

  const markAsSeen = action(async (v: boolean) => {
    // Grouped by SOURCE mailbox: in the unified views the selection spans
    // accounts, and each per-mailbox bulk PUT binds to that mailbox's own account
    // on the server. A single-mailbox list degenerates to exactly the old request.
    const groups = new Map<string, number[]>();
    for (const item of selection) {
      const box = item.mailbox ?? mailbox.id;
      groups.set(box, [...(groups.get(box) ?? []), item.id]);
    }
    await Promise.all([...groups].map(([box, ids]) =>
      _put(`/api/mailboxes/${box}/messages`, { message: ids.join(","), seen: v })));
  
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
    // Keyed by (mailbox, id): uids collide across accounts in the unified views,
    // and a plain id filter would take innocent rows down with the selected ones.
    const keys = new Set(selection.map(item => `${item.mailbox ?? mailbox.id}:${item.id}`));
    
    // The count follows the rows. Under a direction filter it is the count on display,
    // and the SSE counters only ever refresh the folder's own total.
    const results = messages.results.filter(item => !keys.has(`${item.mailbox ?? mailbox.id}:${item.id}`));
    messages = {
      ...messages,
      results,
      total: Math.max(0, messages.total - (messages.results.length - results.length)),
    }

    if(messages.results.length < 15 && messages.nextCursor) {
      loadingMore = true;
      setTimeout(next, 10);
    }  
    
    selection = [];
  }

  // While a direction filter is on, the folder's own total describes rows that are not
  // being shown — a folder of 100 with 10 outgoing would read "100 messages" above a
  // list of 10. The filtered listing reports its own total, so use that one; unfiltered,
  // mailbox.total is the live figure the SSE counters keep up to date.
  // A unified view has no direction filter, and its synthetic mailbox.total was a
  // snapshot from page load — stale after load-more, after new mail, and after an
  // EXPUNGE of a row that was never on screen (nothing on the list matches, so nothing
  // refetches). The live per-mailbox counters know all three.
  $: shownTotal = activeDirection(mailbox, $direction) ? messages.total
    : isUnifiedMailbox(mailbox) ? ($unifiedTotals[mailbox.id] ?? mailbox.total)
    : mailbox.total;

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

  /* Direction chips carry the `action` class so TabTop sizes them exactly like every
     other toolbar button — font-size, padding and the round hit area all come from
     there. Styling them separately is what made the active one read as a stretched pill
     instead of a circle: the icon fell back to the surrounding font size while the fill
     traced a box that no longer matched its neighbours.

     Only the state is added here. A filter that is on has to be visible without
     hovering, otherwise a folder just looks half empty. */
  .chip {
    color: var(--text-muted);
  }

  .chip.on {
    background: var(--red);
    color: #fff;
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

    {#if mixesDirections(mailbox)}
      <!-- Only where a folder actually holds both. The filter runs on the server, so a
           page stays a full page and the count describes what is shown. -->
      <!-- Icon-only and stateful, so both have to be spoken as well as drawn: the tooltip
           only appears on hover, and `class:on` is colour. clickable() sets the name,
           aria-pressed carries the state. -->
      <div class="action chip btn-dark" class:on={$direction === "in"} use:clickable={$locale.Received_only}
        aria-pressed={$direction === "in"}
        use:tooltip={$locale.Received_only} on:click={() => toggleDirection("in")}>
        <Down />
        <Ripple />
      </div>
      <div class="action chip btn-dark" class:on={$direction === "out"} use:clickable={$locale.Sent_only}
        aria-pressed={$direction === "out"}
        use:tooltip={$locale.Sent_only} on:click={() => toggleDirection("out")}>
        <Up />
        <Ripple />
      </div>
    {/if}

    <div class="action btn-dark reload" use:clickable use:tooltip={$locale.Reload} on:click={reload}>
      <div class="reload-inner" style="transform: rotate({360 * reloadTimes}deg);">
        <Refresh />
      </div>
      <Ripple />
    </div>
  </div>

  {#if selection.length === 0 && messages.results.length !== 0}
    <div class="action-group" in:fade|local={{ duration: 200 }}>
      {#if !unified}
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
      {/if} 
    </div>

    <div class="total">
      {shownTotal} {plural(shownTotal, $locale.message_count)}
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
        {:else if unified && mailbox.id === UNIFIED_IDS.inbox}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Mark_as_spam} on:click={() => unifiedBulk("spam")}>
            <MarkSpam />
            <Ripple />
          </div>
        {:else if !unified && !isDrafts(mailbox) && !isSent(mailbox) && !isTrash(mailbox)}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Mark_as_spam} on:click={spam}> 
            <MarkSpam />
            <Ripple />
          </div>
        {/if}

        {#if unified}
          <div class="action btn-dark" use:clickable use:tooltip={$locale.Delete} on:click={() => unifiedBulk("trash")}>
            <Delete />
            <Ripple />
          </div>
        {:else}
          <div class="action btn-dark" use:clickable use:tooltip={isTrash(mailbox) ? $locale.Delete_permanently : isDrafts(mailbox) ? $locale.Discard_drafts : $locale.Delete} on:click={del}>
            <Delete />
            <Ripple />
          </div>
        {/if}
      </div>

      {#if !unified}
        <div class="action-group">
          <MoveTo {mailbox} messages={selection} onMove={move} />
        </div>
      {:else if unifiedSource && unifiedFolders}
        <div class="action-group">
          <MoveTo mailbox={unifiedSource} mailboxesOverride={unifiedFolders} messages={selection} onMove={moveUnified} />
        </div>
      {/if}

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