<script lang="ts" context="module">
  export type DrawerContext = {
    scrollTop: Writable<number>
  };
</script>

<script lang="ts">
  const { mailboxes, reloadMailboxes, drawerOpen: { wide, narrow } } = getContext("dash") as DashContext;

  const scrollTop = writable(0);
  setContext("drawer", { scrollTop })

  // Logo in the drawer header is a home button too: go to the inbox and close
  // the drawer (mailboxes[0] is the inbox; the bare "/" route redirects there).
  $: inbox = $mailboxes.find(isInbox) ?? $mailboxes[0];
  $: inboxHref = inbox ? `/mailbox/${inbox.id}` : "/";

  const onScroll = (event: Event) => {
    const target = event.target as HTMLElement;
    $scrollTop = target.scrollTop;
  }

  import DrawerMailbox from './DrawerMailbox.svelte';
  import Brand from "$lib/Brand/Brand.svelte";
  import { clickable } from "$lib/actions";
  import ComposeIcon from "~icons/mdi/email-edit-outline";
  import Ripple from "$lib/Ripple.svelte";

  const compose = action(async () => {
    // A new message has to be written into Drafts, so an account without that folder
    // needs to hear which folder is missing rather than a property-access error.
    const drafts = $mailboxes.find(isDrafts);
    if(!drafts) throw new Error($locale.Folder_not_available);
    await _blank(drafts);
  })

  import { circInOut } from "svelte/easing";

  const custom = (node: HTMLElement, { duration = 400 }) => {
    const width = node.clientWidth;
    return () => {
      return {
        duration,
        easing: circInOut,
        css: (t: number, u: number) => `margin-inline-start: -${u * width}px`,
      }      
    }
  }

  import Menu from "~icons/mdi/menu"; 

  import { action, isDrafts, isInbox, isNarrow, _post } from "$lib/util";
  import type { DashContext } from "./Dashboard.svelte";
  import { getContext, setContext } from "svelte";
  import Plus from "~icons/mdi/plus";
  import Dialog from "$lib/Dialog.svelte";
  import Formy from "$lib/Formy/Formy.svelte";
  import TextField from "$lib/TextField.svelte";
  import { writable } from "svelte/store";
  import type { Writable } from "svelte/store";
  import { _blank } from '$lib/Compose/compose';
  import { _message } from '$lib/Notify/notify';
  import { locale } from '$lib/locale';

  let createOpen = false;
  let createName = "";
  const openCreate = () => createOpen = true;

  const createFolder = action(async () => {
    await _post("/api/mailboxes", { path: createName })
    createOpen = false;
    _message($locale.notifier.New_folder_created);
    await reloadMailboxes();
  })
</script>

