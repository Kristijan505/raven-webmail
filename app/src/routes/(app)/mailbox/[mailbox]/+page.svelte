<script lang="ts">
  import type { Mailbox as MBox, Messages } from "$lib/types";
  export let data: { mailbox: MBox; messages: Messages };
  let mailbox: MBox;
  let messages: Messages;
  $: ({ mailbox, messages } = data);
  
  import { mailboxName } from "$lib/util";
  import Mailbox from "$lib/Mailbox/Mailbox.svelte";
</script>

<svelte:head>
  <title>{mailbox.unseen ? `(${mailbox.unseen}) ` : ""}{mailboxName(mailbox)}</title>
</svelte:head>

{#key mailbox.id}
  <Mailbox bind:mailbox bind:messages />
{/key}
