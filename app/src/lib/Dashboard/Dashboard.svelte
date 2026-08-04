<script lang="ts" context="module">
  import type { Writable } from "svelte/store";
  export type DashContext = {
    user: Writable<User>,
    mailboxes: Writable<Mailbox[]>
    drawerOpen: {
      narrow: Writable<boolean>,
      wide: Writable<boolean>,
    },
    toggle: () => void,
    reloadMailboxes: () => Promise<void>,
  };
</script>

<script lang="ts">
  export let user: User;
  let _mailboxes: Mailbox[] = [];
  export { _mailboxes as mailboxes };

  const mailboxes = writable<Mailbox[]>([]);
  $: $mailboxes = sortMailboxes(_mailboxes);
  
  const reloadMailboxes = async () => {
    const json = await _get("/api/mailboxes");
    $mailboxes = sortMailboxes(json.results);
  }

  import type { Mailbox, User } from "$lib/types";
  
  const toggle = () => {
    if(isNarrow()) {
      context.drawerOpen.narrow.update(v => !v);
    } else {
      context.drawerOpen.wide.update(v => !v);
    }
  }

  // Keep the shared user reactive so consumers (e.g. the navbar account menu)
  // reflect a profile edit instead of holding a stale snapshot from mount.
  const userStore = writable(user);
  $: userStore.set(user);

  const context: DashContext = {
    drawerOpen: {
      narrow: writable(false),
      wide: writable(true),
    },
    user: userStore,
    toggle,
    mailboxes,
    reloadMailboxes
  };

  setContext("dash", context);

  import { writable } from "svelte/store";
  import { onMount, setContext } from "svelte";
  import Navigating from "$lib/Navigating.svelte";
  import Drawer from "./Drawer.svelte";
  import Top from "./Top.svelte";
  import { isNarrow, sortMailboxes, watchAuth, _get } from "$lib/util";
  import { accounts as accountList, accountsSignature } from "$lib/account";
  import { applyCounters } from "$lib/unified";
  import { invalidateAll } from "$app/navigation";
  import { goto } from "$app/navigation";
  import { Counters, Exists, Expunge } from "$lib/events";
  import { fly } from "svelte/transition";
  import { destroyComposer } from "$lib/Compose/compose";

  const runAll = (handlers: Array<() => void>) => {
    for (const handler of handlers) {
      handler();
    }
  };

  onMount(() => {
    if (!user?.id) {
      goto("/login");
      return;
    }

    const stream = new EventSource("/api/updates");
    // The server closes this stream when an account of ours is evicted elsewhere, so
    // a drop is the one signal that our account list may have changed under us.
    // Re-read the layout on reconnect and the switcher shows the re-auth stub at
    // once, instead of keeping a dead account on screen until the next navigation.
    // Debounced because EventSource also errors on ordinary network blips.
    // Once per OUTAGE, not once per failed reconnect. EventSource re-errors on every
    // retry while the backend is down, and re-arming the timer each time had every open
    // tab reloading its layout — and fanning out fresh user and mailbox calls — on a
    // loop, against a backend that is already failing. The flag clears when the stream
    // actually speaks again, so the next genuine drop still resyncs.
    let resync: any;
    let resynced = false;
    stream.onerror = () => {
      if(resynced) return;
      resynced = true;
      clearTimeout(resync);
      resync = setTimeout(() => { void invalidateAll().catch(() => {}); }, 1500);
    };
    stream.onopen = () => { resynced = false; };
    stream.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if(data.command === "COUNTERS") {
        Counters.dispatch(data);
      } else if (data.command === "EXISTS") {
        Exists.dispatch(data);
      } else if(data.command === "EXPUNGE") {
        Expunge.dispatch(data);
      }
    }

    const off = [
      Counters.on(data => {
        // Keep the unified badges live too — the event may name ANOTHER account's
        // inbox, which this account's $mailboxes knows nothing about.
        applyCounters(data);
        const mbox = $mailboxes.find(item => item.id === data.mailbox);
        if(mbox) {
          mbox.total = data.total;
          mbox.unseen = data.unseen;
          $mailboxes = $mailboxes;
        }
      }),
      // Broadcast the SET of signed-in accounts, not the active one: switching
      // accounts in another tab must not bounce this one, while login/logout/
      // eviction changes the set and resyncs every tab.
      watchAuth($accountList.length ? accountsSignature($accountList) : (user?.id ?? null)),
      () => { clearTimeout(resync); stream.close(); },
      () => destroyComposer(),
    ]

    return () => {
      runAll(off)
    }
  })
</script>

<style>
  .dashboard {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
  }

  .main {
    display: flex;
    flex-direction: row;
    align-items: stretch;
    flex: 1;
  }

  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
</style>

<div class="dashboard" in:fly={{duration: 400, y: -25}}>
  <Navigating />
  <Top />
  <div class="main">
    <Drawer />
    <div class="page">
      <slot />
    </div>
  </div>
</div>
