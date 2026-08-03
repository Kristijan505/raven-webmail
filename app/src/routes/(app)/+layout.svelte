<script lang="ts">
  import Dashboard from "$lib/Dashboard/Dashboard.svelte";
  import type { Mailbox, User } from "$lib/types";
	import { RAVEN_SIGNATURE_META_KEY, signature } from "$lib/signature";
	import { addresses } from "$lib/addresses";
	import { accounts as accountsStore, setTabAccount } from "$lib/account";
	import { unifiedInfo, type UnifiedInfo } from "$lib/unified";

  export let data: {
    user: User;
    username: string;
    mailboxes: Mailbox[];
    addresses?: string[];
    accounts?: { id: string; username: string; needsReauth: boolean }[];
    unified?: unknown;
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

  // The server answered as THIS account (it validated ?account=, or picked the
  // fallback); pin the tab to it so every later request is explicit.
  $: accountsStore.set(data.accounts ?? []);
  $: unifiedInfo.set((data.unified as UnifiedInfo) ?? null);
  $: if (data.user?.id) setTabAccount(data.user.id);

  // Reactive, not once at mount: the active account can change UNDER this layout —
  // a stubbed account falls back to another one on the next load without remounting —
  // and a signature left from the evicted account would then be inserted into mail
  // composed as the fallback.
  $: signature.set(user?.metaData?.[RAVEN_SIGNATURE_META_KEY] || "");
</script>

<Dashboard bind:user bind:mailboxes>
  <slot />
</Dashboard>
