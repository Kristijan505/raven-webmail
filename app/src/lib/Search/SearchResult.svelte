<script lang="ts" context="module">
  const from = (mailbox: Mailbox, message: Message, l: any): string => {
    if(mailbox.specialUse === "\\Drafts" || mailbox.specialUse === "\\Sent") {
      return `${l["To:"]} ${message.to[0]?.name || message.to[0]?.address || ""}`;
    }

    return message.from?.name || message.from?.address || "";
  }  

  import { toString } from "diacritic-regex";
  const diac = toString();
</script>

<script lang="ts">
  export let query: string;
  export let mailbox: Mailbox;
  export let message: Message;
  export let selection: Message[] = [];

  // When a row is deleted/moved, Svelte clears the bound `message` to undefined
  // while the row is still sliding out (transition outro). Reading props off that
  // undefined throws inside the flush and freezes the whole search list (dead
  // toolbar, broken select-all). Keep the last value so the outro keeps its
  // content and nothing reads off undefined (mirrors Mailbox/Message.svelte).
  let lastRow: Message;
  $: if (message) lastRow = message;
  $: row = message || lastRow;

  $: selected = row ? selection.some(m => m.mailbox === row.mailbox && m.id === row.id) : false

  const toggleSelection = () => {
    const v = selection.filter(m => !(m.mailbox === message.mailbox && m.id === message.id));
    if(selected) selection = v;
    else selection = [...v, message];
  }

  import Ripple from "$lib/Ripple.svelte";
  import type { Message, Mailbox } from "$lib/types";

  import NotSelected from "~icons/mdi/checkbox-blank-outline";
  import Selected from "~icons/mdi/checkbox-marked";
  import NotFlagged from "~icons/mdi/star-outline";
  import Flagged from "~icons/mdi/star";
  import Paperclip from "~icons/mdi/paperclip";
  
  import { action, isDrafts, mailboxName, messageDate, _put } from "$lib/util";
  import { locale } from "$lib/locale";
  import { _open } from "$lib/Compose/compose";
  const flag = action(async () => {
    message.flagged = !message.flagged;
    await _put(`/api/mailboxes/${mailbox.id}/messages/${message.id}/flag`, {
      value: message.flagged
    }).catch(e => {
      message.flagged = !message.flagged;
      throw e;
    })
  })

  const click = action(async (event: MouseEvent) => {
    if(isDrafts(mailbox)) {
      event.preventDefault();
      event.stopPropagation();
      await _open(mailbox, message.id);
    }
  })

  import regexEscape from "regex-escape";

  const highlight = (node: HTMLElement, query: string) => {

    const src = node.textContent;

    const update = (query: string) => {
      
      const words = query.split(/\s+/g);
      
      if(words.length === 0) {
        node.textContent = src;
        return;
      }

      const regex = new RegExp(words.map(word => diac(regexEscape(word))).join("|"), "ig");

      const html = src.replace(regex, (match => {
        const span = document.createElement("span");
        span.textContent = match;
        span.classList.add("highlight");
        return span.outerHTML;
      }))
      
      node.innerHTML = html;
    }

    update(query);
    
    return { update }
  }
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
    transition: var(btn-transition), color 200ms ease;
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

  .mailbox-subject-intro {
    flex: 6;
    display: flex;
    flex-direction: row;
    align-items: center;
    margin-inline-end: var(--space-4);
    margin-inline-start: var(--space-4);
  }

  .mailbox {
    flex: none;
    margin-inline-end: var(--space-2);
    padding: var(--space-2);
    font-size: 0.8rem;
    border-radius: 0.35rem;
    background: var(--surface-2);
    font-weight: 400;
  }

  .subject-intro {
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

    .mailbox-subject-intro {
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
    flex: 7;
    display: flex;
    align-items: center;
  }

  .message :global(.highlight) {
    background: var(--highlight-bg);
    color: var(--text);
  }
</style>

<a href="/mailbox/{mailbox.id}/message/{row.id}"
  class="na message"
  class:seen={row.seen}
  class:selected
  class:flagged={row.flagged}
  on:click={click}
>
  <div class="select cell-icon btn-dark" on:click|stopPropagation|preventDefault={toggleSelection}>
    {#if selected}
      <Selected />
    {:else}
      <NotSelected />
    {/if}
    <Ripple />
  </div>

  <div class="cell-icon btn-dark flag" on:click|stopPropagation|preventDefault={flag}>
    {#if row.flagged}
      <Flagged />
    {:else}
      <NotFlagged />
    {/if}
    <Ripple />
  </div>

  <div class="flex">
    <div class="from" use:highlight={query}>
      {from(mailbox, row, $locale)}
    </div>

    <div class="end">
      <div class="mailbox-subject-intro">
        <div class="mailbox">
          {mailboxName(mailbox, $locale)}
        </div>
        <div class="subject-intro">
          <span class="subject" use:highlight={query}>
            {row.subject || ""}
          </span>
          <span class="intro" use:highlight={query}>
            {row.intro || ""}
          </span>
        </div>
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