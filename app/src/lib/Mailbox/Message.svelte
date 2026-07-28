<script lang="ts" context="module">
  // `to` is optional on the wire — a draft saved before any recipient was typed comes
  // back without it — and this runs for every row in Drafts/Sent. Indexing it directly
  // threw there, and a throw in a row render freezes the whole list.
  const from = (mailbox: Mailbox, message: Message, l: any): string => {
    if(mailbox.specialUse === "\\Drafts" || mailbox.specialUse === "\\Sent") {
      return `${l["To:"]} ${message.to?.[0]?.name || message.to?.[0]?.address || ""}`;
    }

    return message.from?.name || message.from?.address || "";
  }
</script>

<script lang="ts">
  export let mailbox: Mailbox;
  export let message: Message;
  export let selection: Message[];

  // When a row is deleted, Svelte clears the bound `message` to undefined while
  // the row is still sliding out (transition outro). Reading props off that
  // undefined threw inside the flush and froze the whole list (dead toolbar,
  // broken select-all). Keep the last value so the outro keeps its content and
  // nothing reads off undefined.
  let lastRow: Message;
  $: if (message) lastRow = message;
  $: row = message || lastRow;

  $: selected = row ? selection.some(m => m.id === row.id) : false

  // Handlers read `row`, not `message`, for the same reason the template does: during
  // a keyed-each outro `message` can be undefined while the row is still on screen and
  // still clickable. Dereferencing it there throws inside the Svelte flush, which does
  // not just lose the click — it freezes the scheduler, leaving the whole list inert
  // (dead toolbar, broken select-all) until a reload.
  const toggleSelection = () => {
    if(!row) return;
    const v = selection.filter(m => m.id !== row.id);
    if(selected) selection = v;
    else selection = [...v, row];
  }

  import Ripple from "$lib/Ripple.svelte";
  import { clickable } from "$lib/actions";
  import type { Message, Mailbox } from "$lib/types";

  import NotSelected from "~icons/mdi/checkbox-blank-outline";
  import Selected from "~icons/mdi/checkbox-marked";
  import NotFlagged from "~icons/mdi/star-outline";
  import Flagged from "~icons/mdi/star";
  import Paperclip from "~icons/mdi/paperclip";
  
  import { action, isDrafts, messageDate, _put } from "$lib/util";
  import { locale } from "$lib/locale";
  import { _open } from "$lib/Compose/compose";
  const flag = action(async () => {
    if(!row) return;
    const value = !row.flagged;
    row.flagged = value;
    await _put(`/api/mailboxes/${mailbox.id}/messages/${row.id}/flag`, {
      value
    }).catch(e => {
      row.flagged = !value;
      throw e;
    })
  })

  const click = action(async (event: MouseEvent) => {
    if(!row) return;
    if(isDrafts(mailbox)) {
      event.preventDefault();
      event.stopPropagation();
      await _open(mailbox, row.id);
    }
  })
</script>

<style>
  .message {
    border-bottom: var(--border) 1px solid;
    display: flex;
    flex-direction: row;
    align-items: center;
    font-size: 0.95rem;
  }

  .message:not(.seen) {
    font-weight: 600;
  }

  .cell-icon {
    box-sizing: border-box;
    border-radius: 100px;
    font-size: 1.25rem;
    display: flex;
    height: 3rem;
    width: 3rem;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .cell-icon:hover {
    z-index: var(--z-base);
  }

  .cell-icon + .cell-icon {
    margin-inline-start: calc(-1 * var(--space-3));
  }

  .cell-icon:first-child {
    margin-inline-start: var(--space-2);
  }

  .selected {
    background-color: var(--selected-bg);
    border-bottom-color: var(--selected-border);
  }

  .flag {
    transition: var(--btn-transition), color 200ms ease;
  }

  .flagged > .flag {
    color: var(--flag-color);
  }

  .from {
    flex: 2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .subject-intro {
    flex: 6;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-inline-end: var(--space-4);
    margin-inline-start: var(--space-4);
  }

  .subject {
    color: var(--text);
  }

  .intro {
    margin-inline-start: var(--space-4);
  }

  .date {
    flex: none;
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-inline-end: var(--space-4);
  }

  .flex {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex: 1;
  }

  .date-attachments {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex: none;
  }

  .attachments {
    display: flex;
    font-size: 1.25rem;
    margin-inline-end: var(--space-4);
    justify-self: flex-end;
    color: var(--text-muted);
  }

  @media screen and (max-width: 650px) {
    .flex {
      flex-direction: column;
      align-items: flex-start;
      padding: var(--space-3) 0;
    }

    .end {
      flex-direction: column;
      width: 100%;
    }
    
    .subject-intro {
      margin-top: var(--space-2);
      margin-inline-start: 0;
      width: calc(100% - 1rem);
    }

    .date {
      margin-top: var(--space-2);
    }

    .select {
      margin-inline-start: 0 !important;
    }

    .date-attachments {
      align-self: stretch;
    }

    .attachments {
      margin-inline-start: auto;
      margin-top: var(--space-2);
      margin-bottom: calc(-1 * var(--space-2));
    }
  }

  .end {
    display: flex;
    align-items: center;
    flex: 7;
  }
</style>

<a href="/mailbox/{mailbox.id}/message/{row.id}"
  class="na message"
  class:seen={row.seen}
  class:selected
  class:flagged={row.flagged}
  on:click={click}
>
  <div class="select cell-icon btn-dark" use:clickable on:click|stopPropagation|preventDefault={toggleSelection}>
    {#if selected}
      <Selected />
    {:else}
      <NotSelected />
    {/if}
    <Ripple />
  </div>

  <div class="cell-icon btn-dark flag" use:clickable on:click|stopPropagation|preventDefault={flag}>
    {#if row.flagged}
      <Flagged />
    {:else}
      <NotFlagged />
    {/if}
    <Ripple />
  </div>

  <div class="flex">
    <div class="from">
      {from(mailbox, row, $locale)}
    </div>

    <div class="end">
      <div class="subject-intro">
        <span class="subject">
          {row.subject || ""}
        </span>
        <span class="intro">
          {row.intro || ""}
        </span>
      </div>

      <div class="date-attachments">
        <div class="date">
          {messageDate(row.date, $locale)}
        </div>

        {#if row.attachments}
          <div class="attachments">
            <Paperclip />
          </div>
        {/if}
      </div>
    </div>
  </div>
</a>