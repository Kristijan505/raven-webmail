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
  import { locale } from "$lib/locale";
  import Mailbox from "$lib/Mailbox/Mailbox.svelte";
  import { mailboxAccounts, setTabAccount, tabAccount } from "$lib/account";
  import { invalidateAll } from "$app/navigation";

  // A deep link into ANOTHER account's folder — a bookmark, or a link followed from a
  // unified row. The server already resolved the mail correctly (the path mailbox
  // binds the owning account), but the chrome around it still belongs to whoever the
  // tab points at. Re-pin and reload so the sidebar, folder list and compose all
  // belong to the owner. Guarded on the map being populated, which only happens with
  // more than one account signed in.
  $: owner = $mailboxAccounts[mailbox.id];
  $: if (owner && $tabAccount && owner !== $tabAccount) repin(owner);

  // A full reload rebuilds the layout as the owner — but only if the pin survives it.
  // With Web Storage disabled or throwing (a case account.ts supports on purpose) the
  // pin lives in this document alone, the reload throws it away, the layout falls back
  // to the first account, and this very guard fires again: a reload loop on a deep link
  // into somebody else's folder. Invalidating instead re-runs the loads in place, which
  // is exactly what was wanted and keeps the in-memory pin.
  const repin = (id: string) => {
    if (setTabAccount(id)) location.reload();
    else void invalidateAll();
  };
</script>

<svelte:head>
  <title>{mailbox.unseen ? `(${mailbox.unseen}) ` : ""}{mailboxName(mailbox, $locale)}</title>
</svelte:head>

{#key mailbox.id}
  <Mailbox bind:mailbox bind:messages />
{/key}