<style>
  .overlay {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--overlay-bg);
    z-index: var(--z-drawer);
    transition: opacity var(--duration) ease;
  }

  .overlay:not(.open) {
    opacity: 0;
    pointer-events: none;
  }

  .drawer {
    --drawer-w: 15rem;
    box-sizing: border-box;
    width: var(--drawer-w);
    flex: none;
    border-right: var(--border) 1px solid;
    align-self: stretch;
    min-height: 0;
    display: flex;
    flex-direction: column;
    transition: margin var(--duration) ease;
  }

  @media (max-width: 800px) {
    .drawer {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: calc(var(--z-drawer) + 1);
    }

    .drawer:not(.narrow-open) {
      margin-inline-start: calc(-1 * var(--drawer-w));
    }
  }

  @media not all and (max-width: 800px) {
    .drawer:not(.wide-open) {
      margin-inline-start: calc(-1 * var(--drawer-w));
    }
  }

  .top {
    display: flex;
    flex-direction: row;
    align-items: center;
    box-sizing: border-box;
    color: var(--text);
    height: var(--top-h);
    margin-bottom: calc(-1 * var(--space-3));
  }

  .menu {
    display: flex;
    flex: none;
    height: var(--top-h);
    width: var(--top-h);
    font-size: 1.75rem;
    align-items: center;
    justify-content: center;
  }

  .logo {
    font-weight: 500;
    font-size: 1.25rem;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }

  .drawer {
    background: var(--surface);
  }

  .compose-wrap {
    z-index: 10;
    position: relative;
    padding: var(--space-4);
    transition: box-shadow 200ms ease;
  }

  .compose-wrap.scrolled {
    box-shadow: rgba(0,0,0,0.25) 0 2px 4px 0; 
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .compose {
    display: flex;
    align-items: center;
    border: var(--border) 1px solid;
    border-radius: 100px;
    padding: var(--space-3) var(--space-5) var(--space-3) var(--space-3);
    font-size: 1rem;
    box-shadow: 0 1px 2px 0 rgb(60 64 67 / 30%), 0 1px 3px 1px rgb(60 64 67 / 15%);
    transition: box-shadow 400ms ease;
    user-select: none;
    cursor: pointer;
    --ripple-color: rgba(0,0,0,0.2);
    background: var(--surface-2);
  }

  .compose:hover {
    box-shadow: 0 1px 3px 0 rgb(60 64 67 / 30%), 0 4px 8px 3px rgb(60 64 67 / 15%)
  }

  .compose-icon {
    display: flex;
    font-size: 1.25rem;
    margin-inline-end: var(--space-3);
    margin-inline-start: var(--space-1);
  }

  .sep {
    border-top: var(--border) 1px solid;
  }

  .new {
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: var(--space-4) var(--space-3) var(--space-4) var(--space-2);
  }

  .new-icon {
    font-size: 1.25rem;
    margin-inline-end: var(--space-4);
  }

  .create-form {
    display: flex;
    flex-direction: column;
  }

  .create-name {
    margin-bottom: var(--space-5);
  }

  .create-send {
    align-self: flex-end;
  }
</style>

  <div class="overlay only-narrow" class:open={$narrow}  
    on:click={() => isNarrow() ? narrow.set(false) : wide.set(false)}
  ></div>

<div class="drawer" class:narrow-open={$narrow} class:wide-open={$wide}>
  
  <div class="top only-narrow">
    <div class="menu btn-dark" use:clickable on:click={() => narrow.set(false)}>
      <Menu />
      <Ripple />
    </div>
    <a class="logo na" href={inboxHref} aria-label={$locale.mailboxes.Inbox} on:click={() => narrow.set(false)}>
      <Brand />
    </a>
  </div>

  <div class="compose-wrap" class:scrolled={$scrollTop !== 0}>
    <button class="compose" on:click={() => { narrow.set(false); compose(); }}>
      <div class="compose-icon">
        <ComposeIcon />
      </div>
      {$locale.Compose}
      <Ripple />
    </button>
  </div>

  <div class="scroll thin-scroll" on:scroll={onScroll}>
    <div class="mailboxes">
      {#each $mailboxes as mailbox (mailbox.id)}
        <DrawerMailbox {mailbox} />
      {/each}
    </div>

    <div class="sep"></div>

    <div class="new btn-dark" use:clickable on:click={openCreate}>
      <div class="new-icon">
        <Plus />
      </div>
      {$locale.Create_new_folder}
      <Ripple />
    </div>
  </div>

</div>

{#if createOpen}
  <Dialog title={$locale.Create_new_folder} width="500px" onClose={() => createOpen = false}>
    <Formy action={createFolder} let:submit>
      <form class="create-form" on:submit|preventDefault={submit}>
        <div class="create-name"> 
          <TextField validate required trim label={$locale.Folder_name} bind:value={createName} />
        </div>
        <button type="submit" class="create-send elev2 btn-light btn-primary">
          {$locale.Create}
          <Ripple />
        </button>
      </form>
    </Formy>
  </Dialog>
{/if}
