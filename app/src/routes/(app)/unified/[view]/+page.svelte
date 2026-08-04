<script lang="ts">
  import type { Mailbox as MBox, Messages } from "$lib/types";
  export let data: { view: "inbox" | "sent"; messages: Messages };

  import Mailbox from "$lib/Mailbox/Mailbox.svelte";
  import { locale } from "$lib/locale";
  import { UNIFIED_IDS, unifiedInfo, unifiedListBase } from "$lib/unified";
  import { accounts } from "$lib/account";
  import { goto } from "$app/navigation";

  // A unified view needs at least two accounts to mean anything, and the layout stops
  // sending its live mailbox ids the moment that stops being true — an account signed
  // out in another tab, stubbed after its password changed elsewhere, or simply never
  // there because this URL was opened from a bookmark. Staying would leave a list that
  // looks fine and is deaf: every EXISTS, EXPUNGE and COUNTERS event for the remaining
  // account is matched against an empty id set and dropped, so the rows and the total
  // freeze where they were.
  //
  // TWO conditions, because they catch different things and replacing one with the
  // other left a hole each time. The account count catches a bookmarked one-account
  // load, which starts with unifiedInfo already null and so never "transitions". The
  // missing unifiedInfo catches the case the count cannot see: two perfectly usable
  // accounts whose metadata the layout could not read, where it withholds the entries
  // on purpose. Either way the live id sets are empty and the view is deaf.
  //
  // `length &&` is the layout having spoken — the store starts empty, and an empty list
  // means "not loaded yet", never "no accounts".
  $: usableAccounts = $accounts.filter(a => !a.needsReauth);
  $: if (usableAccounts.length && (usableAccounts.length < 2 || !$unifiedInfo)) void goto("/");

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
