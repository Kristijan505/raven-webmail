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

  let user: User;
  let username: string;
  let mailboxes: Mailbox[];

  $: ({ user, username, mailboxes } = data);

  onMount(() => {
    signature.set(user?.metaData?.[RAVEN_SIGNATURE_META_KEY] || "");
  })
</script>

<Dashboard bind:username bind:user bind:mailboxes>
  <slot />
</Dashboard>
