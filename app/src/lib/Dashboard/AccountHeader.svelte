<script lang="ts">
  // Shared account header (initials avatar + labelled name/username/email),
  // used on /me and /signature so they match the navbar account menu.
  import type { User } from "$lib/types";
  import Avatar from "./Avatar.svelte";
  import { locale } from "$lib/locale";
  export let user: User;
</script>

<div class="account-header">
  <Avatar {user} variant="brand" size="5rem" />
  <div class="fields">
    {#if user.name}
      <span class="label">{$locale.Name}</span>
      <span class="value">{user.name}</span>
    {/if}
    <span class="label">{$locale.Username}</span>
    <span class="value">{user.username}</span>
    {#if user.address}
      <span class="label">{$locale.Email_address}</span>
      <span class="value">{user.address}</span>
    {/if}
  </div>
</div>

<style>
  .account-header {
    flex: none;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 1.5rem;
    padding: var(--spacing, 1.5rem);
    padding-top: calc(var(--spacing, 1.5rem) * 2);
  }

  .fields {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.45rem 0.85rem;
    align-items: baseline;
    min-width: 0;
  }

  .label {
    color: var(--text-muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .value {
    color: var(--text);
    font-size: 1.05rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
