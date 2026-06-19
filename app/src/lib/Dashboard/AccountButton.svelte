<script lang="ts">
  import { goto } from "$app/navigation";
  import type { User } from "$lib/types";
  export let user: User;
  export let open = false;

  import Avatar from "./Avatar.svelte";
  import Menu from "$lib/Menu/Menu.svelte";
  import MenuItem from "$lib/Menu/MenuItem.svelte";
  import Ripple from "$lib/Ripple.svelte";
  import { action, _post } from "$lib/util";
  import SignOut from "~icons/mdi/logout";
  import Account from "~icons/mdi/account-edit-outline";
  import CopyIcon from "~icons/mdi/content-copy";
  import PortalPopup from "$lib/PortalPopup.svelte";
  import { locale } from "$lib/locale";
  import { clickable } from "$lib/actions";
  import { _message } from "$lib/Notify/notify";

  const signOut = action(async () => {
    open = false;
    await _post("/api/logout", {})
    goto("/login");
  })

  // Quick "copy my email" so the user can hand out their address without
  // opening the profile page. The on:mousedown preventDefault on the row keeps
  // the click from being eaten by the popup's focus handling, so this actually
  // fires (HTTPS gives us the Clipboard API).
  const copyEmail = async () => {
    if (!user.address) return;
    try {
      await navigator.clipboard.writeText(user.address);
      _message($locale.notifier.Email_address_copied);
    } catch (e) {
      console.error("clipboard write failed", e);
    }
  };
</script>

<style>
  .wrap {
    position: relative;
    margin-inline-start: auto;
    margin-inline-end: var(--space-4);
  }

  .anchor {
    position: absolute;
    bottom: 0;
    right: 0;
  }

  .account-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.3rem;
    border-radius: var(--radius-full);
    position: relative;
    overflow: hidden;
    cursor: pointer;
  }

  /* Account card at the top of the menu. */
  .account-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 0.85rem var(--space-4) 0.65rem;
    min-width: 12rem;
  }

  .account-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .account-name,
  .account-username {
    max-width: 14rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .account-name {
    font-weight: 600;
    color: var(--text);
    font-size: 0.95rem;
  }

  .account-username {
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .account-email {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    cursor: pointer;
    position: relative;
    overflow: hidden;
    color: var(--text-muted);
  }

  .account-email-text {
    flex: 1;
    min-width: 0;
    max-width: 14rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.85rem;
  }

  .account-email-icon {
    flex: none;
    display: flex;
    font-size: 1rem;
  }

  .account-sep {
    height: 1px;
    background: var(--border);
    margin: 0.4rem 0;
  }
</style>

<div class="wrap">
  <div class="account-btn btn-light" class:hover={open} use:clickable={$locale.My_account} on:click={() => open = !open}>
    <Avatar {user} variant="light" size="2.1rem" />
    <Ripple />
  </div>

  <div class="anchor">
    <PortalPopup anchor="top-right" bind:open closeOnInsideClick={false}>
      <Menu>
        <div class="account-head">
          <Avatar {user} variant="brand" size="2.75rem" />
          <div class="account-meta">
            {#if user.name}
              <div class="account-name">{user.name}</div>
            {/if}
            <div class="account-username">{user.username}</div>
          </div>
        </div>

        {#if user.address}
          <div class="account-email btn-dark" use:clickable on:mousedown={(e) => { if (e.button === 0) e.preventDefault(); }} on:click={copyEmail}>
            <span class="account-email-text">{user.address}</span>
            <span class="account-email-icon"><CopyIcon /></span>
            <Ripple />
          </div>
        {/if}

        <div class="account-sep"></div>

        <MenuItem icon={Account} href="/me" on:click={() => open = false}>{$locale.My_account}</MenuItem>
        <MenuItem icon={SignOut} on:click={signOut}>{$locale.Sign_out}</MenuItem>
      </Menu>
    </PortalPopup>
  </div>
</div>
