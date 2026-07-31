<script lang="ts">
  import type { Mailbox as MBox, Messages } from "$lib/types";
  export let data: { view: "inbox" | "sent"; messages: Messages };

  import Mailbox from "$lib/Mailbox/Mailbox.svelte";
  import { locale } from "$lib/locale";
  import { UNIFIED_IDS, unifiedListBase } from "$lib/unified";

  // Same guard as the mailbox page: re-sync only on a real navigation, never on a
  // child-driven mutation (see the comment there).
  let messages: Messages = data.messages;
  let lastData = data;
  $: if (data !== lastData) {
    lastData = data;
    messages = data.messages;
  }

  $: name = data.view === "inbox" ? $locale.All_inboxes : $locale.All_sent;

  // A synthetic mailbox: enough shape for <Mailbox>/<Top> to render, an id no real
  // mailbox can have (isUnifiedMailbox keys off THAT, not the path — paths are
  // user-controlled), and a total mirroring the list so the toolbar count is honest.
  $: mailbox = ({
    id: UNIFIED_IDS[data.view],
    name,
    path: `__unified/${data.view}`,
    specialUse: null,
    subscribed: true,
    hidden: false,
    total: messages.total,
    unseen: 0,
  }) as MBox;
</script>

<svelte:head>
  <title>{name}</title>
</svelte:head>

{#key data.view}
  <Mailbox {mailbox} bind:messages listBase={unifiedListBase(data.view)} />
{/key}
