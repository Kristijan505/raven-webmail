<script lang="ts">
  import type { Mailbox as MBox, Messages } from "$lib/types";
  export let data: { mailbox: MBox; messages: Messages };

  // Local, mutable copy of the loaded data. Child components (Top / Message)
  // mutate `messages` and `mailbox` through `bind:` for optimistic updates
  // (delete, move, mark as seen...). We must NOT re-derive these from `data`
  // on every reactive pass: in Svelte 5 a `$: ({ mailbox, messages } = data)`
  // statement also depends on `mailbox`/`messages`, so each child mutation
  // re-runs it and overwrites the optimistic change with the stale server
  // value — making deletions appear only after a full page refresh.
  // Instead we only re-sync when SvelteKit actually delivers a fresh `data`
  // object (a real `load`/navigation), never on a child-driven mutation.
  let mailbox: MBox = data.mailbox;
  let messages: Messages = data.messages;
  let lastData = data;

  $: if (data !== lastData) {
    lastData = data;
    mailbox = data.mailbox;
    messages = data.messages;
  }

  import { mailboxName } from "$lib/util";
  import Mailbox from "$lib/Mailbox/Mailbox.svelte";
</script>

<svelte:head>
  <title>{mailbox.unseen ? `(${mailbox.unseen}) ` : ""}{mailboxName(mailbox)}</title>
</svelte:head>

{#key mailbox.id}
  <Mailbox bind:mailbox bind:messages />
{/key}
