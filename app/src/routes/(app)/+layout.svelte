<script lang="ts">
  import Dashboard from "$lib/Dashboard/Dashboard.svelte";
  import type { Mailbox, User } from "$lib/types";
	import { onMount } from "svelte";
	import { RAVEN_SIGNATURE_META_KEY, signature } from "$lib/signature";
	import { addresses } from "$lib/addresses";

  export let data: {
    user: User;
    username: string;
    mailboxes: Mailbox[];
    addresses?: string[];
  };

  let user: User = data.user;
  let mailboxes: Mailbox[] = data.mailboxes;
  let lastData = data;

  // Re-sync only on a fresh `data` object (real navigation/load), never on a
  // child bind: write-back — matches the guard used in mailbox/search +page.
  $: if (data !== lastData) {
    lastData = data;
    ({ user, mailboxes } = data);
  }

  // Kept in step with `user`, not read once: a real navigation delivers a fresh data
  // object, and the aliases have to follow it like the rest of the account does.
  $: addresses.set(data.addresses?.length ? data.addresses : [user?.address].filter(Boolean) as string[]);

  onMount(() => {
    signature.set(user?.metaData?.[RAVEN_SIGNATURE_META_KEY] || "");
  })
</script>

<Dashboard bind:user bind:mailboxes>
  <slot />
</Dashboard>
