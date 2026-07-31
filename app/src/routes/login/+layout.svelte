<script>
  import { watchAuth } from "$lib/util";
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import Brand from "$lib/Brand/Brand.svelte";
  import ThemeSwitcher from "$lib/Dashboard/ThemeSwitcher.svelte";
  import LanguageSwitcher from "$lib/Dashboard/LanguageSwitcher.svelte";
  // Adding an account is NOT a signed-out state, and this layout must not claim it is.
  // watchAuth publishes its argument to every other tab, so merely opening the add form
  // announced a full logout: every other dashboard tab left for /login and dropped the
  // account it was pinned to, while the session stayed perfectly authenticated. A tab
  // on this form has nothing to watch for anyway — it is about to reload either way.
  onMount(() => {
    const isAdd = new URLSearchParams(location.search).get("add") === "1";
    if(!isAdd) return watchAuth(null);
  });
</script>

<style>
  .dash {
    width: 100%;
    min-height: 100%;
    background: var(--bg);
  }

  .top {
    height: var(--top-h);
    background: var(--red);
    color: #fff;
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .logo {
    font-weight: 500;
    font-size: 1.25rem;
    margin: 0 var(--space-6);
  }

  .actions {
    margin-inline-start: auto;
    margin-inline-end: var(--space-3);
    display: flex;
    align-items: center;
  }
</style>

<div class="dash" in:fly|local={{duration: 400, y: -25}}>
  <div class="top">
    <div class="logo">
      <Brand />
    </div>
    <div class="actions">
      <ThemeSwitcher />
      <LanguageSwitcher />
    </div>
  </div>

  <div class="page">
    <slot />
  </div>
</div>
