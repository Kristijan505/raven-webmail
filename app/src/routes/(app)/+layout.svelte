<script lang="ts">
  import Dashboard from "$lib/Dashboard/Dashboard.svelte";
  import type { Mailbox, User } from "$lib/types";
	import { onMount } from "svelte";
	import { RAVEN_SIGNATURE_META_KEY, signature } from "$lib/signature";

  export let data: {
    user: User;
    username: string;
    mailboxes: Mailbox[];
  };

  let user: User = data.user;
  let username: string = data.username;
  let mailboxes: Mailbox[] = data.mailboxes;
  let lastData = data;

  // Re-sync only on a fresh `data` object (real navigation/load), never on a
  // child bind: write-back — matches the guard used in mailbox/search +page.
  $: if (data !== lastData) {
    lastData = data;
    ({ user, username, mailboxes } = data);
  }

  onMount(() => {
    signature.set(user?.metaData?.[RAVEN_SIGNATURE_META_KEY] || "");
  })
</script>

<Dashboard bind:username bind:user bind:mailboxes>
  <slot />
</Dashboard>
