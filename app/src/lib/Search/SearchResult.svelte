<script lang="ts" context="module">
  // `mailbox` is optional here: search returns hits from every folder, and the lookup
  // that resolves the id to a Mailbox can miss — a stale index pointing at a deleted
  // folder, or results arriving before the mailbox list has loaded. It used to throw
  // on `mailbox.specialUse` in that window and take the whole search view down with it.
  // `to` is optional too: WildDuck omits it on a draft with no recipients yet.
  const from = (mailbox: Mailbox | undefined, message: Message, l: any): string => {
    if(mailbox?.specialUse === "\\Drafts" || mailbox?.specialUse === "\\Sent") {
      return `${l["To:"]} ${message.to?.[0]?.name || message.to?.[0]?.address || ""}`;
    }

    return message.from?.name || message.from?.address || "";
  }

  import { toString } from "diacritic-regex";
  const diac = toString();
</script>

<script lang="ts">
  export let query: string;
  export let mailbox: Mailbox | undefined;
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

  // Handlers read `row`, not `message`: during a keyed-each outro `message` can be
  // undefined while the row is still on screen and clickable, and a throw there freezes
  // the Svelte scheduler — the whole search list goes inert until a reload. Identity
  // comes off `row` too (`row.mailbox` is the folder id), so nothing here needs the
  // possibly-missing `mailbox` object.
  const toggleSelection = () => {
    if(!row) return;
    const v = selection.filter(m => !(m.mailbox === row.mailbox && m.id === row.id));
    if(selected) selection = v;
    else selection = [...v, row];
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
    if(!row) return;
    const value = !row.flagged;
    row.flagged = value;
    await _put(`/api/mailboxes/${row.mailbox}/messages/${row.id}/flag`, {
      value
    }).catch(e => {
      row.flagged = !value;
      throw e;
    })
  })

  const click = action(async (event: MouseEvent) => {
    if(!row) return;
    // Opening a draft in the composer needs the real Mailbox object, so this path is
    // simply skipped when the folder could not be resolved — the row still navigates.
    if(mailbox && isDrafts(mailbox)) {
      event.preventDefault();
      event.stopPropagation();
      await _open(mailbox, row.id);
    }
  })

  import regexEscape from "regex-escape";

  // Highlight matches by rebuilding the node from text nodes + <span> elements via
  // the DOM API. The row text (from / subject / intro) is attacker-controlled email
  // content, so it must NEVER be assigned through innerHTML: the previous version
  // did `node.innerHTML = html`, which parsed any unmatched markup in that text as
  // real HTML/CSS. Here every character stays literal text — matches land via
  // span.textContent, non-matches via createTextNode — so nothing is ever parsed.
  const highlight = (node: HTMLElement, query: string) => {

    const src = node.textContent ?? "";

    const render = (query: string) => {

      const words = query.split(/\s+/g).filter(Boolean);

      if (words.length === 0) {
        node.textContent = src; // no usable search terms -> restore plain text
        return;
      }

      const regex = new RegExp(words.map(word => diac(regexEscape(word))).join("|"), "ig");

      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of src.matchAll(regex)) {
        const matched = m[0];
        if (!matched) continue; // guard against a zero-length match stalling in place
        const start = m.index ?? 0;
        if (start > last) frag.appendChild(document.createTextNode(src.slice(last, start)));
        const span = document.createElement("span");
        span.className = "highlight";
        span.textContent = matched;
        frag.appendChild(span);
        last = start + matched.length;
      }
      if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));

      node.replaceChildren(frag);
    }

    render(query);

    return { update: render }
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

<!-- `row.mailbox` rather than `mailbox.id`: identical value, but it does not depend on
     the folder lookup having succeeded, so the link still works for a hit whose
     Mailbox object is missing. -->
<a href="/mailbox/{row.mailbox}/message/{row.id}"
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
          {mailbox ? mailboxName(mailbox, $locale) : ""}
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